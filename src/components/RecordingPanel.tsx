import {
  Check,
  Download,
  ListChecks,
  Loader2,
  Mic,
  MicOff,
  Square,
  X,
} from "lucide-react";
import type { SessionState } from "../hooks/useAudioStreaming";
import { formatDuration } from "../lib/format";
import { AudioVisualizer } from "./AudioVisualizer";

interface RecordingPanelProps {
  state: SessionState;
  elapsedMs: number;
  analyser: AnalyserNode | null;
  speechActive: boolean;
  isProcessing: boolean;
  sessionSegments: number;
  recordingUrl: string | null;
  onStart: () => void;
  onStop: () => void;
  onNewSession: () => void;
  onClose: () => void;
}

const PILL_TONES: Record<string, string> = {
  recording: "bg-rose-50 text-rose-700 ring-rose-200",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending: "bg-amber-50 text-amber-700 ring-amber-200",
};

const DOT_TONES: Record<string, string> = {
  recording: "bg-rose-500 recording-dot",
  ready: "bg-emerald-500",
  pending: "bg-amber-500 recording-dot",
};

export function RecordingPanel({
  state,
  elapsedMs,
  analyser,
  speechActive,
  isProcessing,
  sessionSegments,
  recordingUrl,
  onStart,
  onStop,
  onNewSession,
  onClose,
}: RecordingPanelProps) {
  if (state === "stopped") {
    const capturedNothing = sessionSegments === 0;

    return (
      <section className="rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-200/40">
        <div className="flex flex-col items-center px-5 py-9 text-center sm:py-10">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full ring-1 ring-inset ${
              capturedNothing
                ? "bg-amber-50 text-amber-600 ring-amber-100"
                : "bg-emerald-50 text-emerald-600 ring-emerald-100"
            }`}
          >
            {capturedNothing ? (
              <MicOff className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Check className="h-5 w-5" strokeWidth={2.4} aria-hidden="true" />
            )}
          </div>

          <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900">
            {capturedNothing ? "No speech captured" : "Recording complete"}
          </h2>
          <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">
            {capturedNothing
              ? "We didn't hear any speech. Check your microphone and try again."
              : "Your transcript is ready below and stays here until you clear it."}
          </p>

          <dl className="mt-5 flex items-center gap-8 text-sm">
            <div className="flex flex-col items-center gap-0.5">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Duration
              </dt>
              <dd className="font-mono text-base font-semibold tabular-nums text-slate-800">
                {formatDuration(elapsedMs)}
              </dd>
            </div>
            <div className="h-8 w-px bg-slate-200" aria-hidden="true" />
            <div className="flex flex-col items-center gap-0.5">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                Segments
              </dt>
              <dd className="font-mono text-base font-semibold tabular-nums text-slate-800">
                {sessionSegments}
              </dd>
            </div>
          </dl>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onNewSession}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-indigo-600/20 transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <Mic className="h-4 w-4" aria-hidden="true" />
              Start new recording
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Done
            </button>
          </div>

          {recordingUrl && (
            <a
              href={recordingUrl}
              download="live-session.mp3"
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download recording (MP3)
            </a>
          )}
          {(recordingUrl || sessionSegments > 0) && (
            <p className="mt-2 text-[11px] text-slate-400">
              {recordingUrl
                ? "This exact MP3 is what the batch API receives — play it to check the audio."
                : "Encoding the session audio to MP3 for the batch API…"}
            </p>
          )}
        </div>
      </section>
    );
  }

  const isRecording = state === "recording";
  const isReady = state === "ready";
  const isConnecting = state === "connecting";
  const isRequesting = state === "requesting";
  const isStopping = state === "stopping";
  const isBusy = isRequesting || isConnecting || isStopping;

  const tone = isRecording ? "recording" : isReady ? "ready" : "pending";

  const statusLabel = isRecording
    ? "Recording"
    : isReady
      ? "Microphone ready"
      : isConnecting
        ? "Connecting"
        : isStopping
          ? "Finalizing"
          : "Requesting microphone";

  const hint = isRecording
    ? speechActive
      ? "Hearing you — keep speaking naturally."
      : isProcessing
        ? "Processing the last segment…"
        : "Listening… speak naturally."
    : isConnecting
      ? "Opening a secure realtime transcription session."
      : isStopping
        ? "Finishing the last utterance before disconnecting."
        : isRequesting
          ? "Allow microphone access in the browser prompt."
          : "Click the microphone to start recording.";

  const micLabel = isRecording
    ? "Stop recording"
    : isBusy
      ? "Please wait"
      : "Start recording";

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-200/40">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${PILL_TONES[tone]}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${DOT_TONES[tone]}`} />
            {statusLabel}
          </span>
          {isRecording && speechActive && (
            <span className="hidden text-[11px] font-medium text-slate-500 sm:inline">
              Speech detected
            </span>
          )}
          {isRecording && isProcessing && (
            <span className="hidden items-center gap-1 text-[11px] font-medium text-slate-500 sm:inline-flex">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Processing
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            {sessionSegments} {sessionSegments === 1 ? "segment" : "segments"}
          </span>
          {isReady && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close recording panel"
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center px-4 pb-6 pt-7 sm:pt-8">
        <div className="relative flex h-24 w-24 items-center justify-center">
          {isRecording && (
            <>
              <span className="pulse-ring absolute inset-0 rounded-full bg-rose-500/20" aria-hidden="true" />
              <span
                className="pulse-ring pulse-ring-delayed absolute inset-0 rounded-full bg-rose-500/15"
                aria-hidden="true"
              />
            </>
          )}

          <button
            type="button"
            onClick={isRecording ? onStop : isReady ? onStart : undefined}
            disabled={isBusy || (!isReady && !isRecording)}
            aria-label={micLabel}
            className={`relative z-10 flex h-20 w-20 items-center justify-center rounded-full transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-default ${
              isRecording
                ? "bg-rose-600 text-white shadow-lg shadow-rose-600/30 hover:bg-rose-700 focus-visible:outline-rose-600"
                : isReady
                  ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 hover:shadow-indigo-600/35 focus-visible:outline-indigo-600"
                  : "bg-slate-100 text-slate-400 ring-1 ring-inset ring-slate-200"
            }`}
          >
            {isRecording ? (
              <Square className="h-6 w-6" fill="currentColor" strokeWidth={0} aria-hidden="true" />
            ) : isBusy ? (
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            ) : (
              <Mic className="h-7 w-7" strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>

          {isRecording && (
            <span
              className="absolute right-0 top-0 z-20 h-3.5 w-3.5 rounded-full border-2 border-white bg-rose-500"
              aria-hidden="true"
            />
          )}
        </div>

        <div className="mt-5 flex items-baseline gap-2">
          <span
            className={`font-mono text-3xl font-semibold tabular-nums tracking-tight ${
              isRecording ? "text-slate-900" : "text-slate-300"
            }`}
          >
            {formatDuration(elapsedMs)}
          </span>
        </div>

        <p
          className="mt-1.5 min-h-5 text-sm text-slate-500"
          aria-live="polite"
        >
          {hint}
        </p>

        <div className="mt-6 w-full max-w-xl">
          <AudioVisualizer analyser={analyser} active={isRecording || isReady} />
        </div>

        <div className="mt-5 flex min-h-10 items-center justify-center">
          {isRecording && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-rose-600/20 transition-colors hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} aria-hidden="true" />
              Stop Recording
            </button>
          )}

          {isConnecting && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Cancel
            </button>
          )}

          {isStopping && (
            <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Waiting for the final transcript…
            </span>
          )}

          {isReady && (
            <span className="text-[11px] text-slate-400">
              Auto-detects Hindi, English, Gujarati, Tamil and more
            </span>
          )}

          {isRequesting && (
            <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Waiting for permission…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
