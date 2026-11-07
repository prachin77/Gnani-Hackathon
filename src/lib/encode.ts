import lamejs from "lamejs";

/** MP3 frame size in samples (Layer III). */
const MP3_BLOCK_SAMPLES = 1152;
/** Yield to the event loop roughly every this many encoded blocks. */
const YIELD_EVERY_BLOCKS = 160;

function toInt16(value: number): number {
  const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
  return Math.round(clamped * 0x7fff);
}

/**
 * Decodes a recorded blob (WebM/Opus, Ogg, MP4…) into mono signed 16-bit PCM
 * at `sampleRate`. Uses `OfflineAudioContext`, which resamples for us.
 */
export async function decodeToMonoPcm(
  blob: Blob,
  sampleRate = 16_000,
): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const bytes = await blob.arrayBuffer();

  const OfflineCtx =
    window.OfflineAudioContext ??
    (
      window as unknown as {
        webkitOfflineAudioContext?: typeof OfflineAudioContext;
      }
    ).webkitOfflineAudioContext;

  if (!OfflineCtx) {
    throw new Error("OfflineAudioContext is not supported in this browser");
  }

  // Length is irrelevant: decodeAudioData returns the file's real duration,
  // resampled to the context's sample rate.
  const context = new OfflineCtx(1, 1, sampleRate);
  const decoded = await context.decodeAudioData(bytes);

  const length = decoded.length;
  const pcm = new Int16Array(length);
  const channelCount = decoded.numberOfChannels;

  if (channelCount === 1) {
    const data = decoded.getChannelData(0);
    for (let i = 0; i < length; i += 1) pcm[i] = toInt16(data[i]);
  } else {
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c += 1) channels.push(decoded.getChannelData(c));
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channelCount; c += 1) sum += channels[c][i];
      pcm[i] = toInt16(sum / channelCount);
    }
  }

  return { pcm, sampleRate };
}

/**
 * Encodes mono 16-bit PCM to MP3. MP3 carries a real duration in its stream,
 * unlike MediaRecorder's live WebM, which Gnani rejects with
 * "file reports no usable duration".
 */
export async function encodeMp3(
  pcm: Int16Array,
  sampleRate = 16_000,
  bitRate = 32,
): Promise<Blob> {
  if (pcm.length === 0) {
    throw new Error("No audio samples to encode");
  }

  const encoder = new lamejs.Mp3Encoder(1, sampleRate, bitRate);
  const chunks: Uint8Array[] = [];
  let block = 0;

  for (let offset = 0; offset < pcm.length; offset += MP3_BLOCK_SAMPLES) {
    const end = Math.min(offset + MP3_BLOCK_SAMPLES, pcm.length);
    const encoded = encoder.encodeBuffer(pcm.subarray(offset, end));
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));

    block += 1;
    // Keep the UI responsive during long sessions.
    if (block % YIELD_EVERY_BLOCKS === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  return new Blob(chunks, { type: "audio/mpeg" });
}

/**
 * Converts a browser recording into an MP3 file that the Gnani Batch API can
 * process (real duration metadata, 16 kHz mono, speech-quality bitrate).
 */
export async function convertRecordingToMp3(
  blob: Blob,
): Promise<{ blob: Blob; durationMs: number }> {
  const { pcm, sampleRate } = await decodeToMonoPcm(blob, 16_000);
  const mp3 = await encodeMp3(pcm, sampleRate, 32);
  return {
    blob: mp3,
    durationMs: Math.round((pcm.length / sampleRate) * 1000),
  };
}
