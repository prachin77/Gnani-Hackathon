import { useCallback, useRef, useState } from "react";
import { normalizeAnalysis } from "../lib/analysis";
import type { TranscriptAnalysis } from "../types/analysis";
import type { TranscriptSegment } from "./useAudioStreaming";

export type AnalysisState = "idle" | "running" | "complete" | "error";

export type AnalysisSource = "live" | "upload";

/**
 * One Gemini request per diarized transcript (the free tier allows ~1,500
 * requests/day). The key stays on the server; the browser calls our proxy.
 */
export function useTranscriptAnalysis() {
  const [state, setState] = useState<AnalysisState>("idle");
  const [analysis, setAnalysis] = useState<TranscriptAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const stateRef = useRef<AnalysisState>("idle");
  const requestIdRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);
  const runningRef = useRef(false);

  const updateState = useCallback((next: AnalysisState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    lastKeyRef.current = null;
    runningRef.current = false;
    updateState("idle");
    setAnalysis(null);
    setError(null);
    setModel(null);
  }, [updateState]);

  const analyze = useCallback(
    async (segments: TranscriptSegment[], source: AnalysisSource, force = false) => {
      const usable = segments.filter((segment) => segment.text.trim().length > 0);
      if (usable.length === 0) return;

      const key = `${source}:${usable.map((segment) => segment.key).join("|")}`;
      if (!force) {
        if (runningRef.current && lastKeyRef.current === key) return;
        if (stateRef.current === "complete" && lastKeyRef.current === key) return;
      }

      lastKeyRef.current = key;
      runningRef.current = true;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      updateState("running");
      setError(null);

      try {
        const response = await fetch("/api/ai/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source,
            segments: usable.map((segment) => ({
              speaker: segment.speakerId ?? null,
              startSeconds: segment.startTime ?? null,
              endSeconds: segment.endTime ?? null,
              text: segment.text,
            })),
          }),
        });

        const body = (await response.json().catch(() => null)) as {
          analysis?: unknown;
          model?: string;
          error?: string;
        } | null;

        if (!response.ok) {
          throw new Error(body?.error || `Gemini analysis failed (${response.status}).`);
        }

        if (requestIdRef.current !== requestId) return;

        setAnalysis(normalizeAnalysis(body?.analysis));
        setModel(body?.model ?? null);
        updateState("complete");
      } catch (failure) {
        if (requestIdRef.current !== requestId) return;
        setError(
          failure instanceof Error && failure.message
            ? failure.message
            : "Gemini analysis failed. Try again.",
        );
        updateState("error");
      } finally {
        if (requestIdRef.current === requestId) runningRef.current = false;
      }
    },
    [updateState],
  );

  return {
    state,
    analysis,
    error,
    model,
    analyze,
    reset,
  };
}
