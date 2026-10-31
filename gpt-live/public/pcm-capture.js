// AudioWorklet: microphone → mono PCM16 little-endian at targetRate (24 kHz by default).
// Resamples from the AudioContext rate with linear interpolation and posts fixed-size chunks.

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.targetRate = o.targetRate || 24000;
    this.step = sampleRate / this.targetRate; // input samples per output sample
    this.t = 0; // next output position, in input samples relative to the current block
    this.last = 0; // last input sample of the previous block
    this.chunkSize = Math.round((this.targetRate * (o.chunkMs || 40)) / 1000);
    this.out = new Int16Array(this.chunkSize);
    this.n = 0;
  }

  push(s) {
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === this.chunkSize) {
      this.port.postMessage(this.out.buffer, [this.out.buffer]);
      this.out = new Int16Array(this.chunkSize);
      this.n = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    const len = ch.length;
    const step = this.step;
    let t = this.t;
    while (t < len - 1) {
      let s;
      if (t < 0) {
        s = this.last + (ch[0] - this.last) * (t + 1);
      } else {
        const i = t | 0;
        const f = t - i;
        s = ch[i] + (ch[i + 1] - ch[i]) * f;
      }
      this.push(s);
      t += step;
    }
    this.t = t - len;
    this.last = ch[len - 1];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
