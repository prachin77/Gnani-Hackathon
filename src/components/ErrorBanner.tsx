import { AlertTriangle, X } from "lucide-react";

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onDismiss, onRetry }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Something went wrong</p>
        <p className="mt-0.5 text-[13px] leading-5 text-rose-700">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
          >
            Try again
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="rounded-md p-1 text-rose-400 transition-colors hover:bg-rose-100 hover:text-rose-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
