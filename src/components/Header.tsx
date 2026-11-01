import { Globe2, Mic, Sparkles } from "lucide-react";
import type { ConnectionState } from "../hooks/useAudioStreaming";
import { StatusBadge } from "./StatusBadge";

export function Header({ connection }: { connection: ConnectionState }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600 shadow-sm shadow-indigo-600/25">
            <Mic className="h-[18px] w-[18px] text-white" strokeWidth={2.2} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-tight tracking-tight text-slate-900">
              Voice-to-Text
            </p>
            <p className="truncate text-[11px] leading-tight text-slate-500 sm:text-xs">
              Real-time multilingual speech recognition
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
            <Sparkles className="h-3 w-3 text-indigo-500" aria-hidden="true" />
            <span className="hidden sm:inline">Prisma&nbsp;</span>v3.0
          </span>
          <span className="hidden items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200 sm:inline-flex">
            <Globe2 className="h-3 w-3 text-slate-400" aria-hidden="true" />
            Auto Detect
          </span>
          <StatusBadge connection={connection} />
        </div>
      </div>
    </header>
  );
}
