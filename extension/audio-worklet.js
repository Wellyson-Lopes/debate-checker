// Converte o áudio da aba (44,1/48 kHz) em PCM 16-bit mono a 16 kHz, em blocos de 100 ms.
class PCM16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.size = 1600;
    this.out = new Int16Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.count));
        this.acc = 0;
        this.count = 0;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.size) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16-downsampler', PCM16Downsampler);
