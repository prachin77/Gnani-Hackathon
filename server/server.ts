import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import express from "express";
import { assertConfig, config } from "./config";
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
