import { AudioLines } from "lucide-react";
import type { ConnectionState } from "../hooks/useAudioStreaming";

const STATES: Record<
  ConnectionState,
  { label: string; dot: string; pill: string; pulse: boolean }
> = {
  idle: {
    label: "Idle",
    dot: "bg-slate-400",
    pill: "bg-slate-50 text-slate-600 ring-slate-200",
    pulse: false,
  },
  connecting: {
    label: "Connecting",
    dot: "bg-amber-500",
    pill: "bg-amber-50 text-amber-700 ring-amber-200",
    pulse: true,
  },
  connected: {
    label: "Connected",
    dot: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    pulse: true,
  },
  error: {
    label: "Connection error",
    dot: "bg-rose-500",
    pill: "bg-rose-50 text-rose-700 ring-rose-200",
    pulse: false,
  },
};

export function StatusBadge({ connection }: { connection: ConnectionState }) {
  const state = STATES[connection];

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Connection status: ${state.label}`}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${state.pill}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${state.dot} ${state.pulse ? "recording-dot" : ""}`}
      />
      <span className="hidden sm:inline">{state.label}</span>
      <AudioLines className="h-3 w-3 sm:hidden" aria-hidden="true" />
    </span>
  );
}
