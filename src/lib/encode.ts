import lamejs from "lamejs";

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
