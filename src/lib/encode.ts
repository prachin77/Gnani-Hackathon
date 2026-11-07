import { Mp3Encoder } from "@breezystack/lamejs";

/** MP3 frame size in samples (Layer III). */
const MP3_BLOCK_SAMPLES = 1152;
/** Yield to the event loop roughly every this many encoded blocks. */
const YIELD_EVERY_BLOCKS = 160;

/**
 * Encodes mono 16-bit PCM to MP3.
 *
 * MP3 carries a real duration in its stream, unlike MediaRecorder's live WebM,
 * which Gnani rejects with `file reports no usable duration ("")`.
 */
export async function encodeMp3(
  pcm: Int16Array,
  sampleRate = 16_000,
  bitRate = 32,
): Promise<Blob> {
  if (pcm.length === 0) {
    throw new Error("No audio samples to encode");
  }

  const encoder = new Mp3Encoder(1, sampleRate, bitRate);
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
 * Wraps mono 16-bit PCM in a WAV container. A WAV header carries a real
 * duration, so it is a dependency-free fallback if MP3 encoding ever fails.
 */
export function encodeWav(pcm: Int16Array, sampleRate = 16_000): Blob {
  if (pcm.length === 0) {
    throw new Error("No audio samples to encode");
  }

  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  new Int16Array(buffer, 44).set(pcm);

  return new Blob([buffer], { type: "audio/wav" });
}
