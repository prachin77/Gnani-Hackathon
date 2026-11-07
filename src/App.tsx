import { useEffect, useRef, useState } from "react";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { BatchPanel } from "./components/BatchPanel";
import { ErrorBanner } from "./components/ErrorBanner";
import { Header } from "./components/Header";
import { LiveTranscription } from "./components/LiveTranscription";
import { RecordingPanel } from "./components/RecordingPanel";
import { StartActions } from "./components/StartActions";
import type { BatchState } from "./hooks/useBatchProcessing";
import {
  extensionForRecordingMime,
  useAudioStreaming,
} from "./hooks/useAudioStreaming";
import { useBatchDiarization } from "./hooks/useBatchDiarization";
import { useTranscriptAnalysis } from "./hooks/useTranscriptAnalysis";

type DiarizeSource = "upload" | "live" | null;

const DIARIZE_BUSY_STATES: string[] = [
  "uploading",
  "created",
  "starting",
  "polling",
  "downloading",
];

export default function App() {
  const audio = useAudioStreaming();
  const diarize = useBatchDiarization();
  const analysis = useTranscriptAnalysis();
  const runAnalysis = analysis.analyze;

  /** Where the audio currently being diarized came from. */
  const [diarizeSource, setDiarizeSource] = useState<DiarizeSource>(null);
  /** Object URL for the MP3 of the last live session (user verification). */
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  /** Guards the auto-diarization so a live session only triggers it once. */
  const liveDiarizeStartedRef = useRef(false);

  useEffect(() => {
    const recording = audio.lastRecording;
    if (!recording) {
      setRecordingUrl(null);
      return;
    }
    const url = URL.createObjectURL(recording.blob);
    setRecordingUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audio.lastRecording]);

  const liveSource = diarizeSource === "live";
  const batchActive = diarize.state !== "idle";
  const realtimeVisible = audio.state !== "idle" && audio.state !== "error";
  const showStartActions = !batchActive && (audio.state === "idle" || audio.state === "error");

  // When a live session finishes, upload the captured audio to the batch
  // diarization API automatically. The realtime transcript above/below stays.
  useEffect(() => {
    if (audio.state !== "stopped") return;
    if (liveDiarizeStartedRef.current) return;

    const recording = audio.lastRecording;
    if (!recording) return; // Recording may still be finalizing; wait for it.

    liveDiarizeStartedRef.current = true;

    // A silent session has nothing to separate; keep the live transcript only.
    if (audio.sessionSegments === 0) return;

    const extension = extensionForRecordingMime(recording.mimeType);
    const file = new File([recording.blob], `live-session${extension}`, {
      type: recording.mimeType || "audio/mpeg",
    });

    setDiarizeSource("live");
    void diarize.run(file);
  }, [audio.state, audio.lastRecording, audio.sessionSegments, diarize]);

  // Arm the guard again for every new live session.
  useEffect(() => {
    if (audio.state === "idle" || audio.state === "requesting" || audio.state === "ready") {
      liveDiarizeStartedRef.current = false;
    }
  }, [audio.state]);

  // Once the diarized transcript is ready (live or upload), translate + summarise
  // it with Gemini. Exactly one request per transcript.
  useEffect(() => {
    if (diarize.state !== "complete" || diarize.segments.length === 0) return;
    void runAnalysis(diarize.segments, liveSource ? "live" : "upload");
  }, [diarize.state, diarize.segments, liveSource, runAnalysis]);

  const transcriptProcessing = DIARIZE_BUSY_STATES.includes(diarize.state);

  const batchEmpty =
    diarize.state === "complete"
      ? {
          title: "No speech detected",
          description: liveSource
            ? "The recorded session was processed from start to finish, but no utterances were found."
            : "The file was processed from start to finish, but no utterances were found.",
        }
      : diarize.state === "error"
        ? {
            title: liveSource ? "Speaker separation failed" : "No transcript produced",
            description: liveSource
              ? "The recorded session could not be speaker-separated. Your live transcript below is unaffected."
              : "The file could not be transcribed. Try again or choose a different file.",
          }
        : undefined;

  const handleFile = (file: File) => {
    liveDiarizeStartedRef.current = true; // Uploads must never trigger live logic.
    analysis.reset();
    setDiarizeSource("upload");
    void diarize.select(file);
  };

  const closeDiarization = () => {
    diarize.reset();
    analysis.reset();
    setDiarizeSource(null);
  };

  const handleCancelDiarization = () => {
    diarize.cancel();
    analysis.reset();
    setDiarizeSource(null);
  };

  const handleNewSession = () => {
    liveDiarizeStartedRef.current = false;
    if (liveSource) diarize.reset();
    analysis.reset();
    setDiarizeSource(null);
    void audio.prepare();
  };

  const handleDone = () => {
    if (liveSource) diarize.reset();
    analysis.reset();
    setDiarizeSource(null);
    audio.reset();
  };

  const retryAnalysis = () => {
    void runAnalysis(diarize.segments, liveSource ? "live" : "upload", true);
  };

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
            Everything with multiple voices is split by speaker.
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
            <StartActions onRecord={() => void audio.prepare()} onFile={handleFile} />
          )}

          {realtimeVisible && (!batchActive || liveSource) && (
            <RecordingPanel
              state={audio.state}
              elapsedMs={audio.elapsedMs}
              analyser={audio.analyser}
              speechActive={audio.speechActive}
              isProcessing={audio.isProcessing}
              sessionSegments={audio.sessionSegments}
              recordingUrl={recordingUrl}
              recordingFilename={
                audio.lastRecording
                  ? `live-session${extensionForRecordingMime(audio.lastRecording.mimeType)}`
                  : "live-session.mp3"
              }
              recordingError={audio.recordingError}
              onStart={audio.start}
              onStop={() => void audio.stop()}
              onNewSession={handleNewSession}
              onClose={handleDone}
            />
          )}

          {batchActive && (
            <BatchPanel
              source={liveSource ? "live" : "upload"}
              state={diarize.state as BatchState}
              file={
                diarize.fileInfo
                  ? {
                      name: diarize.fileInfo.name,
                      size: diarize.fileInfo.size,
                      type: diarize.fileInfo.type,
                      durationMs: liveSource ? (audio.lastRecording?.durationMs ?? 0) : 0,
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
              onCancel={handleCancelDiarization}
              onRetry={diarize.generate}
              onReset={closeDiarization}
              onGenerate={diarize.generate}
            />
          )}

          {liveSource ? (
            <>
              <LiveTranscription
                title="Live transcript (raw)"
                segments={audio.segments}
                isProcessing={audio.isProcessing}
                state={audio.state}
                onClear={audio.clearTranscript}
                mode="live"
                footerNote="Exactly what streamed live during the recording, without speaker separation."
                downloadFilename="live-transcript.txt"
              />
              <LiveTranscription
                title="Diarized transcript (speakers)"
                segments={diarize.segments}
                isProcessing={transcriptProcessing}
                state="idle"
                onClear={diarize.reset}
                mode="batch"
                emptyTitle={batchEmpty?.title}
                emptyDescription={batchEmpty?.description}
                footerNote="Speaker-separated transcript of the recorded session — the canonical source for translation and summary."
                downloadFilename="diarized-transcript.txt"
              />
              <AnalysisPanel
                state={analysis.state}
                analysis={analysis.analysis}
                error={analysis.error}
                model={analysis.model}
                source="live"
                onRetry={retryAnalysis}
              />
            </>
          ) : batchActive ? (
            <>
              <LiveTranscription
                title="Diarized transcript (speakers)"
                segments={diarize.segments}
                isProcessing={transcriptProcessing}
                state="idle"
                onClear={diarize.reset}
                mode="batch"
                emptyTitle={batchEmpty?.title}
                emptyDescription={batchEmpty?.description}
                footerNote="Speaker-separated transcript of the uploaded file — the canonical source for translation and summary."
                downloadFilename="diarized-transcript.txt"
              />
              <AnalysisPanel
                state={analysis.state}
                analysis={analysis.analysis}
                error={analysis.error}
                model={analysis.model}
                source="upload"
                onRetry={retryAnalysis}
              />
            </>
          ) : (
            <LiveTranscription
              segments={audio.segments}
              isProcessing={audio.isProcessing}
              state={audio.state}
              onClear={audio.clearTranscript}
              mode="live"
            />
          )}
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
