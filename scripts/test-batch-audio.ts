import assert from "node:assert/strict";
import {
  BatchCancelledError,
  BatchInputError,
  MAX_BATCH_DURATION_MS,
  prepareBatchAudio,
  validateBatchFile,
} from "../src/lib/batch.ts";

interface FakeBuffer {
  sampleRate: number;
  length: number;
  duration: number;
  numberOfChannels: number;
  getChannelData: (channel: number) => Float32Array;
}

let nextBuffer: FakeBuffer | null = null;

class MockOfflineAudioContext {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}

  async decodeAudioData(): Promise<FakeBuffer> {
    if (!nextBuffer) throw new Error("no buffer queued");
    return nextBuffer;
  }
}

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext =
  MockOfflineAudioContext;

function buffer(
  sampleRate: number,
  channelData: Float32Array[],
): FakeBuffer {
  const length = channelData[0].length;
  return {
    sampleRate,
    length,
    duration: length / sampleRate,
    numberOfChannels: channelData.length,
    getChannelData: (channel: number) => channelData[channel],
  };
}

function file(name = "sample.wav", bytes = 2048, type = "audio/wav"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

await test("downmixes stereo and pads to whole 512-sample frames", async () => {
  const length = 16000; // 1 s at 16 kHz
  const left = new Float32Array(length).fill(0.5);
  const right = new Float32Array(length).fill(0.25);
  nextBuffer = buffer(16000, [left, right]);

  const prepared = await prepareBatchAudio(file());

  assert.equal(prepared.sourceSampleRate, 16000);
  assert.equal(prepared.sourceChannels, 2);
  assert.equal(prepared.pcm.length % 512, 0);
  assert.equal(prepared.pcm.length, 16384); // 32 frames (1 s = 31.25 → padded)
  assert.equal(prepared.durationMs, 1000);
  assert.equal(prepared.chunkSamples % 512, 0);
  // (0.5 + 0.25) / 2 = 0.375 → round(0.375 * 32767) = 12288
  assert.equal(prepared.pcm[0], 12288);
  assert.equal(prepared.pcm[15999], 12288);
  // Padding after the real audio is silence.
  assert.equal(prepared.pcm[16000], 0);
  assert.equal(prepared.pcm[prepared.pcm.length - 1], 0);
});

await test("resamples 48 kHz mono to 16 kHz with 1,024-byte frames", async () => {
  const sourceRate = 48000;
  const length = sourceRate * 2; // 2 s
  const sine = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sourceRate);
  }
  nextBuffer = buffer(sourceRate, [sine]);

  const prepared = await prepareBatchAudio(file());

  assert.equal(prepared.sourceSampleRate, 48000);
  assert.equal(prepared.pcm.length % 512, 0);
  const frames = prepared.pcm.length / 512;
  assert.equal(frames, 63); // 2 s at 32 ms per frame = 62.5 → 63 frames
  assert.ok(Math.abs(prepared.durationMs - 2000) < 2);

  let sumSquares = 0;
  for (let i = 0; i < 32000; i += 1) {
    const value = prepared.pcm[i] / 32768;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / 32000);
  assert.ok(Math.abs(rms - 0.3536) < 0.01, `unexpected RMS ${rms}`);
});

await test("rejects unsupported file types", () => {
  assert.throws(
    () => validateBatchFile(file("notes.txt", 10, "text/plain")),
    BatchInputError,
  );
});

await test("rejects empty files", () => {
  assert.throws(() => validateBatchFile(file("empty.wav", 0, "audio/wav")), BatchInputError);
});

await test("rejects files longer than 30 minutes", async () => {
  const length = 16000;
  nextBuffer = buffer(16000, [new Float32Array(length)]);
  nextBuffer.duration = (MAX_BATCH_DURATION_MS + 1000) / 1000;

  await assert.rejects(
    prepareBatchAudio(file("long.wav")),
    BatchInputError,
  );
});

await test("supports cancellation during preparation", async () => {
  const length = 48000 * 3;
  const mono = new Float32Array(length);
  nextBuffer = buffer(48000, [mono]);

  let progressCalls = 0;
  await assert.rejects(
    prepareBatchAudio(file("cancel.wav"), {
      isCancelled: () => progressCalls > 0,
      onProgress: () => {
        progressCalls += 1;
      },
    }),
    BatchCancelledError,
  );
});

console.log(`\n${passed} batch audio tests passed.`);
