import { Mp3Encoder } from '@breezystack/lamejs'
import { putChunk } from './db'

const OUT_RATE = 16000 // speech-quality mono; ~14 MB per hour at 32 kbps
const KBPS = 32
const FLUSH_EVERY_SEC = 4

export type RecorderState = 'idle' | 'recording' | 'paused'

/**
 * Records the mic to MP3 in the browser and saves it to IndexedDB every few
 * seconds, so a crash or iOS killing the page loses at most a few seconds.
 * Time is measured in *recorded audio*, so marks line up with the audio file.
 */
export class LectureRecorder {
  state: RecorderState = 'idle'
  level = 0
  onUpdate?: () => void

  private ctx?: AudioContext
  private stream?: MediaStream
  private source?: MediaStreamAudioSourceNode
  private node?: AudioWorkletNode
  private encoder = new Mp3Encoder(1, OUT_RATE, KBPS)
  private pending: Uint8Array[] = []
  private pendingSamples = 0
  private samples = 0 // output samples encoded in this session
  private carry = new Float32Array(0)
  private seq = 0
  private offsetSec = 0
  private lectureId = ''
  private flushing = Promise.resolve()

  get elapsed() {
    return this.offsetSec + this.samples / OUT_RATE
  }

  /** Create the AudioContext. Call synchronously inside a tap (iOS rule). */
  prepare() {
    this.ctx ??= new AudioContext()
  }

  /** Start (or continue, by passing the existing duration/chunk count). */
  async start(lectureId: string, offsetSec = 0, startSeq = 0) {
    this.lectureId = lectureId
    this.offsetSec = offsetSec
    this.seq = startSeq
    this.prepare()
    await this.ctx!.resume().catch(() => {})
    await this.ctx!.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`)
    this.node = new AudioWorkletNode(this.ctx!, 'quill-collector')
    this.node.port.onmessage = (e) => this.onSamples(e.data as Float32Array)
    await this.attachMic()
    // keep the graph pulling; output is silent because the worklet writes nothing
    this.node.connect(this.ctx!.destination)
    this.state = 'recording'
    document.addEventListener('visibilitychange', this.revive)
    this.onUpdate?.()
  }

  private async attachMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    this.source = this.ctx!.createMediaStreamSource(this.stream)
    this.source.connect(this.node!)
    for (const t of this.stream.getAudioTracks()) t.onended = () => void this.revive()
  }

  /** iOS can suspend the context or kill the mic track; try to bring both back. */
  revive = async () => {
    if (this.state !== 'recording' || document.visibilityState !== 'visible' || !this.ctx) return
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {})
    const live = this.stream?.getAudioTracks().some((t) => t.readyState === 'live')
    if (!live) {
      this.source?.disconnect()
      await this.attachMic().catch(() => {})
    }
  }

  private onSamples(input: Float32Array) {
    if (this.state !== 'recording' || !this.ctx) return
    // level meter (RMS)
    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    this.level = Math.min(1, Math.sqrt(sum / input.length) * 4)

    const pcm = this.downsample(input, this.ctx.sampleRate)
    const mp3 = this.encoder.encodeBuffer(pcm)
    if (mp3.length) this.pending.push(mp3)
    this.samples += pcm.length
    this.pendingSamples += pcm.length
    if (this.pendingSamples >= OUT_RATE * FLUSH_EVERY_SEC) this.flush()
    this.onUpdate?.()
  }

  /** Box-filter downsample to 16 kHz and convert to Int16. */
  private downsample(input: Float32Array, inRate: number) {
    const data = new Float32Array(this.carry.length + input.length)
    data.set(this.carry)
    data.set(input, this.carry.length)
    const ratio = inRate / OUT_RATE
    const outLen = Math.floor(data.length / ratio)
    const out = new Int16Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio)
      const b = Math.min(data.length, Math.floor((i + 1) * ratio))
      let s = 0
      for (let j = a; j < b; j++) s += data[j]
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)))
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    this.carry = data.slice(Math.floor(outLen * ratio))
    return out
  }

  private flush(final = false) {
    if (final) {
      const tail = this.encoder.flush()
      if (tail.length) this.pending.push(tail)
    }
    if (!this.pending.length) return this.flushing
    const blob = new Blob(this.pending as BlobPart[], { type: 'audio/mpeg' })
    const seq = this.seq++
    this.pending = []
    this.pendingSamples = 0
    this.flushing = this.flushing.then(() => putChunk(this.lectureId, seq, blob))
    return this.flushing
  }

  get chunkCount() {
    return this.seq
  }

  async pause() {
    if (this.state !== 'recording') return
    this.state = 'paused'
    await this.ctx?.suspend()
    await this.flush()
    this.onUpdate?.()
  }

  async resume() {
    if (this.state !== 'paused') return
    this.state = 'recording'
    await this.ctx?.resume()
    await this.revive()
    this.onUpdate?.()
  }

  /** Stop and persist everything. Returns final duration in seconds. */
  async stop() {
    this.state = 'idle'
    document.removeEventListener('visibilitychange', this.revive)
    await this.flush(true)
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close().catch(() => {})
    this.onUpdate?.()
    return this.elapsed
  }
}

// --- screen wake lock (keeps iOS from auto-locking and killing the mic)
let lock: WakeLockSentinel | null = null
export async function keepAwake(on: boolean) {
  try {
    if (on && 'wakeLock' in navigator) {
      lock = await navigator.wakeLock.request('screen')
      document.addEventListener('visibilitychange', relock)
    } else {
      document.removeEventListener('visibilitychange', relock)
      await lock?.release()
      lock = null
    }
    return !!lock
  } catch {
    return false
  }
}
async function relock() {
  if (document.visibilityState === 'visible' && lock?.released) {
    lock = await navigator.wakeLock.request('screen').catch(() => null)
  }
}
export const wakeLockSupported = () => 'wakeLock' in navigator
