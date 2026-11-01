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
  getDiarizeJobFiles,
  getDiarizeJobStatus,
  normalizeAudioFilename,
  startDiarizeJob,
} from "./gnaniBatch";
import { attachSttProxy } from "./gnaniWebSocket";
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
