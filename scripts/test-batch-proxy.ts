import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

interface UpstreamSession {
  frames: number[];
  commits: number;
  apiKey: string | undefined;
  closed: boolean;
}

interface TestClient {
  acks: number[];
  transcripts: string[];
  errors: string[];
}

const upstreamSessions: UpstreamSession[] = [];

const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
const upstreamPort = (upstream.address() as AddressInfo).port;

upstream.on("connection", (socket, request) => {
  const session: UpstreamSession = {
    frames: [],
    commits: 0,
    apiKey: request.headers["x-api-key-id"] as string | undefined,
    closed: false,
  };
  upstreamSessions.push(session);

  socket.send(JSON.stringify({ type: "connected", request_id: "test-request" }));

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      session.frames.push(frame.readUInt32BE(0));
      return;
    }
    const message = JSON.parse(data.toString()) as { type?: string };
    if (message.type === "commit") {
      session.commits += 1;
      socket.send(
        JSON.stringify({
          type: "transcript",
          text: `final segment ${session.commits}`,
          segment_id: String(session.commits),
          segment_index: session.commits,
          detected_language_code: "en",
        }),
      );
    }
  });

  socket.on("close", () => {
    session.closed = true;
  });
});

process.env.GNANI_API_KEY = "test-key";
process.env.GNANI_STT_URL = `ws://127.0.0.1:${upstreamPort}`;
process.env.MAX_SESSIONS_PER_IP = "10";

const { attachSttProxy } = await import("../server/gnaniWebSocket.ts");

const server = createServer();
const proxy = attachSttProxy(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;

function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 10);
  });
}

function makeFrames(count: number): Buffer[] {
  return Array.from({ length: count }, (_value, index) => {
    const frame = Buffer.alloc(1024);
    frame.writeUInt32BE(index, 0);
    return frame;
  });
}

function runClient(
  path: string,
  frameCount: number,
  sendCommit: boolean,
): Promise<{ client: TestClient; session: UpstreamSession }> {
  return new Promise((resolve, reject) => {
    const client: TestClient = { acks: [], transcripts: [], errors: [] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    let sent = false;
    let session: UpstreamSession | null = null;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Client timed out"));
    }, 10000);

    const finish = async () => {
      if (!session) {
        session = upstreamSessions[upstreamSessions.length - 1] ?? null;
      }
      if (!session) return;
      clearTimeout(timer);
      try {
        await waitFor(
          () => session!.frames.length >= frameCount,
          5000,
          "all frames to reach the upstream",
        );
        resolve({ client, session });
      } catch (error) {
        reject(error);
      }
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as {
        type?: string;
        frames?: number;
        text?: string;
        message?: string;
      };

      if (message.type === "connected" && !sent) {
        sent = true;
        for (const frame of makeFrames(frameCount)) ws.send(frame);
        if (sendCommit) ws.send(JSON.stringify({ type: "commit" }));
        return;
      }

      if (message.type === "batch_ack" && typeof message.frames === "number") {
        client.acks.push(message.frames);
        return;
      }

      if (message.type === "transcript") {
        client.transcripts.push(message.text ?? "");
        void finish();
        return;
      }

      if (message.type === "proxy_error") {
        client.errors.push(message.message ?? "unknown proxy error");
        void finish();
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function closeClient(): Promise<void> {
  // Let the proxy release its per-IP slot before the next case.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

const FRAME_COUNT = 500;

await test("batch mode relays every frame in order and commits last", async () => {
  const { client, session } = await runClient("/ws/stt/batch", FRAME_COUNT, true);
  const expected = Array.from({ length: FRAME_COUNT }, (_value, index) => index);

  assert.deepEqual(session.frames, expected, "frames must arrive exactly once and in order");
  assert.equal(session.commits, 1);
  assert.equal(session.apiKey, "test-key");
  assert.ok(client.acks.length > 0, "batch clients receive flow-control acknowledgements");
  assert.ok(
    Math.max(...client.acks) >= FRAME_COUNT,
    "the final frame must be acknowledged before commit",
  );
  assert.deepEqual(client.errors, []);
  assert.deepEqual(client.transcripts, ["final segment 1"]);
  await closeClient();
});

await test("realtime mode keeps its original relay path without batch acks", async () => {
  const { client, session } = await runClient("/ws/stt/realtime", 20, true);
  const expected = Array.from({ length: 20 }, (_value, index) => index);

  assert.deepEqual(session.frames, expected);
  assert.equal(session.commits, 1);
  assert.deepEqual(client.acks, [], "realtime clients must not receive batch acks");
  assert.deepEqual(client.errors, []);
  assert.deepEqual(client.transcripts, ["final segment 1"]);
  await closeClient();
});

console.log(`\n${passed} batch proxy tests passed.`);

proxy.close();
for (const socket of upstream.clients) socket.terminate();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
await new Promise<void>((resolve) => server.close(() => resolve()));
