import { BatchPanel } from "./components/BatchPanel";
import { ErrorBanner } from "./components/ErrorBanner";
import { Header } from "./components/Header";
import { LiveTranscription } from "./components/LiveTranscription";
import { RecordingPanel } from "./components/RecordingPanel";
import { StartActions } from "./components/StartActions";
import type { BatchState } from "./hooks/useBatchProcessing";
import { useAudioStreaming } from "./hooks/useAudioStreaming";
import { useBatchDiarization } from "./hooks/useBatchDiarization";

export default function App() {
  const audio = useAudioStreaming();
  const diarize = useBatchDiarization();

  const batchActive = diarize.state !== "idle";
  const realtimeVisible = audio.state !== "idle" && audio.state !== "error";
  const showStartActions = !batchActive && (audio.state === "idle" || audio.state === "error");

  const transcriptProcessing = batchActive
    ? diarize.state === "uploading" ||
      diarize.state === "created" ||
      diarize.state === "starting" ||
      diarize.state === "polling" ||
      diarize.state === "downloading"
    : audio.isProcessing;

  const batchEmpty =
    diarize.state === "complete"
      ? {
          title: "No speech detected",
          description:
            "The file was processed from start to finish, but no utterances were found.",
        }
      : diarize.state === "error"
        ? {
            title: "No transcript produced",
            description:
              "The file could not be transcribed. Try again or choose a different file.",
          }
        : undefined;

  return (
    <div className="relative flex min-h-dvh flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-gradient-to-b from-indigo-50/70 via-slate-50/40 to-transparent"
      />

      <Header connection={batchActive ? ("idle" as const) : audio.connection} />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-10 pt-7 sm:px-6 sm:pt-8 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px]">
            Speech to text, live or from a file.
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-500 sm:text-[15px]">
            Speak naturally in Hindi, English, Gujarati, Tamil and other supported
            languages, or upload a recording to transcribe it from beginning to end.
            Uploaded files also get automatic speaker separation.
          </p>
        </div>

        <div className="space-y-4 sm:space-y-5">
          {!batchActive && audio.error && (
            <ErrorBanner
              message={audio.error}
              onDismiss={audio.dismissError}
              onRetry={showStartActions ? () => void audio.prepare() : undefined}
            />
          )}

          {showStartActions && (
            <StartActions
              onRecord={() => void audio.prepare()}
              onFile={(file) => void diarize.select(file)}
            />
          )}

          {!batchActive && realtimeVisible && (
            <RecordingPanel
              state={audio.state}
              elapsedMs={audio.elapsedMs}
              analyser={audio.analyser}
              speechActive={audio.speechActive}
              isProcessing={audio.isProcessing}
              sessionSegments={audio.sessionSegments}
              onStart={audio.start}
              onStop={() => void audio.stop()}
              onNewSession={() => void audio.prepare()}
              onClose={audio.reset}
            />
          )}

          {batchActive && (
            <BatchPanel
              state={diarize.state as BatchState}
              file={
                diarize.fileInfo
                  ? {
                      name: diarize.fileInfo.name,
                      size: diarize.fileInfo.size,
                      type: diarize.fileInfo.type,
                      durationMs: 0,
                      sourceSampleRate: 0,
                      sourceChannels: 0,
                    }
                  : null
              }
              segmentCount={diarize.segments.length}
              progress={diarize.progress}
              preparePercent={0}
              processedMs={0}
              totalMs={0}
              elapsedMs={0}
              error={diarize.error}
              canRetry={diarize.state === "error"}
              onCancel={diarize.cancel}
              onRetry={diarize.generate}
              onReset={diarize.reset}
              onGenerate={diarize.generate}
            />
          )}

          <LiveTranscription
            segments={batchActive ? diarize.segments : audio.segments}
            isProcessing={transcriptProcessing}
            state={batchActive ? "idle" : audio.state}
            onClear={batchActive ? diarize.reset : audio.clearTranscript}
            mode={batchActive ? "batch" : "live"}
            emptyTitle={batchActive ? batchEmpty?.title : undefined}
            emptyDescription={batchActive ? batchEmpty?.description : undefined}
          />
        </div>
      </main>

      <footer className="mx-auto w-full max-w-5xl px-4 pb-8 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center justify-between gap-1 border-t border-slate-200/70 pt-4 text-[11px] text-slate-400 sm:flex-row">
          <p>Powered by Gnani Prisma v3.0 · Automatic language detection</p>
          <p>Live audio is streamed and never stored.</p>
        </div>
      </footer>
    </div>
  );
}
