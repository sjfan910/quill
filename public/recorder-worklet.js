// Collects mic samples on the audio thread and posts them in ~85ms batches.
class Collector extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer])
          this.buf = new Float32Array(4096)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('quill-collector', Collector)
