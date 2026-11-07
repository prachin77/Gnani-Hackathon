import type { ReactNode } from "react";
import {
  AlertTriangle,
  Download,
  FlaskConical,
  Languages,
  Loader2,
  Pill,
  RefreshCw,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import type { AnalysisSource, AnalysisState } from "../hooks/useTranscriptAnalysis";
import { summaryToMarkdown, translationToText } from "../lib/analysis";
import { downloadText } from "../lib/download";
import type {
  ClinicalSummary,
  MedicationFlag,
  PrescriptionItem,
  TranscriptAnalysis,
} from "../types/analysis";

interface AnalysisPanelProps {
  state: AnalysisState;
  analysis: TranscriptAnalysis | null;
  error: string | null;
  model: string | null;
  source: AnalysisSource;
  onRetry: () => void;
}

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const SEVERITY_TONES = {
  info: "border-slate-200 bg-slate-50 text-slate-700",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  critical: "border-rose-200 bg-rose-50 text-rose-900",
} as const;

const ISSUE_LABELS = {
  misheardName: "Likely misheard medicine",
  unknownMedicine: "Unknown medicine",
  wrongDose: "Check the dose",
  duplicateTherapy: "Possible duplicate therapy",
  allergyRisk: "Allergy risk",
  unclear: "Unclear",
} as const;

const STATUS_LABELS = {
  prescribed: "Prescribed",
  alreadyTaking: "Already taking",
  advised: "Advised",
  mentioned: "Mentioned",
  unknown: "Unknown",
} as const;

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">
      {items.map((item, index) => (
        <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
      ))}
    </ul>
  );
}

function PrescriptionTable({ items }: { items: PrescriptionItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
            <th className="py-2 pr-3 font-semibold">Medication</th>
            <th className="py-2 pr-3 font-semibold">Dose</th>
            <th className="py-2 pr-3 font-semibold">Frequency</th>
            <th className="py-2 pr-3 font-semibold">Duration</th>
            <th className="py-2 pr-3 font-semibold">Instructions</th>
            <th className="py-2 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${index}-${item.medication}`} className="border-b border-slate-100 align-top">
              <td className="py-2.5 pr-3">
                <span className="font-medium text-slate-800">{item.medication}</span>
                {item.activeIngredient && (
                  <span className="block text-[11px] text-slate-500">{item.activeIngredient}</span>
                )}
                {item.spokenAs && item.spokenAs.toLowerCase() !== item.medication.toLowerCase() && (
                  <span className="block text-[11px] text-amber-700">
                    heard as “{item.spokenAs}”
                  </span>
                )}
              </td>
              <td className="py-2.5 pr-3 text-slate-700">{item.dose ?? "—"}</td>
              <td className="py-2.5 pr-3 text-slate-700">{item.frequency ?? "—"}</td>
              <td className="py-2.5 pr-3 text-slate-700">{item.duration ?? "—"}</td>
              <td className="py-2.5 pr-3 text-slate-700">
                {item.instructions ?? "—"}
                {item.purpose && (
                  <span className="block text-[11px] text-slate-500">for {item.purpose}</span>
                )}
              </td>
              <td className="py-2.5">
                <span className="text-[11px] font-medium text-slate-600">
                  {STATUS_LABELS[item.status]}
                </span>
                <span className="block text-[10px] uppercase tracking-wide text-slate-400">
                  {item.confidence}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlagCard({ flag }: { flag: MedicationFlag }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs leading-5 ${SEVERITY_TONES[flag.severity]}`}>
      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{ISSUE_LABELS[flag.issueType]}</span>
        <span className="font-normal opacity-70">
          “{flag.spokenAs}”{flag.correctedTo ? ` → ${flag.correctedTo}` : ""}
        </span>
      </div>
      <p className="mt-1 opacity-90">{flag.explanation}</p>
    </div>
  );
}

function SummaryBody({ summary }: { summary: ClinicalSummary }) {
  const hasAnything =
    summary.overview ||
    summary.chiefComplaints.length > 0 ||
    summary.history.length > 0 ||
    summary.ePrescription.length > 0 ||
    summary.suggestedReports.length > 0 ||
    summary.advice.length > 0 ||
    summary.followUp.length > 0 ||
    summary.redFlags.length > 0 ||
    summary.medicationFlags.length > 0;

  if (!hasAnything) {
    return (
      <p className="text-sm text-slate-500">
        The model did not find medical content in this conversation.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {summary.overview && (
        <p className="text-sm leading-6 text-slate-700">{summary.overview}</p>
      )}

      {summary.speakerRoles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {summary.speakerRoles.map((role) => (
            <span
              key={`${role.speaker}-${role.role}`}
              className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
            >
              {role.speaker}: {role.role}
            </span>
          ))}
        </div>
      )}

      {summary.chiefComplaints.length > 0 && (
        <Section title="Chief complaints">
          <Bullets items={summary.chiefComplaints} />
        </Section>
      )}

      {summary.history.length > 0 && (
        <Section title="History">
          <Bullets items={summary.history} />
        </Section>
      )}

      {summary.ePrescription.length > 0 && (
        <Section title="E-prescription">
          <PrescriptionTable items={summary.ePrescription} />
        </Section>
      )}

      {summary.medicationFlags.length > 0 && (
        <Section title="Medication flags">
          <div className="space-y-2">
            {summary.medicationFlags.map((flag, index) => (
              <FlagCard key={`${index}-${flag.spokenAs}`} flag={flag} />
            ))}
          </div>
        </Section>
      )}

      {summary.suggestedReports.length > 0 && (
        <Section title="Suggested reports & investigations">
          <ul className="space-y-1.5 text-sm leading-6 text-slate-700">
            {summary.suggestedReports.map((report, index) => (
              <li
                key={`${index}-${report.report}`}
                className="flex items-start gap-2"
              >
                <FlaskConical className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                <span>
                  <span className="font-medium text-slate-800">{report.report}</span>
                  {report.reason ? ` — ${report.reason}` : ""}
                  {report.urgency !== "unknown" && (
                    <span className="ml-1 text-[11px] uppercase tracking-wide text-slate-400">
                      ({report.urgency})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {summary.advice.length > 0 && (
        <Section title="Advice">
          <Bullets items={summary.advice} />
        </Section>
      )}

      {summary.followUp.length > 0 && (
        <Section title="Follow-up">
          <Bullets items={summary.followUp} />
        </Section>
      )}

      {summary.redFlags.length > 0 && (
        <Section title="Red flags">
          <ul className="space-y-1 text-sm leading-6 text-rose-700">
            {summary.redFlags.map((flag, index) => (
              <li key={`${index}-${flag.slice(0, 24)}`} className="flex items-start gap-2">
                <AlertTriangle className="mt-1 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{flag}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {summary.notes.length > 0 && (
        <Section title="Notes">
          <Bullets items={summary.notes} />
        </Section>
      )}
    </div>
  );
}

export function AnalysisPanel({
  state,
  analysis,
  error,
  model,
  source,
  onRetry,
}: AnalysisPanelProps) {
  if (state === "idle") return null;

  if (state === "running") {
    return (
      <section className="flex items-center gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-4 sm:px-5">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-indigo-600" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-indigo-900">
            Translating and summarising with Gemini…
          </p>
          <p className="mt-0.5 text-xs text-indigo-700/80">
            One request per transcript, so the translation and summary arrive together.
          </p>
        </div>
      </section>
    );
  }

  if (state === "error" || !analysis) {
    return (
      <section className="rounded-2xl border border-rose-200 bg-rose-50/70 px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-rose-900">
              Translation &amp; summary unavailable
            </p>
            <p className="mt-1 text-xs leading-5 text-rose-800">
              {error ?? "Gemini did not return a result."}
            </p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 transition-colors hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Retry
          </button>
        </div>
      </section>
    );
  }

  const languageLabel =
    analysis.detectedLanguages.length > 0 ? analysis.detectedLanguages.join(", ") : "auto-detected";

  return (
    <>
      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-200/40">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Languages className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold tracking-tight text-slate-900">
              English translation
            </h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-500">
              {analysis.translatedSegments.length}{" "}
              {analysis.translatedSegments.length === 1 ? "segment" : "segments"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] text-slate-400 sm:inline">{languageLabel}</span>
            <button
              type="button"
              onClick={() =>
                downloadText(
                  `clinical-translation-${source}.txt`,
                  translationToText(analysis),
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download
            </button>
          </div>
        </div>

        <div className="max-h-[480px] overflow-y-auto px-4 py-4 sm:px-5">
          <div className="space-y-4">
            {analysis.translatedSegments.map((segment, index) => {
              const range =
                segment.startSeconds !== null && segment.endSeconds !== null
                  ? `${clock(segment.startSeconds)} – ${clock(segment.endSeconds)}`
                  : "";
              return (
                <article key={`${index}-${segment.speaker}`}>
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-100">
                      {segment.speaker}
                    </span>
                    {range && (
                      <span className="text-[10px] tabular-nums text-slate-400">{range}</span>
                    )}
                  </div>
                  <p className="text-[15px] leading-7 text-slate-800">{segment.english}</p>
                  {segment.notes && (
                    <p className="mt-1 text-[11px] leading-5 text-amber-700">
                      Correction: {segment.notes}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </div>

        <div className="border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400 sm:px-5">
          Medicine names are corrected from the spoken audio and flagged where uncertain.
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm shadow-slate-200/40">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Stethoscope className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold tracking-tight text-slate-900">
              Clinical summary
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              Gemini
            </span>
          </div>

          <button
            type="button"
            onClick={() =>
              downloadText(
                `clinical-summary-${source}.md`,
                summaryToMarkdown(analysis),
                "text/markdown;charset=utf-8",
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download
          </button>
        </div>

        <div className="px-4 py-4 sm:px-5">
          <SummaryBody summary={analysis.summary} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400 sm:px-5">
          <span>
            AI-generated{model ? ` (${model})` : ""} — verify corrected medicine names and doses
            with a clinician or pharmacist.
          </span>
          <span className="inline-flex items-center gap-1">
            <Pill className="h-3 w-3" aria-hidden="true" />
            Not a medical diagnosis
          </span>
        </div>
      </section>
    </>
  );
}
