import { config } from "./config";
import { logger } from "./logger";

export interface AnalyzeSegmentInput {
  speaker?: string | number | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  text: string;
}

export interface GeminiError extends Error {
  status?: number;
  retryable?: boolean;
}

/**
 * The clinical assistant prompt. This is deliberately long: medication-name
 * corruption is the main failure mode of ASR on Indian prescriptions, so the
 * model is given explicit correction and flagging rules.
 */
const SYSTEM_PROMPT = `You are "Prisma Medical Scribe", a specialist bilingual medical documentation assistant for Indian clinical conversations.

You combine three expert roles:
1. A professional medical translator fluent in Hindi, English, Gujarati, Marathi, Tamil, Telugu, Kannada, Malayalam, Bengali, Punjabi, Odia, Assamese and Indian code-switching (Hinglish, Tanglish, etc.).
2. A clinical pharmacist with deep knowledge of Indian brand names, generics, common fixed-dose combinations and typical dosing.
3. A meticulous medical scribe who writes structured consultation notes.

The user gives you a speaker-diarized transcript of a real consultation. It was produced by automatic speech recognition, so medicine names, numbers and abbreviations may be phonetically corrupted. Your job is translation + structured documentation — NOT diagnosis.

==================== TASKS ====================

A. TRANSLATE EVERY SEGMENT
- Translate each input segment into clear, natural clinical English.
- Keep the same order, speakers and segment boundaries. Never merge, split, drop or reorder segments.
- Preserve numbers, units, dosages and durations exactly as spoken (e.g. "500 mg", "twice a day", "5 days").
- Remove only filler words and false starts; do not add information.
- Keep the speaker label from the input.
- If a phrase is inaudible/unintelligible, write "[unintelligible]" rather than guessing.
- Keep medicine names in Latin script and in Title Case.

B. CORRECT AND NORMALIZE MEDICINE NAMES (critical)
The transcript routinely mangles drug names. Use phonetic similarity + clinical context + knowledge of Indian medications to repair them. Examples of the pattern (not an exhaustive list):
- "AC lock", "aciloc", "asiloc" -> Aciloc (ranitidine)
- "dolocitamol", "dolo citamol", "paracitamol", "paracetmol" -> Paracetamol (Dolo 650, Calpol, Crocin are brand examples)
- "montek lc", "montel lc" -> Montek LC (montelukast + levocetirizine)
- "pan 40", "pan d", "pantop" -> Pan 40 / Pan-D (pantoprazole)
- "zincovit", "zinco vit" -> Zincovit
- "azithral", "azithro", "azythral" -> Azithral (azithromycin)
- "augmentin", "augmantin", "augmenting" -> Augmentin (amoxicillin + clavulanate)
- "telma", "telma 40" -> Telma (telmisartan)
- "glycomet", "glycomef" -> Glycomet (metformin)
- "thyronorm", "thyro norm", "thyrox" -> Thyronorm (levothyroxine)
- "ecosprin", "eco sprin" -> Ecosprin (aspirin)
- "shelcal", "shell cal" -> Shelcal (calcium + vitamin D3)
- "becosules", "b complex" -> Becosules
- "betadine", "betadene" -> Betadine (povidone-iodine)
Rule: only correct when the phonetic and contextual evidence is strong. If two different real drugs are equally plausible, keep the spoken form and add a medication flag.

C. FLAG IMPLAUSIBLE OR WRONG MEDICATION NAMES
If a spoken name looks like a distortion of a different medicine, or does not correspond to any plausible Indian medication, you MUST add an entry to summary.medicationFlags and NOT silently rewrite it.
Example: the transcript says "dolocitamol" — that is not a real drug; the likely intended drug is Paracetamol (Dolo 650). Record spokenAs = "dolocitamol", correctedTo = "Paracetamol", issueType = "misheardName", severity = "warning", and explain the phonetic reasoning.
Also flag, with the appropriate issueType/severity:
- a dose that is implausible or inconsistent with the drug (wrongDose),
- two medicines that are the same molecule/duplicate therapy (duplicateTherapy),
- a drug the patient reports being allergic to (allergyRisk, severity "critical"),
- a name you cannot map at all (unknownMedicine).
Never invent a correction. If unsure, use correctedTo = null and say what was unclear.

D. BUILD THE E-PRESCRIPTION
Extract only what is explicitly stated. For every medicine, fill:
medication (corrected brand/generic), activeIngredient, dose, frequency, duration, route, purpose (only if stated or unmistakably implied by the drug), instructions (before/after food, etc.), status (prescribed | alreadyTaking | advised | mentioned), confidence (high | medium | low), spokenAs (the raw form heard).
Use null for anything not stated. NEVER guess a dose or frequency.

E. SUGGESTED REPORTS / INVESTIGATIONS
Whenever a test, scan, lab report, or investigation is mentioned, requested or discussed (e.g. CBC, HbA1c, lipid profile, thyroid profile, X-ray, ultrasound, MRI, ECG, urine routine, biopsy), add it to summary.suggestedReports with the reason stated in the conversation and an urgency of routine | soon | urgent | unknown. Do not add tests that were not mentioned.

F. STRUCTURED SUMMARY
Write the summary in English with these sections:
- overview: 2-4 sentence clinical picture of the conversation.
- chiefComplaints: the patient's presenting complaints.
- history: relevant history, duration, medications already taken, allergies.
- ePrescription: see task D.
- suggestedReports: see task E.
- advice: lifestyle/diet/activity advice actually given.
- followUp: follow-up timing and instructions actually given.
- redFlags: symptoms or statements that need urgent attention (only if present).
- medicationFlags: see task C.
- speakerRoles: infer doctor / patient / attendant where the context is clear; otherwise "unclear". Never invent identities.
- notes: caveats such as noisy audio, ambiguous words, or missing information.

G. SAFETY AND HONESTY RULES
- Do not diagnose, prescribe, or add clinical advice that is not in the transcript.
- Do not invent patient details (name, age, gender) — leave them out.
- Prefer under-reporting to hallucinating. Mark uncertainty explicitly.
- Never translate a drug name into a literal English word (e.g. never output "AC lock"); always resolve it to a medicine or flag it.
- If the conversation is not medical, still translate it and return a plain-language summary with empty medical sections.

H. OUTPUT
Return ONLY valid JSON matching the provided schema. No markdown, no commentary outside the JSON.
Write all free text in English. Keep ePrescription and suggestedReports as arrays (empty arrays when nothing applies).`;

/** Gemini responds with an OpenAPI-subset schema; keep it flat and explicit. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    detectedLanguages: {
      type: "ARRAY",
      description: "Language codes/names detected in the conversation, e.g. ['hi', 'en'].",
      items: { type: "STRING" },
    },
    translatedSegments: {
      type: "ARRAY",
      description: "One entry per input segment, in the same order.",
      items: {
        type: "OBJECT",
        properties: {
          speaker: { type: "STRING" },
          startSeconds: { type: "NUMBER", nullable: true },
          endSeconds: { type: "NUMBER", nullable: true },
          original: { type: "STRING", description: "Verbatim input text." },
          english: { type: "STRING", description: "Clinical English translation." },
          notes: {
            type: "STRING",
            nullable: true,
            description: "Corrections or ambiguity notes for this segment.",
          },
        },
        required: ["speaker", "original", "english", "startSeconds", "endSeconds", "notes"],
      },
    },
    summary: {
      type: "OBJECT",
      properties: {
        overview: { type: "STRING" },
        chiefComplaints: { type: "ARRAY", items: { type: "STRING" } },
        history: { type: "ARRAY", items: { type: "STRING" } },
        ePrescription: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              medication: { type: "STRING" },
              activeIngredient: { type: "STRING", nullable: true },
              dose: { type: "STRING", nullable: true },
              frequency: { type: "STRING", nullable: true },
              duration: { type: "STRING", nullable: true },
              route: { type: "STRING", nullable: true },
              purpose: { type: "STRING", nullable: true },
              instructions: { type: "STRING", nullable: true },
              status: {
                type: "STRING",
                enum: ["prescribed", "alreadyTaking", "advised", "mentioned", "unknown"],
              },
              confidence: { type: "STRING", enum: ["high", "medium", "low"] },
              spokenAs: { type: "STRING", nullable: true },
            },
            required: [
              "medication",
              "activeIngredient",
              "dose",
              "frequency",
              "duration",
              "route",
              "purpose",
              "instructions",
              "status",
              "confidence",
              "spokenAs",
            ],
          },
        },
        suggestedReports: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              report: { type: "STRING" },
              reason: { type: "STRING", nullable: true },
              urgency: { type: "STRING", enum: ["routine", "soon", "urgent", "unknown"] },
            },
            required: ["report", "reason", "urgency"],
          },
        },
        advice: { type: "ARRAY", items: { type: "STRING" } },
        followUp: { type: "ARRAY", items: { type: "STRING" } },
        redFlags: { type: "ARRAY", items: { type: "STRING" } },
        medicationFlags: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              spokenAs: { type: "STRING" },
              correctedTo: { type: "STRING", nullable: true },
              issueType: {
                type: "STRING",
                enum: [
                  "misheardName",
                  "unknownMedicine",
                  "wrongDose",
                  "duplicateTherapy",
                  "allergyRisk",
                  "unclear",
                ],
              },
              severity: { type: "STRING", enum: ["info", "warning", "critical"] },
              explanation: { type: "STRING" },
            },
            required: ["spokenAs", "correctedTo", "issueType", "severity", "explanation"],
          },
        },
        speakerRoles: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              speaker: { type: "STRING" },
              role: { type: "STRING" },
            },
            required: ["speaker", "role"],
          },
        },
        notes: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: [
        "overview",
        "chiefComplaints",
        "history",
        "ePrescription",
        "suggestedReports",
        "advice",
        "followUp",
        "redFlags",
        "medicationFlags",
        "speakerRoles",
        "notes",
      ],
    },
  },
  required: ["detectedLanguages", "translatedSegments", "summary"],
};

function transcriptForPrompt(segments: AnalyzeSegmentInput[]): string {
  return segments
    .map((segment, index) => {
      const speaker =
        segment.speaker === null || segment.speaker === undefined || segment.speaker === ""
          ? "Unknown"
          : `Speaker ${segment.speaker}`;
      const start = typeof segment.startSeconds === "number" ? ` @${segment.startSeconds}s` : "";
      return `[${index + 1}] ${speaker}${start}: ${segment.text}`;
    })
    .join("\n");
}

function geminiError(message: string, status?: number): GeminiError {
  const error = new Error(message) as GeminiError;
  error.status = status;
  return error;
}

/** Calls Gemini once for one diarized transcript (1 request = 1 unit of quota). */
export async function analyzeMedicalTranscript(
  segments: AnalyzeSegmentInput[],
  source: "upload" | "live",
): Promise<unknown> {
  if (!config.gemini.apiKey) {
    throw geminiError(
      "GEMINI_API_KEY is not configured on the server. Add it to .env and restart.",
      503,
    );
  }

  const userPrompt = [
    `Source: ${source === "live" ? "live microphone session" : "uploaded audio file"}.`,
    `Diarized transcript segments: ${segments.length}.`,
    "",
    "TRANSCRIPT:",
    transcriptForPrompt(segments),
  ].join("\n");

  const url = `${config.gemini.baseUrl}/v1beta/models/${encodeURIComponent(
    config.gemini.model,
  )}:generateContent`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": config.gemini.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 16384,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          // 2.5 Flash thinks by default, which can eat the JSON budget. 2.5 Pro
          // cannot disable thinking (minimum budget is 128), so leave it alone.
          ...(/2\.5/.test(config.gemini.model) && !/pro/i.test(config.gemini.model)
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const message = (error as Error).message;
    throw geminiError(
      message.includes("timeout")
        ? "Gemini did not respond in time. Try again."
        : "Could not reach Gemini. Check internet connectivity and try again.",
    );
  }

  const rawBody = await response.text();

  if (!response.ok) {
    logger.error("Gemini analyze failed", {
      status: response.status,
      model: config.gemini.model,
      body: rawBody.slice(0, 600),
    });

    if (response.status === 429) {
      throw geminiError(
        "Gemini rate limit reached (the free tier allows about 1,500 requests per day). Try again later.",
        429,
      );
    }
    if (response.status === 400 && /API key not valid/i.test(rawBody)) {
      throw geminiError("Gemini rejected the API key. Check GEMINI_API_KEY in .env.", 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw geminiError("Gemini denied access. Check GEMINI_API_KEY and API enablement.", 502);
    }
    if (response.status === 404) {
      throw geminiError(
        `Gemini model "${config.gemini.model}" was not found. Set GEMINI_MODEL in .env.`,
        502,
      );
    }
    throw geminiError(`Gemini request failed (${response.status}).`, 502);
  }

  let body: {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
    promptFeedback?: { blockReason?: string };
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    throw geminiError("Gemini returned an unreadable response.", 502);
  }

  if (body.promptFeedback?.blockReason) {
    throw geminiError(
      `Gemini blocked the request (${body.promptFeedback.blockReason}). Try a different recording.`,
      502,
    );
  }

  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

  if (!text) {
    throw geminiError(
      candidate?.finishReason === "MAX_TOKENS"
        ? "Gemini ran out of output space for this transcript. Try a shorter recording."
        : "Gemini returned an empty response. Try again.",
      502,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Very occasional malformed JSON despite responseMimeType.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        // fall through
      }
    }
    throw geminiError("Gemini returned malformed JSON. Try again.", 502);
  }
}
