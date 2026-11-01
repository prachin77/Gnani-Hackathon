import { useCallback, useEffect, useRef, useState } from "react";
import { describeLanguage, type LanguageInfo } from "../lib/languages";
import {
  FRAME_BYTES,
  FRAME_INTERVAL_MS,
  FRAME_SAMPLES,
  LinearResampler,
  PcmFrameEmitter,
  TARGET_SAMPLE_RATE,
  sttWebSocketUrl,
} from "../lib/pcm";
import {
  friendlyMicrophoneError,
  friendlyServerError,
  friendlySocketClose,
  isFatalServerError,
} from "../lib/errors";

export type SessionState =
  | "idle"
  | "requesting"
  | "ready"
  | "connecting"
  | "recording"
  | "stopping"
  | "stopped"
  | "error";

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

export interface TranscriptSegment {
  key: string;
  text: string;
  language: LanguageInfo | null;
  segmentIndex?: number;
  receivedAt: number;
}

interface ServerFrame {
  type?: string;
  message?: string;
  text?: string;
  code?: string;
  request_id?: string;
  segment_id?: string | number;
  segment_index?: number;
  detected_language_code?: string;
}

interface StopWaiter {
  resolve: () => void;
  settleTimer: number | null;
  hardTimer: number | null;
}

const SILENCE_FRAMES_BEFORE_COMMIT = 16; // ~512 ms of trailing silence
const FINAL_TRANSCRIPT_TIMEOUT_MS = 4500;
const FINAL_SETTLE_MS = 600;
const COMMIT_FALLBACK_MS = 1600;
const CONNECT_TIMEOUT_MS = 12000;
const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;

function sendSilence(ws: WebSocket, frameCount: number): Promise<void> {
  return new Promise((resolve) => {
    const silence = new ArrayBuffer(FRAME_BYTES);
    let sent = 0;

    const timer = window.setInterval(() => {
      if (sent >= frameCount || ws.readyState !== WebSocket.OPEN) {
        window.clearInterval(timer);
        resolve();
        return;
      }
      try {
        ws.send(silence);
      } catch {
        window.clearInterval(timer);
        resolve();
        return;
      }
      sent += 1;
    }, FRAME_INTERVAL_MS);
  });
}

export function useAudioStreaming() {
  const [state, setState] = useState<SessionState>("idle");
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [speechActive, setSpeechActive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [sessionSegments, setSessionSegments] = useState(0);

  const stateRef = useRef<SessionState>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const frameEmitterRef = useRef<PcmFrameEmitter | null>(null);

  const recordingRef = useRef(false);
  const connectedRef = useRef(false);
  const closingRef = useRef(false);
  const commitSentRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const connectTimerRef = useRef<number | null>(null);
  const stopWaiterRef = useRef<StopWaiter | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const seenSegmentKeysRef = useRef<Set<string>>(new Set());

  const updatePhase = useCallback((next: SessionState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearConnectTimer = useCallback(() => {
    if (connectTimerRef.current !== null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
  }, []);

  const stopDurationTimer = useCallback((captureElapsed: boolean) => {
    if (durationTimerRef.current !== null) {
      window.clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (captureElapsed && startedAtRef.current !== null) {
      setElapsedMs(Date.now() - startedAtRef.current);
    }
    startedAtRef.current = null;
  }, []);

  const startDurationTimer = useCallback(() => {
    stopDurationTimer(false);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    durationTimerRef.current = window.setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 250);
  }, [stopDurationTimer]);

  const resolveStopWaiter = useCallback(() => {
    const waiter = stopWaiterRef.current;
    if (!waiter) return;
    stopWaiterRef.current = null;
    if (waiter.settleTimer !== null) window.clearTimeout(waiter.settleTimer);
    if (waiter.hardTimer !== null) window.clearTimeout(waiter.hardTimer);
    waiter.resolve();
  }, []);

  const waitForFinalTranscript = useCallback(
    (timeoutMs: number) =>
      new Promise<void>((resolve) => {
        const waiter: StopWaiter = { resolve, settleTimer: null, hardTimer: null };
        waiter.hardTimer = window.setTimeout(() => resolveStopWaiter(), timeoutMs);
        stopWaiterRef.current = waiter;
      }),
    [resolveStopWaiter],
  );

  const scheduleFinalSettle = useCallback(
    (delayMs: number) => {
      const waiter = stopWaiterRef.current;
      if (!waiter) return;
      if (waiter.settleTimer !== null) window.clearTimeout(waiter.settleTimer);
      // Wait for a short quiet gap so back-to-back final segments are not lost.
      waiter.settleTimer = window.setTimeout(() => resolveStopWaiter(), delayMs);
    },
    [resolveStopWaiter],
  );

  const disposeAudio = useCallback(() => {
    recordingRef.current = false;

    try {
      workletRef.current?.port.postMessage({ type: "stop" });
    } catch {
      // port may already be closed
    }
    workletRef.current?.disconnect();
    workletRef.current = null;

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    frameEmitterRef.current = null;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    analyserRef.current?.disconnect();
    analyserRef.current = null;

    sinkRef.current?.disconnect();
    sinkRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }

    setAnalyser(null);
  }, []);

  const finishStop = useCallback(() => {
    stopDurationTimer(true);
    resolveStopWaiter();
    disposeAudio();
    commitSentRef.current = false;

    closingRef.current = true;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, "session complete");
      } catch {
        // ignore
      }
    }

    setConnection("idle");
    setIsProcessing(false);
    setSpeechActive(false);
    updatePhase("stopped");
  }, [disposeAudio, resolveStopWaiter, stopDurationTimer, updatePhase]);

  const fail = useCallback(
    (message: string) => {
      closingRef.current = true;
      clearConnectTimer();
      resolveStopWaiter();
      stopDurationTimer(true);
      disposeAudio();
      commitSentRef.current = false;

      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close(1000, "session failed");
        } catch {
          // ignore
        }
      }

      setConnection("error");
      setError(message);
      setIsProcessing(false);
      setSpeechActive(false);
      updatePhase("error");
    },
    [clearConnectTimer, disposeAudio, resolveStopWaiter, stopDurationTimer, updatePhase],
  );

  const appendTranscript = useCallback((frame: ServerFrame) => {
    const text = (frame.text ?? "").trim();
    if (!text) return;

    const key =
      frame.segment_id !== undefined && frame.segment_id !== null
        ? String(frame.segment_id)
        : `fallback:${requestIdRef.current ?? "session"}:${
            frame.segment_index ?? seenSegmentKeysRef.current.size
          }`;

    if (seenSegmentKeysRef.current.has(key)) return;
    seenSegmentKeysRef.current.add(key);

    const segment: TranscriptSegment = {
      key,
      text,
      language: describeLanguage(frame.detected_language_code),
      segmentIndex: frame.segment_index,
      receivedAt: Date.now(),
    };

    setSegments((previous) => [...previous, segment]);
    setSessionSegments((count) => count + 1);
  }, []);

  const handleFrame = useCallback(
    (frame: ServerFrame) => {
      switch (frame.type) {
        case "connected": {
          clearConnectTimer();
          connectedRef.current = true;
          if (typeof frame.request_id === "string") {
            requestIdRef.current = frame.request_id;
          }
          setConnection("connected");

          if (stateRef.current === "connecting") {
            recordingRef.current = true;
            startDurationTimer();
            setIsProcessing(false);
            setSpeechActive(false);
            updatePhase("recording");
          }
          break;
        }

        case "speech_start": {
          setSpeechActive(true);
          setIsProcessing(false);
          break;
        }

        case "processing": {
          setIsProcessing(true);
          setSpeechActive(false);
          if (stateRef.current === "stopping" && commitSentRef.current) {
            // Processing was acknowledged: give the transcript extra time.
            scheduleFinalSettle(COMMIT_FALLBACK_MS);
          }
          break;
        }

        case "transcript": {
          appendTranscript(frame);
          setIsProcessing(false);
          setSpeechActive(false);

          if (stateRef.current === "stopping" && commitSentRef.current) {
            scheduleFinalSettle(FINAL_SETTLE_MS);
          }
          break;
        }

        case "error": {
          console.warn("[stt] server error:", frame.message ?? "(no message)");
          setIsProcessing(false);
          if (isFatalServerError(frame.message)) {
            fail(friendlyServerError(frame.message));
          } else {
            setError(friendlyServerError(frame.message));
          }
          break;
        }

        case "proxy_error": {
          console.warn("[stt] proxy error:", frame.code ?? "unknown", frame.message ?? "");
          fail(frame.message?.trim() || "The transcription service is unavailable. Please try again.");
          break;
        }

        default:
          break;
      }
    },
    [appendTranscript, clearConnectTimer, fail, scheduleFinalSettle, startDurationTimer, updatePhase],
  );

  const setupAudio = useCallback(
    async (stream: MediaStream, context: AudioContext) => {
      if (context.state === "suspended") {
        await context.resume();
      }

      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;

      const analyserNode = context.createAnalyser();
      analyserNode.fftSize = 1024;
      analyserNode.smoothingTimeConstant = 0.75;
      analyserRef.current = analyserNode;
      source.connect(analyserNode);
      setAnalyser(analyserNode);

      // A muted sink keeps every branch of the graph pulling audio without
      // playing the microphone back through the speakers.
      const sink = context.createGain();
      sink.gain.value = 0;
      sink.connect(context.destination);
      sinkRef.current = sink;
      analyserNode.connect(sink);

      const emitFrame = (buffer: ArrayBuffer) => {
        if (!recordingRef.current) return;
        if (buffer.byteLength !== FRAME_BYTES) return;

        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return;

        try {
          ws.send(buffer);
        } catch {
          // The close handler takes care of session cleanup.
        }
      };

      if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
        try {
          const moduleUrl = `${import.meta.env.BASE_URL}pcm-processor.js`;
          await context.audioWorklet.addModule(moduleUrl);
          const node = new AudioWorkletNode(context, "pcm-frame-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: {
              targetSampleRate: TARGET_SAMPLE_RATE,
              frameSamples: FRAME_SAMPLES,
            },
          });

          node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            if (event.data instanceof ArrayBuffer) emitFrame(event.data);
          };
          node.onprocessorerror = () => {
            console.warn("[audio] AudioWorklet processor error");
            fail("Audio processing stopped unexpectedly. Start a new recording to continue.");
          };

          source.connect(node);
          node.connect(sink);
          workletRef.current = node;
          return;
        } catch (workletError) {
          console.warn("[audio] AudioWorklet unavailable, using fallback", workletError);
        }
      }

      // Fallback for browsers without AudioWorklet support.
      const processor = context.createScriptProcessor(4096, 1, 1);
      const resampler = new LinearResampler(context.sampleRate, TARGET_SAMPLE_RATE);
      const emitter = new PcmFrameEmitter(emitFrame);
      frameEmitterRef.current = emitter;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        resampler.process(input, (sample) => emitter.pushSample(sample));
      };

      source.connect(processor);
      processor.connect(sink);
      scriptProcessorRef.current = processor;
    },
    [fail],
  );

  const prepare = useCallback(async () => {
    const phase = stateRef.current;
    if (
      phase === "requesting" ||
      phase === "ready" ||
      phase === "connecting" ||
      phase === "recording" ||
      phase === "stopping"
    ) {
      return;
    }

    if (!window.isSecureContext) {
      setError("Microphone access requires a secure connection. Open the app over HTTPS or on localhost.");
      updatePhase("error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "This browser does not support microphone capture. Try a recent version of Chrome, Edge, Firefox or Safari.",
      );
      updatePhase("error");
      return;
    }

    setError(null);
    setConnection("idle");
    setElapsedMs(0);
    setSessionSegments(0);
    setSpeechActive(false);
    setIsProcessing(false);
    recordingRef.current = false;
    connectedRef.current = false;
    commitSentRef.current = false;
    closingRef.current = false;
    updatePhase("requesting");

    try {
      // Create and unlock the context inside the click gesture: waiting for the
      // permission prompt can otherwise expire the browser's user activation.
      const AudioContextCtor = window.AudioContext;
      if (!AudioContextCtor) {
        throw new Error("Web Audio is not supported in this browser");
      }
      const context = new AudioContextCtor({ latencyHint: "interactive" });
      audioContextRef.current = context;
      void context.resume().catch(() => undefined);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (stateRef.current !== "requesting") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      mediaStreamRef.current = stream;
      await setupAudio(stream, context);

      if (stateRef.current !== "requesting") {
        disposeAudio();
        return;
      }

      updatePhase("ready");
    } catch (micError) {
      console.warn("[mic] access failed", micError);
      disposeAudio();
      setError(friendlyMicrophoneError(micError));
      updatePhase("error");
    }
  }, [disposeAudio, setupAudio, updatePhase]);

  const start = useCallback(() => {
    if (stateRef.current !== "ready") return;

    closingRef.current = false;
    connectedRef.current = false;
    commitSentRef.current = false;
    requestIdRef.current = null;
    setError(null);
    setConnection("connecting");
    updatePhase("connecting");

    const ws = (() => {
      try {
        return new WebSocket(sttWebSocketUrl());
      } catch (socketError) {
        console.warn("[stt] could not create websocket", socketError);
        return null;
      }
    })();

    if (!ws) {
      fail("Could not open the transcription connection. Check your connection and try again.");
      return;
    }

    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    connectTimerRef.current = window.setTimeout(() => {
      if (connectedRef.current) return;
      fail("Could not connect to the transcription service. Check your connection and try again.");
    }, CONNECT_TIMEOUT_MS);

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      if (typeof event.data !== "string") return;

      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      handleFrame(frame);
    };

    ws.onerror = () => {
      console.warn("[stt] websocket error");
    };

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      recordingRef.current = false;
      clearConnectTimer();

      if (closingRef.current) {
        closingRef.current = false;
        return;
      }

      if (stateRef.current === "stopping") {
        resolveStopWaiter();
        finishStop();
        return;
      }

      if (
        stateRef.current === "stopped" ||
        stateRef.current === "error" ||
        stateRef.current === "idle"
      ) {
        return;
      }

      fail(friendlySocketClose(event.code));
    };
  }, [clearConnectTimer, fail, finishStop, handleFrame, resolveStopWaiter, updatePhase]);

  const stop = useCallback(async () => {
    const phase = stateRef.current;
    if (phase !== "recording" && phase !== "connecting") return;

    updatePhase("stopping");
    setIsProcessing(phase === "recording");
    setSpeechActive(false);
    recordingRef.current = false;
    stopDurationTimer(true);
    disposeAudio();

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || phase !== "recording") {
      finishStop();
      return;
    }

    // Register the waiter before flushing so a segment that VAD closes during
    // the trailing silence still counts as the final transcript.
    const finalTranscript = waitForFinalTranscript(FINAL_TRANSCRIPT_TIMEOUT_MS);

    // Let the tail of the last word reach the VAD, then force the utterance
    // closed with a commit and wait for its transcript before disconnecting.
    await sendSilence(ws, SILENCE_FRAMES_BEFORE_COMMIT);

    if (ws.readyState !== WebSocket.OPEN) {
      resolveStopWaiter();
      finishStop();
      return;
    }

    try {
      ws.send(JSON.stringify({ type: "commit" }));
      commitSentRef.current = true;
      // If the commit had no open utterance, close after a short grace period.
      scheduleFinalSettle(COMMIT_FALLBACK_MS);
    } catch {
      resolveStopWaiter();
      finishStop();
      return;
    }

    await finalTranscript;
    finishStop();
  }, [
    disposeAudio,
    finishStop,
    resolveStopWaiter,
    scheduleFinalSettle,
    stopDurationTimer,
    updatePhase,
    waitForFinalTranscript,
  ]);

  const reset = useCallback(() => {
    const phase = stateRef.current;
    if (phase === "connecting" || phase === "recording" || phase === "stopping") return;

    closingRef.current = false;
    connectedRef.current = false;
    commitSentRef.current = false;
    disposeAudio();
    setError(null);
    setConnection("idle");
    setSpeechActive(false);
    setIsProcessing(false);
    setElapsedMs(0);
    updatePhase("idle");
  }, [disposeAudio, updatePhase]);

  const clearTranscript = useCallback(() => {
    seenSegmentKeysRef.current.clear();
    setSegments([]);
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      closingRef.current = true;
      if (connectTimerRef.current !== null) window.clearTimeout(connectTimerRef.current);
      if (durationTimerRef.current !== null) window.clearInterval(durationTimerRef.current);
      if (stopWaiterRef.current) {
        const waiter = stopWaiterRef.current;
        stopWaiterRef.current = null;
        if (waiter.settleTimer !== null) window.clearTimeout(waiter.settleTimer);
        if (waiter.hardTimer !== null) window.clearTimeout(waiter.hardTimer);
        waiter.resolve();
      }

      disposeAudio();

      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close(1000, "component unmounted");
        } catch {
          // ignore
        }
      }
    };
  }, [disposeAudio]);

  return {
    state,
    connection,
    error,
    segments,
    elapsedMs,
    speechActive,
    isProcessing,
    analyser,
    sessionSegments,
    prepare,
    start,
    stop,
    reset,
    clearTranscript,
    dismissError,
  };
}

export type AudioStreamingController = ReturnType<typeof useAudioStreaming>;
