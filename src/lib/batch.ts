import {
  FRAME_SAMPLES,
  LinearResampler,
  TARGET_SAMPLE_RATE,
} from "./pcm";

/** Files larger than this are rejected before decoding. */
export const MAX_BATCH_BYTES = 100 * 1024 * 1024;
/** Gnani realtime sessions are capped at 15 minutes; batch chunks stay well below it. */
export const BATCH_CHUNK_MS = 12 * 60 * 1000;
/** A single uploaded file may be up to 30 minutes long. */
export const MAX_BATCH_DURATION_MS = 30 * 60 * 1000;

const CHUNK_SAMPLES = Math.floor((BATCH_CHUNK_MS / 1000) * TARGET_SAMPLE_RATE);
const YIELD_EVERY_SAMPLES = 1_000_000;

const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "opus",
  "wav",
  "weba",
  "webm",
]);

export class BatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchInputError";
  }
}

export class BatchCancelledError extends Error {
  constructor() {
    super("Batch processing was cancelled.");
    this.name = "BatchCancelledError";
  }
}

export interface PreparedBatchAudio {
  /** 16 kHz mono signed 16-bit PCM, padded to whole 512-sample frames. */
  pcm: Int16Array;
  durationMs: number;
  sourceSampleRate: number;
  sourceChannels: number;
  chunkSamples: number;
}

export interface PrepareOptions {
  onProgress?: (fraction: number) => void;
  isCancelled?: () => boolean;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function validateBatchFile(file: File): void {
  if (file.size === 0) {
    throw new BatchInputError("This file is empty. Choose an audio file with speech in it.");
  }
  if (file.size > MAX_BATCH_BYTES) {
    throw new BatchInputError(
      "This file is larger than 100 MB. Choose a smaller audio file or trim it first.",
    );
  }

  const extension = extensionOf(file.name);
  const typeLooksAudio =
    file.type.startsWith("audio/") ||
    file.type === "video/mp4" ||
    file.type === "application/ogg";
  if (!typeLooksAudio && !AUDIO_EXTENSIONS.has(extension)) {
    throw new BatchInputError(
      "That doesn't look like an audio file. Choose a WAV, MP3, M4A, AAC, OGG, FLAC or WebM file.",
    );
  }
}

function encodeSample(value: number): number {
  let sample = value;
  if (sample > 1) sample = 1;
  else if (sample < -1) sample = -1;
  return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function checkCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new BatchCancelledError();
}

/**
 * Decodes an uploaded audio file and converts it to the exact stream format
 * used by realtime recording: mono, 16 kHz, signed 16-bit LE PCM, 512-sample
 * frames. Decoding uses the browser's own codec support; no upload is required
 * until the audio is ready to stream.
 */
export async function prepareBatchAudio(
  file: File,
  options: PrepareOptions = {},
): Promise<PreparedBatchAudio> {
  const { onProgress, isCancelled } = options;
  const report = (fraction: number) => onProgress?.(Math.min(1, Math.max(0, fraction)));

  checkCancelled(isCancelled);
  report(0.02);

  let encodedFile: ArrayBuffer;
  try {
    encodedFile = await file.arrayBuffer();
  } catch {
    throw new BatchInputError("The file could not be read. Try choosing it again.");
  }
  checkCancelled(isCancelled);
  report(0.08);

  let decoded: AudioBuffer;
  try {
    const context = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
    decoded = await context.decodeAudioData(encodedFile);
  } catch {
    throw new BatchInputError(
      "This audio file could not be decoded. Try a standard WAV, MP3, M4A, OGG or FLAC file.",
    );
  }

  checkCancelled(isCancelled);
  report(0.35);

  const durationMs = decoded.duration * 1000;
  if (durationMs > MAX_BATCH_DURATION_MS) {
    throw new BatchInputError(
      "This file is longer than 30 minutes. Trim it or choose a shorter recording.",
    );
  }
  if (durationMs < 250) {
    throw new BatchInputError("This audio file is too short to transcribe. Choose a longer recording.");
  }

  const channels = decoded.numberOfChannels;
  const length = decoded.length;
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    channelData.push(decoded.getChannelData(channel));
  }

  const needsResample = decoded.sampleRate !== TARGET_SAMPLE_RATE;
  const estimatedSamples = needsResample
    ? Math.ceil(length * (TARGET_SAMPLE_RATE / decoded.sampleRate)) + FRAME_SAMPLES
    : length;
  const paddedLength = Math.ceil(estimatedSamples / FRAME_SAMPLES) * FRAME_SAMPLES;
  const pcm = new Int16Array(paddedLength);

  let written = 0;
  if (needsResample) {
    const resampler = new LinearResampler(decoded.sampleRate, TARGET_SAMPLE_RATE);
    const monoSlice = new Float32Array(YIELD_EVERY_SAMPLES);

    // Downmix and resample in slices, matching the realtime worklet.
    for (let offset = 0; offset < length; offset += YIELD_EVERY_SAMPLES) {
      const end = Math.min(offset + YIELD_EVERY_SAMPLES, length);
      const sliceLength = end - offset;

      for (let i = 0; i < sliceLength; i += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          sum += channelData[channel][offset + i];
        }
        monoSlice[i] = sum / channels;
      }

      resampler.process(monoSlice.subarray(0, sliceLength), (sample) => {
        if (written < pcm.length) pcm[written++] = encodeSample(sample);
      });

      report(0.35 + 0.65 * (end / Math.max(1, length)));
      checkCancelled(isCancelled);
      await yieldToUi();
    }
  } else {
    // Downmix and encode in one pass so long files do not need a second
    // full-length Float32 buffer.
    for (let offset = 0; offset < length; offset += YIELD_EVERY_SAMPLES) {
      const end = Math.min(offset + YIELD_EVERY_SAMPLES, length);
      for (let i = offset; i < end; i += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          sum += channelData[channel][i];
        }
        pcm[written++] = encodeSample(sum / channels);
      }
      report(0.35 + 0.65 * (end / Math.max(1, length)));
      checkCancelled(isCancelled);
      await yieldToUi();
    }
  }

  // Trim any over-allocation from the resampler estimate. The final frame is
  // already zero-padded, which gives VAD a clean end to the file.
  const usedFrames = Math.ceil(written / FRAME_SAMPLES);
  const trimmed =
    usedFrames * FRAME_SAMPLES === pcm.length ? pcm : pcm.slice(0, usedFrames * FRAME_SAMPLES);

  report(1);
  return {
    pcm: trimmed,
    durationMs: (written / TARGET_SAMPLE_RATE) * 1000,
    sourceSampleRate: decoded.sampleRate,
    sourceChannels: channels,
    chunkSamples: CHUNK_SAMPLES,
  };
}
