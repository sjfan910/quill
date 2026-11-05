import { Mp3Encoder } from '@breezystack/lamejs'
import { putChunk } from './db'

const OUT_RATE = 16000 // speech-quality mono; ~14 MB per hour at 32 kbps
const KBPS = 32
const FLUSH_EVERY_SEC = 4
/** Audio missing for longer than this (screen off, call, app switch) counts as a gap. */
const GAP_SEC = 1.5
const MAX_GAP_FILL_SEC = 4 * 3600

export type RecorderState = 'idle' | 'recording' | 'paused'

/**
 * Records the mic to MP3 in the browser and saves it to IndexedDB every few
 * seconds, so a crash or iOS killing the page loses at most a few seconds.
 * Time is measured in *recorded audio*, so marks line up with the audio file.
 */
export class LectureRecorder {
  state: RecorderState = 'idle'
  level = 0
  /** Loudness per recorded second (0-1). Continues from a previous session when resuming. */
  loudness: number[] = []
  private secSumSq = 0
  private secN = 0
  onUpdate?: () => void
  /** Called after a stretch without audio was filled with silence: [from, to] in recording seconds. */
  onGap?: (gap: { from: number; to: number }) => void
  /** True when iOS stopped the mic and it needs a tap to come back. */
  stalled = false
  gaps: { from: number; to: number }[] = []
  private lastWall = 0 // Date.now() of the last audio received
  private stallTimer?: number

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

  /**
   * What the timer shows: recorded time, plus however long the audio has been missing.
   * When audio comes back that missing stretch is filled with silence, so this never jumps back.
   */
  get liveElapsed() {
    if (this.state !== 'recording' || !this.lastWall) return this.elapsed
    const missing = (Date.now() - this.lastWall) / 1000
    return missing > GAP_SEC ? this.elapsed + missing : this.elapsed
  }

  /** Create the AudioContext. Call synchronously inside a tap (iOS rule). */
  prepare() {
    this.ctx ??= new AudioContext()
  }

  /** Start (or continue, by passing the existing duration/chunk count). */
  async start(lectureId: string, offsetSec = 0, startSeq = 0, loudness: number[] = []) {
    this.loudness = loudness.slice(0, Math.floor(offsetSec))
    while (this.loudness.length < Math.floor(offsetSec)) this.loudness.push(0)
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
    this.lastWall = Date.now()
    document.addEventListener('visibilitychange', this.revive)
    window.addEventListener('pageshow', this.revive)
    window.addEventListener('focus', this.revive)
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

  /**
   * iOS stops the mic when the screen turns off or the app goes to the background. When the
   * page is visible again, bring the audio context and mic back. If iOS insists on a tap,
   * `stalled` turns on and the recording screen shows a big "Tap to continue" button, which
   * calls this again from inside the tap.
   */
  revive = async () => {
    if (this.state !== 'recording' || document.visibilityState !== 'visible' || !this.ctx) return
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {})
    const live = this.stream?.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled && !t.muted)
    if (!live) {
      this.source?.disconnect()
      this.stream?.getTracks().forEach((t) => t.stop())
      await this.attachMic().catch(() => {})
    }
    clearTimeout(this.stallTimer)
    this.stallTimer = window.setTimeout(() => {
      const stalled = this.state === 'recording' && Date.now() - this.lastWall > GAP_SEC * 1000
      if (stalled !== this.stalled) {
        this.stalled = stalled
        this.onUpdate?.()
      }
    }, 1500)
  }

  /** Fill a stretch with silence so the audio timeline matches real time. */
  private fillSilence(sec: number) {
    const from = this.elapsed
    let left = Math.round(Math.min(sec, MAX_GAP_FILL_SEC) * OUT_RATE)
    const zeros = new Int16Array(OUT_RATE)
    while (left > 0) {
      const n = Math.min(left, OUT_RATE)
      const mp3 = this.encoder.encodeBuffer(n === OUT_RATE ? zeros : zeros.subarray(0, n))
      if (mp3.length) this.pending.push(mp3)
      this.samples += n
      this.pendingSamples += n
      // silent seconds in the loudness log, so they're never transcribed (or paid for)
      this.secN += n
      while (this.secN >= OUT_RATE) {
        this.loudness.push(this.secSumSq > 0 ? Math.min(1, Math.round(Math.sqrt(this.secSumSq / OUT_RATE) * 4 * 1000) / 1000) : 0)
        this.secSumSq = 0
        this.secN -= OUT_RATE
      }
      if (this.pendingSamples >= OUT_RATE * FLUSH_EVERY_SEC) this.flush()
      left -= n
    }
    const gap = { from: Math.round(from * 10) / 10, to: Math.round(this.elapsed * 10) / 10 }
    this.gaps.push(gap)
    this.onGap?.(gap)
  }

  private onSamples(input: Float32Array) {
    if (this.state !== 'recording' || !this.ctx) return
    const now = Date.now()
    const missing = (now - this.lastWall) / 1000 - input.length / this.ctx.sampleRate
    if (this.lastWall && missing > GAP_SEC) {
      this.carry = new Float32Array(0)
      this.fillSilence(missing)
    }
    this.lastWall = now
    if (this.stalled) {
      this.stalled = false
      clearTimeout(this.stallTimer)
    }
    // level meter (RMS)
    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    this.level = Math.min(1, Math.sqrt(sum / input.length) * 4)

    const pcm = this.downsample(input, this.ctx.sampleRate)
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768
      this.secSumSq += v * v
      if (++this.secN === OUT_RATE) {
        this.loudness.push(Math.min(1, Math.round(Math.sqrt(this.secSumSq / OUT_RATE) * 4 * 1000) / 1000))
        this.secSumSq = 0
        this.secN = 0
      }
    }
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
    this.lastWall = Date.now() // a deliberate pause is not a gap
    await this.ctx?.resume()
    await this.revive()
    this.onUpdate?.()
  }

  /** Stop and persist everything. Returns final duration in seconds. */
  async stop() {
    this.state = 'idle'
    clearTimeout(this.stallTimer)
    document.removeEventListener('visibilitychange', this.revive)
    window.removeEventListener('pageshow', this.revive)
    window.removeEventListener('focus', this.revive)
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
