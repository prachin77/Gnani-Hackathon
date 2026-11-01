import { useRef } from "react";
import { ArrowRight, Mic, ShieldCheck, UploadCloud } from "lucide-react";

interface StartActionsProps {
  onRecord: () => void;
  onFile: (file: File) => void;
  busy?: boolean;
  uploadDisabled?: boolean;
}

const ACCEPT = [
  "audio/*",
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
  ".webm",
  ".mpeg",
  ".mpga",
  ".mp4",
].join(",");

export function StartActions({
  onRecord,
  onFile,
  busy = false,
  uploadDisabled = false,
}: StartActionsProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    if (busy || uploadDisabled) return;
    inputRef.current?.click();
  };

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm shadow-slate-200/40 sm:p-5">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Start a session
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Record from your microphone or upload an audio file.
          </p>
        </div>
        <span className="text-[11px] font-medium text-slate-400">16 kHz · Mono · PCM</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onRecord}
          disabled={busy}
          className="group flex w-full items-center gap-3.5 rounded-xl bg-indigo-600 px-4 py-4 text-left text-white shadow-sm shadow-indigo-600/25 transition-colors hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-wait disabled:opacity-70"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-inset ring-white/20">
            <Mic className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Record Audio</span>
            <span className="mt-0.5 block text-xs text-indigo-100">
              {busy ? "Waiting for microphone…" : "Live transcription from your mic"}
            </span>
          </span>
          <ArrowRight
            className="h-4 w-4 shrink-0 text-white/60 transition-transform group-hover:translate-x-0.5 group-hover:text-white"
            aria-hidden="true"
          />
        </button>

        <button
          type="button"
          onClick={openPicker}
          disabled={busy || uploadDisabled}
          className="group flex w-full items-center gap-3.5 rounded-xl border border-slate-200 bg-white px-4 py-4 text-left shadow-sm shadow-slate-200/30 transition-colors hover:border-indigo-200 hover:bg-indigo-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100">
            <UploadCloud className="h-5 w-5" strokeWidth={1.9} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              Upload Audio
              <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-600">
                File
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Batch transcription from start to finish
            </span>
          </span>
          <ArrowRight
            className="h-4 w-4 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500"
            aria-hidden="true"
          />
        </button>
      </div>

      <p className="mt-3.5 flex items-center gap-1.5 text-[11px] text-slate-400">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Audio streams directly to the private server proxy — the API key never reaches the browser.
      </p>
      <p className="mt-1 text-[11px] text-slate-400">
        Uploads: WAV, MP3, M4A, AAC, OGG, FLAC or WebM · up to 10 MB. Transcripts include language detection and automatic speaker labels.
      </p>
    </section>
  );
}
