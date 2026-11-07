import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const DEFAULT_STT_URL = "wss://api.vachana.ai/stt/v3/stream";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intFromEnv("PORT", 8787),
  host: process.env.HOST ?? "0.0.0.0",
  isProduction: process.env.NODE_ENV === "production",

  /** Static values for the Prisma v3.0 realtime session. */
  stt: {
    url: process.env.GNANI_STT_URL ?? DEFAULT_STT_URL,
    apiKey: (process.env.GNANI_API_KEY ?? "").trim(),
    model: "prisma-v3.0",
    languageCode: "indic-auto",
    sampleRate: 16000,
    format: "transcribe",
    minSilenceMs: 500,
    vadThreshold: 0.6,
    /** Recycle silent sessions after 5 minutes instead of Gnani's 60 s default. */
    idleTimeoutSec: 300,
    /** Force a transcript for very long monologues so results keep flowing. */
    maxSpeechSec: 30,
  },

  /** Gemini is optional: without a key the app still transcribes, it just
   * cannot translate or summarise. */
  gemini: {
    baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
    apiKey: (process.env.GEMINI_API_KEY ?? "").trim(),
    model: (process.env.GEMINI_MODEL ?? "gemini-2.5-flash").trim(),
    /** Free tier is about 1,500 requests/day; we send exactly one per transcript. */
    dailyLimit: intFromEnv("GEMINI_DAILY_LIMIT", 1500),
  },

  limits: {
    /** Concurrent Gnani streams allowed per client IP. */
    sessionsPerIp: intFromEnv("MAX_SESSIONS_PER_IP", 2),
    maxFrameBytes: 1024,
    maxClientBufferedBytes: 1024 * 1024,
    maxUpstreamBufferedBytes: 256 * 1024,
  },
} as const;

export function assertConfig(): void {
  if (config.stt.apiKey) return;

  console.error(
    [
      "",
      "  GNANI_API_KEY is missing.",
      "",
      "  Add it to the .env file in the project root:",
      "    GNANI_API_KEY=your-gnani-api-key",
      "",
      "  The server will not start without it.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
