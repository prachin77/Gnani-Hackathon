import { useCallback, useEffect, useRef, useState } from "react";
import { describeLanguage } from "../lib/languages";
import {
  BatchCancelledError,
  BatchInputError,
  MAX_BATCH_DURATION_MS,
  prepareBatchAudio,
  validateBatchFile,
} from "../lib/batch";
import {
  FRAME_BYTES,
  FRAME_INTERVAL_MS,
  FRAME_SAMPLES,
  TARGET_SAMPLE_RATE,
  sttWebSocketUrl,
} from "../lib/pcm";
import {
  friendlyServerError,
  friendlySocketClose,
  isFatalServerError,
} from "../lib/errors";
import type { ConnectionState, TranscriptSegment } from "./useAudioStreaming";

export type BatchState =
  | "idle"
  | "preparing"
  | "connecting"
  | "processing"
  | "finalizing"
  | "complete"
  | "cancelled"
  | "error";

export interface BatchFileInfo {
  name: string;
  size: number;
  type: string;
  durationMs: number;
  sourceSampleRate: number;
  sourceChannels: number;
}

interface ServerFrame {
  type?: string;
  message?: string;
  text?: string;
  code?: string | number;
  frames?: number;
  segment_id?: string | number;
  segment_index?: number;
  detected_language_code?: string;
}

/** Uploaded audio is sent 4× faster than real time. */
const BATCH_SPEED = 4;
/** Maximum audio frames awaiting server acknowledgement. */
const SEND_WINDOW_FRAMES = 64;
const SILENCE_FRAMES_BEFORE_COMMIT = 16; // ~512 ms of trailing silence
const FINAL_TRANSCRIPT_TIMEOUT_MS = 4500;
const FINAL_SETTLE_MS = 600;
const COMMIT_FALLBACK_MS = 3000;
const CONNECT_TIMEOUT_MS = 12000;
const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;

function batchSocketCloseMessage(code: number): string {
  if (code === 1000) {
    return "The transcription service ended the session before the file finished. Please try again.";
  }
  return friendlySocketClose(code);
}

function sendBatchSilence(
  ws: WebSocket,
  frameCount: number,
  shouldStop: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const silence = new ArrayBuffer(FRAME_BYTES);
    let sent = 0;

    const finish = () => {
      window.clearInterval(timer);
      resolve();
    };

    const timer = window.setInterval(() => {
      if (shouldStop() || sent >= frameCount || ws.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }
      try {
        ws.send(silence);
      } catch {
        finish();
        return;
      }
      sent += 1;
    }, FRAME_INTERVAL_MS);
  });
}

export function useBatchProcessing() {
  const [state, setState] = useState<BatchState>("idle");
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [fileInfo, setFileInfo] = useState<BatchFileInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [preparePercent, setPreparePercent] = useState(0);
  const [processedMs, setProcessedMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segmentCount, setSegmentCount] = useState(0);
  const [retryable, setRetryable] = useState(false);

  const stateRef = useRef<BatchState>("idle");
  const runIdRef = useRef(0);
  const cancelRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const lastFileRef = useRef<File | null>(null);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const elapsedTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const updatePhase = useCallback((next: BatchState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (startedAtRef.current !== null) {
      setElapsedMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
    }
  }, []);

  const startElapsedTimer = useCallback(() => {
    stopElapsedTimer();
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    elapsedTimerRef.current = window.setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 500);
  }, [stopElapsedTimer]);

  const appendTranscript = useCallback(
    (frame: ServerFrame, chunkIndex: number, runId: number) => {
      const text = (frame.text ?? "").trim();
      if (!text) return;

      const identity =
        frame.segment_id !== undefined && frame.segment_id !== null
          ? String(frame.segment_id)
          : `index:${frame.segment_index ?? seenKeysRef.current.size}`;
      const key = `batch:${runId}:${chunkIndex}:${identity}`;

      if (seenKeysRef.current.has(key)) return;
      seenKeysRef.current.add(key);

      const segment: TranscriptSegment = {
        key,
        text,
        language: describeLanguage(frame.detected_language_code),
        segmentIndex: frame.segment_index,
        receivedAt: Date.now(),
      };

      setSegments((previous) => [...previous, segment]);
      setSegmentCount((count) => count + 1);
    },
    [],
  );

  /**
   * Streams one slice of prepared PCM through a dedicated Gnani session. Each
   * slice stays below Gnani's 15-minute realtime session cap, so long files are
   * processed completely rather than failing partway through.
   */
  const runChunk = useCallback(
    (
      pcm: Int16Array,
      startSample: number,
      endSample: number,
      totalSamples: number,
      chunkIndex: number,
      runId: number,
    ) =>
      new Promise<void>((resolve, reject) => {
        const chunkPcm = pcm.subarray(startSample, endSample);
        const totalFrames = Math.ceil(chunkPcm.length / FRAME_SAMPLES);

        let connected = false;
        let settled = false;
        let finishing = false;
        let commitSent = false;
        let framesSent = 0;
        let framesAcked = 0;
        let sendTimer: number | null = null;
        let connectTimer: number | null = null;
        let finalWaiter: {
          resolve: () => void;
          settleTimer: number | null;
          hardTimer: number | null;
        } | null = null;

        const ws = new WebSocket(sttWebSocketUrl("batch"));
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        setConnection("connecting");
        updatePhase("connecting");

        const clearTimers = () => {
          if (sendTimer !== null) {
            window.clearInterval(sendTimer);
            sendTimer = null;
          }
          if (connectTimer !== null) {
            window.clearTimeout(connectTimer);
            connectTimer = null;
          }
          if (finalWaiter) {
            if (finalWaiter.settleTimer !== null) window.clearTimeout(finalWaiter.settleTimer);
            if (finalWaiter.hardTimer !== null) window.clearTimeout(finalWaiter.hardTimer);
            finalWaiter = null;
          }
        };

        const settle = (failure?: Error) => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (wsRef.current === ws) wsRef.current = null;
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1000, failure ? "batch stopped" : "chunk complete");
            }
          } catch {
            // ignore
          }
          if (failure) reject(failure);
          else resolve();
        };

        const resolveFinalWaiter = () => {
          const waiter = finalWaiter;
          if (!waiter) return;
          finalWaiter = null;
          if (waiter.settleTimer !== null) window.clearTimeout(waiter.settleTimer);
          if (waiter.hardTimer !== null) window.clearTimeout(waiter.hardTimer);
          waiter.resolve();
        };

        const scheduleFinalSettle = (delayMs: number) => {
          const waiter = finalWaiter;
          if (!waiter) return;
          if (waiter.settleTimer !== null) window.clearTimeout(waiter.settleTimer);
          waiter.settleTimer = window.setTimeout(resolveFinalWaiter, delayMs);
        };

        const waitForFinalTranscript = () =>
          new Promise<void>((resolveWait) => {
            finalWaiter = {
              resolve: resolveWait,
              settleTimer: null,
              hardTimer: window.setTimeout(resolveFinalWaiter, FINAL_TRANSCRIPT_TIMEOUT_MS),
            };
          });

        const reportProgress = (samplesDone: number) => {
          setProcessedMs((samplesDone / TARGET_SAMPLE_RATE) * 1000);
          if (totalSamples > 0) {
            setProgress(Math.min(100, (samplesDone / totalSamples) * 100));
          }
        };

        const sendFrame = (frameIndex: number) => {
          const offset = frameIndex * FRAME_SAMPLES;
          const frame = new Int16Array(FRAME_SAMPLES);
          frame.set(chunkPcm.subarray(offset, Math.min(offset + FRAME_SAMPLES, chunkPcm.length)));
          ws.send(frame.buffer);
        };

        const finalize = async () => {
          if (settled || finishing) return;
          finishing = true;
          updatePhase("finalizing");

          // Register the waiter before the trailing silence so an utterance
          // closed by the VAD still counts as the final transcript.
          const finalTranscript = waitForFinalTranscript();

          await sendBatchSilence(
            ws,
            SILENCE_FRAMES_BEFORE_COMMIT,
            () => settled || wsRef.current !== ws,
          );

          if (settled) {
            resolveFinalWaiter();
            return;
          }

          if (ws.readyState !== WebSocket.OPEN) {
            resolveFinalWaiter();
            settle(new Error(batchSocketCloseMessage(1000)));
            return;
          }

          try {
            ws.send(JSON.stringify({ type: "commit" }));
            commitSent = true;
            scheduleFinalSettle(COMMIT_FALLBACK_MS);
          } catch {
            resolveFinalWaiter();
          }

          await finalTranscript;
          settle();
        };

        const startSending = () => {
          if (sendTimer !== null) return;
          sendTimer = window.setInterval(() => {
            if (settled || !connected) return;
            if (cancelRef.current || runIdRef.current !== runId) {
              settle(new BatchCancelledError());
              return;
            }

            let sentThisTick = 0;
            while (
              sentThisTick < BATCH_SPEED &&
              framesSent < totalFrames &&
              framesSent - framesAcked < SEND_WINDOW_FRAMES &&
              ws.readyState === WebSocket.OPEN &&
              ws.bufferedAmount <= MAX_SOCKET_BUFFER_BYTES
            ) {
              try {
                sendFrame(framesSent);
              } catch {
                settle(new Error("The upload could not be streamed. Please try again."));
                return;
              }
              framesSent += 1;
              sentThisTick += 1;
            }

            if (sentThisTick > 0) {
              reportProgress(startSample + Math.min(framesSent * FRAME_SAMPLES, chunkPcm.length));
            }

            if (framesSent >= totalFrames) {
              if (sendTimer !== null) {
                window.clearInterval(sendTimer);
                sendTimer = null;
              }
              void finalize();
            }
          }, FRAME_INTERVAL_MS);
        };

        const handleFrame = (frame: ServerFrame) => {
          switch (frame.type) {
            case "connected": {
              if (connectTimer !== null) {
                window.clearTimeout(connectTimer);
                connectTimer = null;
              }
              connected = true;
              setConnection("connected");
              updatePhase("processing");
              startSending();
              break;
            }

            case "speech_start": {
              break;
            }

            case "processing": {
              if (finalWaiter && commitSent) scheduleFinalSettle(COMMIT_FALLBACK_MS);
              break;
            }

            case "transcript": {
              appendTranscript(frame, chunkIndex, runId);
              setError(null);
              if (finalWaiter && commitSent) scheduleFinalSettle(FINAL_SETTLE_MS);
              break;
            }

            case "batch_ack": {
              if (typeof frame.frames === "number" && frame.frames > framesAcked) {
                framesAcked = frame.frames;
              }
              break;
            }

            case "error": {
              const message = friendlyServerError(frame.message);
              if (isFatalServerError(frame.message)) settle(new Error(message));
              else setError(message);
              break;
            }

            case "proxy_error": {
              settle(
                new Error(
                  frame.message?.trim() ||
                    "The transcription service is unavailable. Please try again.",
                ),
              );
              break;
            }

            case "proxy_closed": {
              if (!settled && !commitSent) {
                settle(new Error(batchSocketCloseMessage(frame.code ? Number(frame.code) : 1006)));
              }
              break;
            }

            default:
              break;
          }
        };

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
          console.warn("[batch] websocket error");
        };

        ws.onclose = (event) => {
          if (wsRef.current === ws) wsRef.current = null;
          if (settled) return;

          if (cancelRef.current || runIdRef.current !== runId) {
            settle(new BatchCancelledError());
            return;
          }

          if (commitSent) {
            // The session may close right after the committed transcript.
            resolveFinalWaiter();
            return;
          }

          settle(new Error(batchSocketCloseMessage(event.code)));
        };

        connectTimer = window.setTimeout(() => {
          if (connected || settled) return;
          settle(
            new Error(
              "Could not connect to the transcription service. Check your connection and try again.",
            ),
          );
        }, CONNECT_TIMEOUT_MS);
      }),
    [appendTranscript, updatePhase],
  );

  const fail = useCallback(
    (message: string, canRetry = true, nextConnection: ConnectionState = "error") => {
      stopElapsedTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close(1000, "batch failed");
        } catch {
          // ignore
        }
      }
      setRetryable(canRetry);
      setConnection(nextConnection);
      setError(message);
      updatePhase("error");
    },
    [stopElapsedTimer, updatePhase],
  );

  const start = useCallback(
    async (file: File) => {
      const phase = stateRef.current;
      if (
        phase === "preparing" ||
        phase === "connecting" ||
        phase === "processing" ||
        phase === "finalizing"
      ) {
        return;
      }

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      cancelRef.current = false;
      lastFileRef.current = file;
      seenKeysRef.current.clear();

      setError(null);
      setSegments([]);
      setSegmentCount(0);
      setRetryable(false);
      setProgress(0);
      setPreparePercent(0);
      setProcessedMs(0);
      setTotalMs(0);
      setConnection("idle");
      setFileInfo({
        name: file.name,
        size: file.size,
        type: file.type,
        durationMs: 0,
        sourceSampleRate: 0,
        sourceChannels: 0,
      });
      updatePhase("preparing");
      startElapsedTimer();

      try {
        validateBatchFile(file);

        const prepared = await prepareBatchAudio(file, {
          onProgress: (fraction) => setPreparePercent(fraction * 100),
          isCancelled: () => cancelRef.current || runIdRef.current !== runId,
        });

        if (cancelRef.current || runIdRef.current !== runId) {
          throw new BatchCancelledError();
        }

        setFileInfo((previous) =>
          previous
            ? {
                ...previous,
                durationMs: prepared.durationMs,
                sourceSampleRate: prepared.sourceSampleRate,
                sourceChannels: prepared.sourceChannels,
              }
            : previous,
        );
        setTotalMs(prepared.durationMs);
        setPreparePercent(100);

        const totalSamples = prepared.pcm.length;
        let chunkIndex = 0;

        for (let offset = 0; offset < totalSamples; offset += prepared.chunkSamples) {
          if (cancelRef.current || runIdRef.current !== runId) {
            throw new BatchCancelledError();
          }
          const end = Math.min(offset + prepared.chunkSamples, totalSamples);
          await runChunk(prepared.pcm, offset, end, totalSamples, chunkIndex, runId);
          chunkIndex += 1;
          setProcessedMs((end / TARGET_SAMPLE_RATE) * 1000);
          setProgress(Math.min(100, (end / totalSamples) * 100));

          if (end < totalSamples) {
            // Give the proxy a moment to release the previous session before
            // opening the next one for a long file.
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }

        if (runId !== runIdRef.current) return;

        stopElapsedTimer();
        setRetryable(false);
        setProgress(100);
        setProcessedMs(prepared.durationMs);
        setConnection("idle");
        updatePhase("complete");
      } catch (failure) {
        if (runId !== runIdRef.current) return;

        if (failure instanceof BatchCancelledError || cancelRef.current) {
          stopElapsedTimer();
          setConnection("idle");
          setError(null);
          setRetryable(true);
          updatePhase("cancelled");
          return;
        }

        if (failure instanceof BatchInputError) {
          fail(failure.message, false, "idle");
          return;
        }

        const message =
          failure instanceof Error && failure.message
            ? failure.message
            : "Batch processing failed. Please try again.";
        fail(message);
      }
    },
    [fail, runChunk, startElapsedTimer, stopElapsedTimer, updatePhase],
  );

  const retry = useCallback(() => {
    if (!retryable) return;
    const file = lastFileRef.current;
    if (file) void start(file);
  }, [retryable, start]);

  const cancel = useCallback(() => {
    if (
      stateRef.current !== "preparing" &&
      stateRef.current !== "connecting" &&
      stateRef.current !== "processing" &&
      stateRef.current !== "finalizing"
    ) {
      return;
    }

    cancelRef.current = true;
    runIdRef.current += 1;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, "batch cancelled");
      } catch {
        // ignore
      }
    }

    stopElapsedTimer();
    setConnection("idle");
    setError(null);
    setRetryable(true);
    updatePhase("cancelled");
  }, [stopElapsedTimer, updatePhase]);

  const reset = useCallback(() => {
    const phase = stateRef.current;
    if (phase === "preparing" || phase === "connecting" || phase === "processing" || phase === "finalizing") {
      return;
    }

    runIdRef.current += 1;
    cancelRef.current = false;
    lastFileRef.current = null;
    seenKeysRef.current.clear();

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, "batch reset");
      } catch {
        // ignore
      }
    }

    stopElapsedTimer();
    setSegments([]);
    setSegmentCount(0);
    setFileInfo(null);
    setProgress(0);
    setPreparePercent(0);
    setProcessedMs(0);
    setTotalMs(0);
    setElapsedMs(0);
    setError(null);
    setRetryable(false);
    setConnection("idle");
    updatePhase("idle");
  }, [stopElapsedTimer, updatePhase]);

  const clearTranscript = useCallback(() => {
    seenKeysRef.current.clear();
    setSegments([]);
    setSegmentCount(0);
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      cancelRef.current = true;
      if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current);
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
  }, []);

  return {
    state,
    connection,
    error,
    segments,
    fileInfo,
    progress,
    preparePercent,
    processedMs,
    totalMs,
    elapsedMs,
    segmentCount,
    retryable,
    maxDurationMs: MAX_BATCH_DURATION_MS,
    start,
    retry,
    cancel,
    reset,
    clearTranscript,
    dismissError,
  };
}

export type BatchProcessingController = ReturnType<typeof useBatchProcessing>;
