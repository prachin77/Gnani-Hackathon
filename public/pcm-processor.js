/**
 * AudioWorklet processor: downmixes the input to mono, resamples it to 16 kHz
 * and emits signed 16-bit little-endian PCM frames of exactly 512 samples
 * (1,024 bytes) — the frame size expected by Gnani's realtime STT API.
 *
 * Running this on the audio rendering thread keeps pacing tied to the audio
 * clock, so one frame leaves the processor roughly every 32 ms.
 */

const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_FRAME_SAMPLES = 512;

class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = (options && options.processorOptions) || {};
    this.targetRate = processorOptions.targetSampleRate || DEFAULT_TARGET_RATE;
    this.frameSamples = processorOptions.frameSamples || DEFAULT_FRAME_SAMPLES;

    /** Input samples consumed per output sample (e.g. 48000 / 16000 = 3). */
    this.ratio = sampleRate / this.targetRate;
    /** Fractional read position inside the current render quantum. */
    this.position = 0;
    /** Last sample of the previous quantum, used for boundary interpolation. */
    this.carry = 0;

    this.frame = new Int16Array(this.frameSamples);
    this.frameIndex = 0;
    this.running = true;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "stop") {
        this.running = false;
        this.port.onmessage = null;
      } else if (data.type === "flush") {
        this.flushPartialFrame();
      }
    };
  }

  flushPartialFrame() {
    if (this.frameIndex === 0) return;
    const padded = new Int16Array(this.frameSamples);
    padded.set(this.frame.subarray(0, this.frameIndex));
    this.frameIndex = 0;
    this.port.postMessage(padded.buffer, [padded.buffer]);
  }

  pushSample(sample) {
    let value = sample;
    if (value > 1) value = 1;
    else if (value < -1) value = -1;

    this.frame[this.frameIndex++] =
      value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);

    if (this.frameIndex === this.frameSamples) {
      const completed = this.frame;
      this.frame = new Int16Array(this.frameSamples);
      this.frameIndex = 0;
      this.port.postMessage(completed.buffer, [completed.buffer]);
    }
  }

  process(inputs) {
    if (!this.running) return false;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const block = input[0];
    if (!block || block.length === 0) return true;

    let samples = block;
    if (input.length > 1) {
      samples = new Float32Array(block.length);
      for (let channel = 0; channel < input.length; channel += 1) {
        const data = input[channel];
        for (let i = 0; i < block.length; i += 1) samples[i] += data[i];
      }
      for (let i = 0; i < samples.length; i += 1) samples[i] /= input.length;
    }

    const length = samples.length;
    let position = this.position;

    while (position < length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = index < 0 ? this.carry : samples[index];
      const b = index + 1 < length ? samples[index + 1] : samples[length - 1];
      this.pushSample(a + (b - a) * fraction);
      position += this.ratio;
    }

    this.position = position - length;
    this.carry = samples[length - 1];
    return true;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
