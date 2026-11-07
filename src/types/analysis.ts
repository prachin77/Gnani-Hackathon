export interface TranslatedSegment {
  speaker: string;
  startSeconds: number | null;
  endSeconds: number | null;
  original: string;
  english: string;
  notes: string | null;
}

export type MedicationStatus =
  | "prescribed"
  | "alreadyTaking"
  | "advised"
  | "mentioned"
  | "unknown";

export interface PrescriptionItem {
  medication: string;
  activeIngredient: string | null;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  route: string | null;
  purpose: string | null;
  instructions: string | null;
  status: MedicationStatus;
  confidence: "high" | "medium" | "low";
  spokenAs: string | null;
}

export type MedicationIssue =
  | "misheardName"
  | "unknownMedicine"
  | "wrongDose"
  | "duplicateTherapy"
  | "allergyRisk"
  | "unclear";

export interface MedicationFlag {
  spokenAs: string;
  correctedTo: string | null;
  issueType: MedicationIssue;
  severity: "info" | "warning" | "critical";
  explanation: string;
}

export interface SuggestedReport {
  report: string;
  reason: string | null;
  urgency: "routine" | "soon" | "urgent" | "unknown";
}

export interface SpeakerRole {
  speaker: string;
  role: string;
}

export interface ClinicalSummary {
  overview: string;
  chiefComplaints: string[];
  history: string[];
  ePrescription: PrescriptionItem[];
  suggestedReports: SuggestedReport[];
  advice: string[];
  followUp: string[];
  redFlags: string[];
  medicationFlags: MedicationFlag[];
  speakerRoles: SpeakerRole[];
  notes: string[];
}

export interface TranscriptAnalysis {
  detectedLanguages: string[];
  translatedSegments: TranslatedSegment[];
  summary: ClinicalSummary;
}
