import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  Copy,
  Download,
  Loader2,
  ScrollText,
  Trash2,
} from "lucide-react";
import type { SessionState, TranscriptSegment } from "../hooks/useAudioStreaming";
import { transcriptToText } from "../lib/analysis";
import { downloadText } from "../lib/download";
import { formatTimestamp } from "../lib/format";

interface LiveTranscriptionProps {
  segments: TranscriptSegment[];
  isProcessing: boolean;
  state: SessionState;
  onClear: () => void;
  mode?: "live" | "batch";
  emptyTitle?: string;
  emptyDescription?: string;
  /** Overrides the default panel heading. */
  title?: string;
  /** Overrides the footer note on the left. */
  footerNote?: string;
  /** When set, shows a Download button that saves the transcript as .txt. */
  downloadFilename?: string;
}

function transcriptText(segments: TranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join("\n\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function LiveTranscription({
  segments,
  isProcessing,
  state,
  onClear,
  mode = "live",
  emptyTitle,
  emptyDescription,
  title,
  footerNote,
  downloadFilename,
}: LiveTranscriptionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousCountRef = useRef(segments.length);
  const copiedTimerRef = useRef<number | null>(null);

  const [stickToBottom, setStickToBottom] = useState(true);
  const [hasNewSegments, setHasNewSegments] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const hasSegments = segments.length > 0;
  const hasDiarization = segments.some((s) => s.speakerId !== undefined && s.speakerId !== null);
  const isRecording = state === "recording";
  const isBatch = mode === "batch";

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (segments.length > previousCountRef.current) {
      if (stickToBottom) {
        element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
      } else {
        setHasNewSegments(true);
      }
    }

    previousCountRef.current = segments.length;
  }, [segments, stickToBottom]);

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = window.setTimeout(() => setConfirmingClear(false), 8000);
    return () => window.clearTimeout(timer);
  }, [confirmingClear]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setStickToBottom(atBottom);
    if (atBottom) setHasNewSegments(false);
  };

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setStickToBottom(true);
    setHasNewSegments(false);
  };

  const handleCopy = async () => {
    const copiedOk = await copyText(transcriptText(segments));
    if (!copiedOk) return;

    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  const handleClear = () => {
    onClear();
    setConfirmingClear(false);
    setHasNewSegments(false);
    setStickToBottom(true);
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-200/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <ScrollText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold tracking-tight text-slate-900">
            {title ?? (isBatch ? "Batch Transcription" : "Live Transcription")}
          </h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-500">
            {segments.length} {segments.length === 1 ? "segment" : "segments"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {downloadFilename && (
            <button
              type="button"
              onClick={() => downloadText(downloadFilename, transcriptToText(segments))}
              disabled={!hasSegments}
              aria-label="Download transcript"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Download</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            disabled={!hasSegments}
            aria-label={copied ? "Transcript copied" : "Copy transcript"}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 ${
              copied
                ? "text-emerald-600"
                : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
            }`}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
          </button>

          <button
            type="button"
            onClick={() => setConfirmingClear(true)}
            disabled={!hasSegments}
            aria-label="Clear transcript"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </div>

      {confirmingClear && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-100 bg-rose-50/70 px-4 py-2.5 sm:px-5">
          <p className="text-xs font-medium text-rose-700">
            Clear the entire transcript? This cannot be undone.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClear}
              className="rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setConfirmingClear(false)}
              className="rounded-md bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={isBatch ? "Batch transcription" : "Live transcription"}
          className="transcript-scroll max-h-[420px] min-h-[240px] overflow-y-auto px-4 py-4 sm:px-5"
        >
          {!hasSegments && !isProcessing && (
            <div className="flex min-h-[208px] flex-col items-center justify-center px-4 text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <ScrollText className="h-5 w-5" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-slate-600">
                {emptyTitle ??
                  (isBatch
                    ? "Your file transcript will appear here…"
                    : isRecording
                      ? "Listening for speech…"
                      : "Your transcription will appear here…")}
              </p>
              <p className="mt-1 max-w-xs text-xs leading-5 text-slate-400">
                {emptyDescription ??
                  (isBatch
                    ? "Upload an audio file to transcribe it from beginning to end."
                    : isRecording
                      ? "Speak naturally. Each finished utterance appears here as soon as it is transcribed."
                      : "Start a recording and speak in any supported language.")}
              </p>
            </div>
          )}

          {hasSegments && (
            <div className="space-y-5">
              {segments.map((segment) => (
                <article key={segment.key}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span
                      className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 ring-1 ring-inset ring-indigo-100"
                      title={segment.language?.native}
                    >
                      {segment.language?.name ?? "Detected"}
                    </span>
                    {segment.speakerId !== undefined && segment.speakerId !== null && (
                      <span
                        className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-100"
                      >
                        Speaker {segment.speakerId}
                      </span>
                    )}
                    {segment.segmentIndex !== undefined && (
                      <span className="text-[10px] font-medium tabular-nums text-slate-400">
                        #{segment.segmentIndex}
                      </span>
                    )}
                    {segment.startTime !== undefined && segment.endTime !== undefined ? (
                      <span className="ml-auto text-[10px] tabular-nums text-slate-400">
                        {formatTimestamp(segment.startTime * 1000)} –{" "}
                        {formatTimestamp(segment.endTime * 1000)}
                      </span>
                    ) : (
                      <span className="ml-auto text-[10px] tabular-nums text-slate-400">
                        {formatTimestamp(segment.receivedAt)}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-slate-800">
                    {segment.text}
                  </p>
                </article>
              ))}
            </div>
          )}

          {isProcessing && (
            <div className="mt-4 flex items-center gap-2 text-xs font-medium text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {isBatch ? "Processing the uploaded file…" : "Processing speech…"}
            </div>
          )}
        </div>

        {hasNewSegments && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            New transcript
          </button>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400 sm:px-5">
        <span>
          {footerNote ??
            (hasDiarization
              ? "Speaker-separated transcript (batch diarization)."
              : isBatch
                ? "Every segment from the uploaded file."
                : "Language is detected per utterance.")}
        </span>
        <span>Kept until you clear it.</span>
      </div>
    </section>
  );
}
