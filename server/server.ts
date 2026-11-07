import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import multer from "multer";
import { assertConfig, config } from "./config";
import {
  buildDiarizeJobForm,
  cancelDiarizeJob,
  createDiarizeJob,
  downloadDiarizeTranscript,
  getDiarizeJobFailures,
  getDiarizeJobFiles,
  getDiarizeJobStatus,
  normalizeAudioFilename,
  startDiarizeJob,
} from "./gnaniBatch";
import { attachSttProxy } from "./gnaniWebSocket";
import { analyzeMedicalTranscript, type AnalyzeSegmentInput } from "./gemini";
import { logger } from "./logger";

assertConfig();

const app = express();
app.disable("x-powered-by");

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    model: config.stt.model,
    language: config.stt.languageCode,
    sampleRate: config.stt.sampleRate,
    configured: Boolean(config.stt.apiKey),
  });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Gnani direct-upload limit: 10 MB
});

/**
 * Gnani Batch STT proxy for speaker diarization.
 *
 * POST   /api/stt/batch/diarize        — upload file + create diarization job
 * POST   /api/stt/batch/diarize/:id/start — start the job
 * GET    /api/stt/batch/diarize/:id    — poll job status
 * GET    /api/stt/batch/diarize/:id/files — get completed file transcript URLs
 * GET    /api/stt/batch/diarize/download — download a transcript URL (proxy)
 *
 * The GNANI_API_KEY is attached server-side; the browser never sees it.
 */
app.post("/api/stt/batch/diarize", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No audio file provided." });
    return;
  }

  try {
    const form = buildDiarizeJobForm(
      {
        buffer: file.buffer,
        name: normalizeAudioFilename(file.originalname, new Uint8Array(file.buffer)),
        type: file.mimetype,
      },
      { languageCode: "indic-auto", numSpeakers: 5 },
    );
    const job = await createDiarizeJob(form);
    res.status(201).json(job);
  } catch (error) {
    const err = error as Error & { cause?: Error };
    logger.error("Gnani batch diarize create failed", {
      error: err.message,
      cause: err.cause?.message,
    });
    const isNetwork = err.message === "fetch failed";
    res.status(isNetwork ? 504 : 502).json({
      error: isNetwork
        ? "Could not reach the transcription service. Check internet connectivity and try again."
        : err.message,
    });
  }
});

app.post(
  "/api/stt/batch/diarize/:jobId/start",
  async (req, res) => {
    try {
      const job = await startDiarizeJob(req.params.jobId);
      res.json(job);
    } catch (error) {
      logger.error("Gnani batch diarize start failed", {
        jobId: req.params.jobId,
        error: (error as Error).message,
      });
      res.status(502).json({ error: (error as Error).message });
    }
  },
);

// NOTE: must be registered before the "/:jobId" routes or Express will match
// "download" as a jobId.
app.get("/api/stt/batch/diarize/download", async (req, res) => {
  const url = req.query.url;
  if (typeof url !== "string") {
    res.status(400).json({ error: "Missing url query parameter." });
    return;
  }
  try {
    const transcript = await downloadDiarizeTranscript(url);
    res.json(transcript);
  } catch (error) {
    logger.error("Gnani batch diarize download failed", {
      url,
      error: (error as Error).message,
    });
    res.status(502).json({ error: (error as Error).message });
  }
});

app.get("/api/stt/batch/diarize/:jobId", async (req, res) => {
  try {
    const status = await getDiarizeJobStatus(req.params.jobId);
    if (
      status.status === "FAILED" ||
      status.status === "START_FAILED" ||
      status.status === "PARTIAL_FAILURE" ||
      status.status === "CANCELLED"
    ) {
      logger.warn("Gnani batch job reached a failing state", status);
    }
    res.json(status);
  } catch (error) {
    logger.error("Gnani batch diarize status failed", {
      jobId: req.params.jobId,
      error: (error as Error).message,
    });
    res.status(502).json({ error: (error as Error).message });
  }
});

app.get("/api/stt/batch/diarize/:jobId/files", async (req, res) => {
  try {
    const files = await getDiarizeJobFiles(req.params.jobId);
    res.json({ data: files });
  } catch (error) {
    logger.error("Gnani batch diarize files failed", {
      jobId: req.params.jobId,
      error: (error as Error).message,
    });
    res.status(502).json({ error: (error as Error).message });
  }
});

// Per-file failure reasons (FAILED / SKIPPED / CANCELLED).
app.get("/api/stt/batch/diarize/:jobId/failures", async (req, res) => {
  try {
    const files = await getDiarizeJobFailures(req.params.jobId);
    if (files.length > 0) {
      logger.warn("Gnani batch job files failed", {
        jobId: req.params.jobId,
        files: files.map((file) => ({
          status: file.status,
          error_code: file.error_code ?? null,
          error_message: file.error_message ?? null,
        })),
      });
    }
    res.json({ data: files });
  } catch (error) {
    logger.error("Gnani batch diarize failures failed", {
      jobId: req.params.jobId,
      error: (error as Error).message,
    });
    res.status(502).json({ error: (error as Error).message });
  }
});

app.post("/api/stt/batch/diarize/:jobId/cancel", async (req, res) => {
  try {
    const job = await cancelDiarizeJob(req.params.jobId);
    res.json(job);
  } catch (error) {
    logger.error("Gnani batch diarize cancel failed", {
      jobId: req.params.jobId,
      error: (error as Error).message,
    });
    res.status(502).json({ error: (error as Error).message });
  }
});

// Gemini clinical translation + summary. JSON only, one request per transcript.
app.use("/api/ai", express.json({ limit: "1mb" }));

app.post("/api/ai/analyze", async (req, res) => {
  const body = (req.body ?? {}) as { segments?: unknown; source?: unknown };
  const source = body.source === "live" ? "live" : "upload";

  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    res.status(400).json({ error: "No transcript segments provided." });
    return;
  }

  const segments: AnalyzeSegmentInput[] = [];
  for (const entry of body.segments.slice(0, 2000)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (!text) continue;

    const toNumber = (input: unknown): number | null =>
      typeof input === "number" && Number.isFinite(input) ? input : null;

    segments.push({
      speaker:
        typeof value.speaker === "string" || typeof value.speaker === "number"
          ? value.speaker
          : null,
      startSeconds: toNumber(value.startSeconds),
      endSeconds: toNumber(value.endSeconds),
      text: text.slice(0, 4000),
    });
  }

  if (segments.length === 0) {
    res.status(400).json({ error: "No usable transcript segments provided." });
    return;
  }

  const startedAt = Date.now();
  try {
    const analysis = await analyzeMedicalTranscript(segments, source);
    logger.info("Gemini analysis completed", {
      source,
      segments: segments.length,
      durationMs: Date.now() - startedAt,
    });
    res.json({ analysis, model: config.gemini.model });
  } catch (error) {
    const err = error as Error & { status?: number };
    logger.error("Gemini analysis failed", {
      source,
      segments: segments.length,
      error: err.message,
    });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    res.status(status).json({ error: err.message });
  }
});

const distDir = path.resolve(process.cwd(), "dist");
const indexFile = path.join(distDir, "index.html");

if (existsSync(indexFile)) {
  app.use(
    "/assets",
    express.static(path.join(distDir, "assets"), {
      immutable: true,
      maxAge: "1y",
      fallthrough: true,
    }),
  );
  app.use(express.static(distDir, { index: false }));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(indexFile);
  });
} else {
  app.get("/", (_req, res) => {
    res.status(200).type("text/plain").send(
      [
        "Voice-to-Text API is running.",
        "",
        "The frontend has not been built yet. Either:",
        "  • run `npm run dev` (frontend on http://localhost:5173), or",
        "  • run `npm run build` then `npm start` (frontend on http://localhost:8787).",
      ].join("\n"),
    );
  });
}

const server = createServer(app);
const proxy = attachSttProxy(server);

server.listen(config.port, config.host, () => {
  logger.info(`Voice-to-Text server listening on http://localhost:${config.port}`);
  logger.info(`Gnani realtime STT: ${config.stt.url}`, {
    model: config.stt.model,
    language: config.stt.languageCode,
  });
});

function shutdown(signal: string): void {
  logger.info(`Received ${signal}; shutting down.`);
  proxy.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
