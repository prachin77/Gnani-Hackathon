import {
  AlertTriangle,
  Ban,
  Check,
  Clock3,
  FileAudio,
  ListChecks,
  Loader2,
  MicOff,
  RotateCcw,
  Square,
  UploadCloud,
  X,
} from "lucide-react";
import type { BatchFileInfo, BatchState } from "../hooks/useBatchProcessing";
import { formatBytes, formatDuration } from "../lib/format";

interface BatchPanelProps {
  state: BatchState;
  file: BatchFileInfo | null;
  segmentCount: number;
  progress: number;
  preparePercent: number;
  processedMs: number;
  totalMs: number;
  elapsedMs: number;
  error: string | null;
  canRetry: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onReset: () => void;
}

const BUSY_STATES: BatchState[] = ["preparing", "connecting", "processing", "finalizing"];

interface Tone {
  label: string;
  pill: string;
  dot: string;
  bar: string;
  icon: string;
}

function toneFor(state: BatchState): Tone {
  switch (state) {
    case "preparing":
    case "connecting":
    case "finalizing":
      return {
        label: state === "preparing" ? "Preparing" : state === "connecting" ? "Connecting" : "Finalizing",
        pill: "bg-amber-50 text-amber-700 ring-amber-200",
        dot: "bg-amber-500 recording-dot",
        bar: "bg-amber-500",
        icon: "bg-amber-50 text-amber-600 ring-amber-100",
      };
    case "processing":
      return {
        label: "Transcribing",
        pill: "bg-indigo-50 text-indigo-700 ring-indigo-200",
        dot: "bg-indigo-500 recording-dot",
        bar: "bg-indigo-600",
        icon: "bg-indigo-50 text-indigo-600 ring-indigo-100",
      };
    case "complete":
      return {
        label: "Complete",
        pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        dot: "bg-emerald-500",
        bar: "bg-emerald-500",
        icon: "bg-emerald-50 text-emerald-600 ring-emerald-100",
      };
    case "error":
      return {
        label: "Failed",
        pill: "bg-rose-50 text-rose-700 ring-rose-200",
        dot: "bg-rose-500",
        bar: "bg-rose-500",
        icon: "bg-rose-50 text-rose-600 ring-rose-100",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        pill: "bg-slate-100 text-slate-600 ring-slate-200",
        dot: "bg-slate-400",
        bar: "bg-slate-400",
        icon: "bg-slate-100 text-slate-500 ring-slate-200",
      };
    default:
      return {
        label: "Idle",
        pill: "bg-slate-50 text-slate-600 ring-slate-200",
        dot: "bg-slate-400",
        bar: "bg-slate-400",
        icon: "bg-slate-100 text-slate-500 ring-slate-200",
      };
  }
}

function statusCopy(state: BatchState): { title: string; hint: string } {
  switch (state) {
    case "preparing":
      return {
        title: "Preparing your audio",
        hint: "Decoding the file and converting it to 16 kHz mono PCM.",
      };
    case "connecting":
      return {
        title: "Connecting to Prisma v3.0",
        hint: "Opening a secure transcription session through the server proxy.",
      };
    case "processing":
      return {
        title: "Transcribing the whole file",
        hint: "Audio is streamed from beginning to end. Keep this tab open.",
      };
    case "finalizing":
      return {
        title: "Finishing the last segments",
        hint: "Sending a commit and waiting for the final transcript.",
      };
    case "complete":
      return {
        title: "Batch transcription complete",
        hint: "The full file was processed. Results are available below.",
      };
    case "cancelled":
      return {
        title: "Processing cancelled",
        hint: "The file was not fully transcribed. Your partial results are kept.",
      };
    case "error":
      return {
        title: "Batch processing stopped",
        hint: "The file was not fully transcribed. Try again or choose a different file.",
      };
    default:
      return { title: "Batch processing", hint: "" };
  }
}

export function BatchPanel({
  state,
  file,
  segmentCount,
  progress,
  preparePercent,
  processedMs,
  totalMs,
  elapsedMs,
  error,
  canRetry,
  onCancel,
  onRetry,
  onReset,
}: BatchPanelProps) {
  const tone = toneFor(state);
  const copy = statusCopy(state);
  const isBusy = BUSY_STATES.includes(state);
  const isPreparing = state === "preparing";
  const displayedTotal = totalMs || file?.durationMs || 0;
  const percent = Math.min(100, Math.max(0, isPreparing ? preparePercent : progress));
  const capturedNothing = state === "complete" && segmentCount === 0;

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-200/40">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${tone.pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
            {tone.label}
          </span>
          <span className="hidden text-[11px] font-medium text-slate-500 sm:inline">
            Batch upload
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <ListChecks className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            {segmentCount} {segmentCount === 1 ? "segment" : "segments"}
          </span>
          {isBusy ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <Square className="h-3 w-3" fill="currentColor" strokeWidth={0} aria-hidden="true" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onReset}
              aria-label="Close batch panel"
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-5 sm:px-5 sm:py-6">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${tone.icon}`}
          >
            {state === "complete" ? (
              <Check className="h-5 w-5" strokeWidth={2.4} aria-hidden="true" />
            ) : state === "error" ? (
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            ) : state === "cancelled" ? (
              <Ban className="h-5 w-5" aria-hidden="true" />
            ) : isBusy ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <FileAudio className="h-5 w-5" aria-hidden="true" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-slate-900" title={file?.name}>
              {file?.name ?? "Audio file"}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
              {file && <span>{formatBytes(file.size)}</span>}
              {displayedTotal > 0 && (
                <>
                  <span className="text-slate-300" aria-hidden="true">·</span>
                  <span>{formatDuration(displayedTotal)} audio</span>
                </>
              )}
              {file?.sourceChannels ? (
                <>
                  <span className="text-slate-300" aria-hidden="true">·</span>
                  <span>
                    {file.sourceChannels === 1 ? "Mono" : "Stereo"} → 16 kHz mono
                  </span>
                </>
              ) : (
                <>
                  <span className="text-slate-300" aria-hidden="true">·</span>
                  <span>Converted to 16 kHz mono PCM</span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800">{copy.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-slate-500">{copy.hint}</p>
            </div>
            <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-slate-700">
              {Math.round(percent)}%
            </span>
          </div>

          <div
            role="progressbar"
            aria-label="Batch transcription progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${tone.bar}`}
              style={{ width: `${Math.max(percent > 0 ? 2 : 0, percent)}%` }}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="tabular-nums">
              {displayedTotal > 0
                ? `${formatDuration(processedMs)} of ${formatDuration(displayedTotal)} processed`
                : "Reading the file…"}
            </span>
            <span className="inline-flex items-center gap-1.5 tabular-nums">
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              {formatDuration(elapsedMs)} elapsed
            </span>
          </div>
        </div>

        {state === "complete" && segmentCount > 0 && (
          <div className="mt-5 grid grid-cols-3 gap-2 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-3 text-center">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/70">
                Audio
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-emerald-900">
                {formatDuration(displayedTotal)}
              </p>
            </div>
            <div className="border-x border-emerald-100">
              <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/70">
                Segments
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-emerald-900">
                {segmentCount}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/70">
                Processed in
              </p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-emerald-900">
                {formatDuration(elapsedMs)}
              </p>
            </div>
          </div>
        )}

        {capturedNothing && (
          <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
            <MicOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <p className="text-xs leading-5 text-amber-800">
              The file was processed, but no speech was detected. Check that the recording
              contains audible speech and try another file.
            </p>
          </div>
        )}

        {(state === "error" || (state === "processing" && error)) && error && (
          <div
            role={state === "error" ? "alert" : undefined}
            className={`mt-5 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${
              state === "error"
                ? "border-rose-200 bg-rose-50"
                : "border-amber-200 bg-amber-50"
            }`}
          >
            <AlertTriangle
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                state === "error" ? "text-rose-600" : "text-amber-600"
              }`}
              aria-hidden="true"
            />
            <p
              className={`text-xs leading-5 ${
                state === "error" ? "text-rose-800" : "text-amber-800"
              }`}
            >
              {error}
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {state === "complete" && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-indigo-600/20 transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <UploadCloud className="h-4 w-4" aria-hidden="true" />
              Transcribe another file
            </button>
          )}

          {(state === "error" || state === "cancelled") && (
            <>
              {canRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-indigo-600/20 transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Try again
                </button>
              )}
              <button
                type="button"
                onClick={onReset}
                className={`inline-flex items-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
                  canRetry
                    ? "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    : "bg-indigo-600 text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-700"
                }`}
              >
                Choose another file
              </button>
            </>
          )}

          {state === "processing" && (
            <span className="text-[11px] text-slate-400">
              Uploads are sent faster than real time and flow-controlled, so no audio is skipped.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
