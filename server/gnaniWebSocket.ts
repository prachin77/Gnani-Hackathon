import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "./config";
import { logger } from "./logger";

const REALTIME_PATH = "/ws/stt/realtime";
const BATCH_PATH = "/ws/stt/batch";
/** Legacy realtime path kept for older clients. */
const LEGACY_PATH = "/ws/stt";
const PCM_FRAME_BYTES = 1024;

/**
 * Batch uploads are sent faster than real time, so the browser uses a
 * per-connection window and waits for acknowledgements. The server forwards
 * queued frames only while the upstream socket has room, which prevents the
 * proxy from ever dropping audio from an uploaded file.
 */
const BATCH_ACK_EVERY = 8;
const BATCH_HIGH_WATER_BYTES = 128 * 1024;
const BATCH_MAX_QUEUE_FRAMES = 1024;
const BATCH_PUMP_INTERVAL_MS = 20;

interface ProxyErrorFrame {
  type: "proxy_error";
  code:
    | "AUTH_FAILED"
    | "RATE_LIMITED"
    | "UPSTREAM_REJECTED"
    | "UPSTREAM_ERROR"
    | "CONFIG"
    | "SESSION_LIMIT"
    | "BAD_FRAME";
  message: string;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch (error) {
    logger.warn("Failed to send proxy frame", { error: (error as Error).message });
  }
}

function sendProxyError(socket: WebSocket, code: ProxyErrorFrame["code"], message: string): void {
  sendJson(socket, { type: "proxy_error", code, message } satisfies ProxyErrorFrame);
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Headers are attached server-side only. The browser never sees the API key. */
function upstreamHeaders(requestId: string): Record<string, string> {
  return {
    "x-api-key-id": config.stt.apiKey,
    model: config.stt.model,
    language_code: config.stt.languageCode,
    "x-sample-rate": String(config.stt.sampleRate),
    format: config.stt.format,
    "x-min-silence-ms": String(config.stt.minSilenceMs),
    "x-vad-threshold": String(config.stt.vadThreshold),
    "x-idle-timeout-sec": String(config.stt.idleTimeoutSec),
    "x-max-speech-s": String(config.stt.maxSpeechSec),
    "x-api-request-id": requestId,
  };
}

/**
 * Attaches the WebSocket proxies:
 * - /ws/stt/realtime — microphone sessions
 * - /ws/stt/batch    — uploaded file sessions with flow control
 *
 * Both attach the Gnani credentials server-side; the browser never sees them.
 */
export function attachSttProxy(server: HttpServer): { close: () => void } {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });

  const sessionsByIp = new Map<string, number>();

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }

    let mode: "realtime" | "batch";
    if (url.pathname === BATCH_PATH) {
      mode = "batch";
    } else if (url.pathname === REALTIME_PATH || url.pathname === LEGACY_PATH) {
      mode = "realtime";
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req, mode === "batch");
    });
  });

  wss.on("connection", (client: WebSocket, req: IncomingMessage, isBatch = false) => {
    const sessionId = randomUUID().slice(0, 8);
    const requestId = randomUUID();
    const ip = clientIp(req);
    const log = (message: string, meta?: Record<string, unknown>) =>
      logger.info(`[${sessionId}] ${message}`, meta);

    const active = sessionsByIp.get(ip) ?? 0;
    if (active >= config.limits.sessionsPerIp) {
      logger.warn(`[${sessionId}] rejected: session limit for ip`, { ip, active });
      sendProxyError(client, "SESSION_LIMIT", "Too many active recording sessions. Stop one and try again.");
      client.close(1013, "Session limit reached");
      return;
    }
    sessionsByIp.set(ip, active + 1);

    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      const remaining = (sessionsByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) sessionsByIp.delete(ip);
      else sessionsByIp.set(ip, remaining);
    };
    client.on("close", releaseSlot);

    if (!config.stt.apiKey) {
      sendProxyError(client, "CONFIG", "Speech service is not configured on the server.");
      client.close(1011, "Missing server configuration");
      return;
    }

    log("browser connected; opening upstream", { ip, requestId });

    let upstream: WebSocket;
    try {
      upstream = new WebSocket(config.stt.url, {
        headers: upstreamHeaders(requestId),
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
      });
    } catch (error) {
      logger.error(`[${sessionId}] could not create upstream socket`, {
        message: (error as Error).message,
      });
      sendProxyError(client, "CONFIG", "The speech service is not configured correctly on the server.");
      client.close(1011, "Upstream unavailable");
      return;
    }

    let clientClosed = false;
    let handshakeRejected = false;
    let framesSent = 0;
    let framesDropped = 0;
    let invalidFrames = 0;
    let transcripts = 0;

    const startedAt = Date.now();

    // Batch-only flow control. Realtime sockets keep their original behaviour.
    const batchQueue: Buffer[] = [];
    let batchForwarded = 0;
    let batchAcked = 0;
    let batchPendingCommit = false;
    let batchPumpTimer: ReturnType<typeof setInterval> | null = null;

    const sendBatchAck = (force = false) => {
      if (batchForwarded === batchAcked) return;
      if (!force && batchForwarded - batchAcked < BATCH_ACK_EVERY) return;
      batchAcked = batchForwarded;
      sendJson(client, { type: "batch_ack", frames: batchAcked });
    };

    const pumpBatch = () => {
      if (!isBatch || upstream.readyState !== WebSocket.OPEN) return;

      while (
        batchQueue.length > 0 &&
        upstream.bufferedAmount < BATCH_HIGH_WATER_BYTES
      ) {
        const frame = batchQueue.shift();
        if (!frame) break;
        upstream.send(frame);
        batchForwarded += 1;
      }

      // Acknowledge when a full window has gone through or when the queue has
      // drained, so the final partial group of frames is never left un-acked.
      if (batchQueue.length === 0 || batchForwarded - batchAcked >= BATCH_ACK_EVERY) {
        sendBatchAck();
      }

      if (batchQueue.length === 0 && batchPendingCommit) {
        batchPendingCommit = false;
        sendBatchAck(true);
        upstream.send(JSON.stringify({ type: "commit" }));
        log("batch commit sent", { framesSent, batchForwarded });
      }
    };

    const stopBatchPump = () => {
      if (batchPumpTimer !== null) {
        clearInterval(batchPumpTimer);
        batchPumpTimer = null;
      }
      batchQueue.length = 0;
    };

    const closeUpstream = (code = 1000, reason = "client closed") => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close(code, reason);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    };

    upstream.on("open", () => {
      log("upstream open", { mode: isBatch ? "batch" : "realtime" });
      if (isBatch && batchPumpTimer === null) {
        batchPumpTimer = setInterval(pumpBatch, BATCH_PUMP_INTERVAL_MS);
      }
    });

    upstream.on("message", (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      if (!isBinary) {
        const text = payload.toString("utf8");
        if (text.includes('"transcript"')) transcripts += 1;
        if (client.readyState === WebSocket.OPEN) client.send(text);
        return;
      }

      if (client.readyState === WebSocket.OPEN) {
        client.send(payload, { binary: true });
      }
    });

    upstream.on("unexpected-response", (request, response) => {
      handshakeRejected = true;
      const status = response.statusCode ?? 0;
      logger.error(`[${sessionId}] upstream handshake rejected`, { status, requestId });

      let code: ProxyErrorFrame["code"] = "UPSTREAM_REJECTED";
      let message = "The speech service rejected the connection. Please try again.";
      if (status === 401 || status === 403) {
        code = "AUTH_FAILED";
        message = "The speech service rejected the API credentials. Check GNANI_API_KEY on the server.";
      } else if (status === 429) {
        code = "RATE_LIMITED";
        message = "The speech service is rate limiting requests. Try again in a moment.";
      }

      sendProxyError(client, code, message);
      response.resume();
      request.destroy();
      client.close(1011, "Upstream handshake failed");
    });

    upstream.on("error", (error) => {
      stopBatchPump();
      logger.error(`[${sessionId}] upstream error`, { message: error.message, requestId });
      if (clientClosed || handshakeRejected) return;
      sendProxyError(client, "UPSTREAM_ERROR", "Could not reach the speech service. Check your connection and try again.");
      client.close(1011, "Upstream error");
    });

    upstream.on("close", (code, reason) => {
      stopBatchPump();
      const reasonText = reason.toString().slice(0, 200);
      log("upstream closed", {
        code,
        reason: reasonText,
        framesSent,
        framesDropped,
        transcripts,
        mode: isBatch ? "batch" : "realtime",
      });

      if (clientClosed) return;

      sendJson(client, { type: "proxy_closed", code });
      const mapped = code === 1000 || code === 1001 || code === 1008 || code === 1011 ? code : 1011;
      client.close(mapped, "Upstream closed");
    });

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

        if (frame.byteLength !== PCM_FRAME_BYTES) {
          invalidFrames += 1;
          if (invalidFrames <= 5 || invalidFrames % 100 === 0) {
            logger.warn(`[${sessionId}] dropped non-conforming audio frame`, {
              bytes: frame.byteLength,
              invalidFrames,
            });
          }
          if (invalidFrames > 200) {
            sendProxyError(client, "BAD_FRAME", "Audio streaming failed because of an unsupported audio format.");
            client.close(1003, "Unsupported audio frame");
          }
          return;
        }

        if (upstream.readyState !== WebSocket.OPEN) return;

        if (isBatch) {
          // Never drop uploaded audio. The client keeps a small in-flight
          // window, so this queue stays bounded in normal operation.
          if (batchQueue.length >= BATCH_MAX_QUEUE_FRAMES) {
            logger.error(`[${sessionId}] batch queue overflow; closing session`);
            sendProxyError(
              client,
              "UPSTREAM_ERROR",
              "The upload is moving faster than the transcription service can accept. Please try again.",
            );
            client.close(1011, "Batch queue overflow");
            return;
          }
          batchQueue.push(frame);
          framesSent += 1;
          pumpBatch();
          return;
        }

        if (upstream.bufferedAmount > config.limits.maxUpstreamBufferedBytes) {
          framesDropped += 1;
          if (framesDropped <= 5 || framesDropped % 100 === 0) {
            logger.warn(`[${sessionId}] upstream backpressure; dropping frame`, {
              bufferedAmount: upstream.bufferedAmount,
              framesDropped,
            });
          }
          return;
        }

        upstream.send(frame);
        framesSent += 1;
        return;
      }

      // Only allow whitelisted control frames through to Gnani.
      const text = data.toString();
      if (text.length > 2048) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;

      const type = (message as { type?: unknown }).type;
      if (type === "commit") {
        if (upstream.readyState === WebSocket.OPEN) {
          if (isBatch) {
            // Preserve ordering: the commit is sent after every queued frame.
            batchPendingCommit = true;
            pumpBatch();
          } else {
            upstream.send(JSON.stringify({ type: "commit" }));
            log("commit sent", { framesSent });
          }
        }
      }
    });

    client.on("close", (code, reason) => {
      clientClosed = true;
      stopBatchPump();
      const durationMs = Date.now() - startedAt;
      log("browser closed", {
        code,
        reason: reason.toString().slice(0, 120),
        durationMs,
        framesSent,
        framesDropped,
        transcripts,
        mode: isBatch ? "batch" : "realtime",
      });
      closeUpstream();
    });

    client.on("error", (error) => {
      log("browser socket error", { message: error.message });
    });
  });

  return {
    close: () => {
      for (const client of wss.clients) {
        try {
          client.close(1001, "Server shutting down");
        } catch {
          client.terminate();
        }
      }
      wss.close();
    },
  };
}
