export const FRAME_BYTES = 1024;
export const FRAME_SAMPLES = 512;
export const TARGET_SAMPLE_RATE = 16000;
/** Duration of one 16 kHz / 512-sample frame. */
export const FRAME_INTERVAL_MS = 32;

/**
 * Collects PCM samples and emits fixed-size 512-sample (1,024-byte) frames.
 * Used by the ScriptProcessor fallback when AudioWorklet is unavailable.
 */
export class PcmFrameEmitter {
  private frame = new Int16Array(FRAME_SAMPLES);
  private index = 0;

  constructor(private readonly onFrame: (buffer: ArrayBuffer) => void) {}

  pushSample(value: number): void {
    let sample = value;
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;

    this.frame[this.index++] =
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);

    if (this.index === FRAME_SAMPLES) {
      const completed = this.frame;
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.index = 0;
      this.onFrame(completed.buffer);
    }
  }

  flush(): void {
    if (this.index === 0) return;
    const padded = new Int16Array(FRAME_SAMPLES);
    padded.set(this.frame.subarray(0, this.index));
    this.index = 0;
    this.onFrame(padded.buffer);
  }
}

/** Stateful linear resampler that can cross render-quantum boundaries. */
export class LinearResampler {
  private position = 0;
  private carry = 0;
  private readonly ratio: number;

  constructor(inputRate: number, outputRate = TARGET_SAMPLE_RATE) {
    this.ratio = inputRate / outputRate;
  }

  process(samples: Float32Array, onSample: (value: number) => void): void {
    const length = samples.length;
    if (length === 0) return;

    let position = this.position;
    while (position < length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = index < 0 ? this.carry : samples[index];
      const b = index + 1 < length ? samples[index + 1] : samples[length - 1];
      onSample(a + (b - a) * fraction);
      position += this.ratio;
    }

    this.position = position - length;
    this.carry = samples[length - 1];
  }
}

export function sttWebSocketUrl(mode: "realtime" | "batch" = "realtime"): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/stt/${mode}`;
}
