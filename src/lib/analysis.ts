import type { TranscriptSegment } from "../hooks/useAudioStreaming";
import type {
  ClinicalSummary,
  MedicationFlag,
  MedicationIssue,
  MedicationStatus,
  PrescriptionItem,
  SpeakerRole,
  SuggestedReport,
  TranscriptAnalysis,
  TranslatedSegment,
} from "../types/analysis";

const MEDICATION_STATUSES: MedicationStatus[] = [
  "prescribed",
  "alreadyTaking",
  "advised",
  "mentioned",
  "unknown",
];
const CONFIDENCES = ["high", "medium", "low"] as const;
const ISSUE_TYPES: MedicationIssue[] = [
  "misheardName",
  "unknownMedicine",
  "wrongDose",
  "duplicateTherapy",
  "allergyRisk",
  "unclear",
];
const SEVERITIES = ["info", "warning", "critical"] as const;
const URGENCIES = ["routine", "soon", "urgent", "unknown"] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asStringOrNull(value: unknown): string | null {
  const text = asString(value);
  return text.length > 0 ? text : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter((item) => item.length > 0);
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeTranslatedSegment(value: unknown, index: number): TranslatedSegment {
  const record = isRecord(value) ? value : {};
  return {
    speaker: asString(record.speaker, `Speaker ${index + 1}`) || `Speaker ${index + 1}`,
    startSeconds: asNumberOrNull(record.startSeconds),
    endSeconds: asNumberOrNull(record.endSeconds),
    original: asString(record.original),
    english: asString(record.english),
    notes: asStringOrNull(record.notes),
  };
}

function normalizePrescriptionItem(value: unknown): PrescriptionItem | null {
  if (!isRecord(value)) return null;
  const medication = asString(value.medication);
  if (!medication) return null;
  return {
    medication,
    activeIngredient: asStringOrNull(value.activeIngredient),
    dose: asStringOrNull(value.dose),
    frequency: asStringOrNull(value.frequency),
    duration: asStringOrNull(value.duration),
    route: asStringOrNull(value.route),
    purpose: asStringOrNull(value.purpose),
    instructions: asStringOrNull(value.instructions),
    status: asEnum(value.status, MEDICATION_STATUSES, "unknown"),
    confidence: asEnum(value.confidence, CONFIDENCES, "low"),
    spokenAs: asStringOrNull(value.spokenAs),
  };
}

function normalizeMedicationFlag(value: unknown): MedicationFlag | null {
  if (!isRecord(value)) return null;
  const spokenAs = asString(value.spokenAs);
  if (!spokenAs) return null;
  return {
    spokenAs,
    correctedTo: asStringOrNull(value.correctedTo),
    issueType: asEnum(value.issueType, ISSUE_TYPES, "unclear"),
    severity: asEnum(value.severity, SEVERITIES, "info"),
    explanation: asString(value.explanation),
  };
}

function normalizeSuggestedReport(value: unknown): SuggestedReport | null {
  if (!isRecord(value)) return null;
  const report = asString(value.report);
  if (!report) return null;
  return {
    report,
    reason: asStringOrNull(value.reason),
    urgency: asEnum(value.urgency, URGENCIES, "unknown"),
  };
}

function normalizeSpeakerRole(value: unknown): SpeakerRole | null {
  if (!isRecord(value)) return null;
  const speaker = asString(value.speaker);
  if (!speaker) return null;
  return { speaker, role: asString(value.role, "unclear") || "unclear" };
}

function normalizeSummary(value: unknown): ClinicalSummary {
  const record = isRecord(value) ? value : {};
  const list = <T>(input: unknown, map: (item: unknown) => T | null): T[] =>
    Array.isArray(input)
      ? input.map(map).filter((item): item is T => item !== null)
      : [];

  return {
    overview: asString(record.overview),
    chiefComplaints: asStringArray(record.chiefComplaints),
    history: asStringArray(record.history),
    ePrescription: list(record.ePrescription, normalizePrescriptionItem),
    suggestedReports: list(record.suggestedReports, normalizeSuggestedReport),
    advice: asStringArray(record.advice),
    followUp: asStringArray(record.followUp),
    redFlags: asStringArray(record.redFlags),
    medicationFlags: list(record.medicationFlags, normalizeMedicationFlag),
    speakerRoles: list(record.speakerRoles, normalizeSpeakerRole),
    notes: asStringArray(record.notes),
  };
}

/** Defensive coercion of the model's JSON so the UI can never crash on it. */
export function normalizeAnalysis(value: unknown): TranscriptAnalysis {
  const record = isRecord(value) ? value : {};
  const translatedSegments = Array.isArray(record.translatedSegments)
    ? record.translatedSegments
        .map((segment, index) => normalizeTranslatedSegment(segment, index))
        .filter((segment) => segment.english.length > 0 || segment.original.length > 0)
    : [];

  return {
    detectedLanguages: asStringArray(record.detectedLanguages),
    translatedSegments,
    summary: normalizeSummary(record.summary),
  };
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function timeRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return "";
  if (start !== null && end !== null) return `${clock(start)}–${clock(end)}`;
  return clock((start ?? end) as number);
}

/** Plain-text download of a Gnani transcript (live or diarized). */
export function transcriptToText(segments: TranscriptSegment[]): string {
  return segments
    .map((segment, index) => {
      const meta: string[] = [`#${index + 1}`];
      if (segment.speakerId !== undefined && segment.speakerId !== null) {
        meta.push(`Speaker ${segment.speakerId}`);
      }
      if (segment.startTime !== undefined && segment.endTime !== undefined) {
        meta.push(timeRange(segment.startTime, segment.endTime));
      }
      return `${meta.join(" · ")}\n${segment.text.trim()}`;
    })
    .join("\n\n");
}

export function translationToText(analysis: TranscriptAnalysis): string {
  const headerLines = ["English translation (AI-generated, verify with a clinician)"];
  if (analysis.detectedLanguages.length > 0) {
    headerLines.push(`Detected languages: ${analysis.detectedLanguages.join(", ")}`);
  }
  headerLines.push("");

  const body = analysis.translatedSegments
    .map((segment, index) => {
      const range = timeRange(segment.startSeconds, segment.endSeconds);
      const meta = [`#${index + 1}`, segment.speaker, range].filter((part) => part.length > 0);
      const lines = [`${meta.join(" · ")}`, segment.english.trim()];
      if (segment.notes) lines.push(`Note: ${segment.notes}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return `${headerLines.join("\n")}\n${body}\n`;
}

const STATUS_LABELS: Record<MedicationStatus, string> = {
  prescribed: "Prescribed",
  alreadyTaking: "Already taking",
  advised: "Advised",
  mentioned: "Mentioned",
  unknown: "Unknown",
};

function medicationRow(item: PrescriptionItem): string {
  const columns = [
    item.medication,
    item.dose ?? "—",
    item.frequency ?? "—",
    item.duration ?? "—",
    item.instructions ?? "—",
    `${STATUS_LABELS[item.status]} (${item.confidence} confidence)`,
  ];
  return `| ${columns.join(" | ")} |`;
}

export function summaryToMarkdown(analysis: TranscriptAnalysis): string {
  const { summary, detectedLanguages } = analysis;
  const out: string[] = [];

  out.push("# Clinical summary");
  out.push("");
  out.push(
    "_AI-generated from a diarized transcript. Corrected medicine names still require pharmacist/clinician verification._",
  );
  if (detectedLanguages.length > 0) {
    out.push("");
    out.push(`**Detected languages:** ${detectedLanguages.join(", ")}`);
  }

  if (summary.overview) {
    out.push("", "## Overview", "", summary.overview);
  }

  if (summary.speakerRoles.length > 0) {
    out.push("", "## Speakers", "");
    for (const role of summary.speakerRoles) {
      out.push(`- **${role.speaker}** — ${role.role}`);
    }
  }

  const bullets = (title: string, items: string[]) => {
    if (items.length === 0) return;
    out.push("", `## ${title}`, "");
    for (const item of items) out.push(`- ${item}`);
  };

  bullets("Chief complaints", summary.chiefComplaints);
  bullets("History", summary.history);

  if (summary.ePrescription.length > 0) {
    out.push("", "## E-prescription", "");
    out.push("| Medication | Dose | Frequency | Duration | Instructions | Status |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (const item of summary.ePrescription) out.push(medicationRow(item));
    const details = summary.ePrescription.filter(
      (item) => item.activeIngredient || item.purpose || item.route || item.spokenAs,
    );
    if (details.length > 0) {
      out.push("");
      for (const item of details) {
        const parts = [
          item.activeIngredient ? `active: ${item.activeIngredient}` : "",
          item.route ? `route: ${item.route}` : "",
          item.purpose ? `purpose: ${item.purpose}` : "",
          item.spokenAs && item.spokenAs.toLowerCase() !== item.medication.toLowerCase()
            ? `heard as: “${item.spokenAs}”`
            : "",
        ].filter((part) => part.length > 0);
        out.push(`- **${item.medication}** — ${parts.join("; ")}`);
      }
    }
  }

  if (summary.suggestedReports.length > 0) {
    out.push("", "## Suggested reports & investigations", "");
    out.push("| Report / test | Reason | Urgency |");
    out.push("| --- | --- | --- |");
    for (const item of summary.suggestedReports) {
      out.push(`| ${item.report} | ${item.reason ?? "—"} | ${item.urgency} |`);
    }
  }

  if (summary.medicationFlags.length > 0) {
    out.push("", "## Medication flags", "");
    for (const flag of summary.medicationFlags) {
      const target = flag.correctedTo ? ` → ${flag.correctedTo}` : "";
      out.push(
        `- **[${flag.severity.toUpperCase()}] “${flag.spokenAs}”${target}** (${flag.issueType}) — ${flag.explanation}`,
      );
    }
  }

  bullets("Advice", summary.advice);
  bullets("Follow-up", summary.followUp);
  bullets("Red flags", summary.redFlags);
  bullets("Notes", summary.notes);

  out.push("");
  return out.join("\n");
}
