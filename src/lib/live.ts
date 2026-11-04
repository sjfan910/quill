/**
 * Free, on-device-ish live transcription via the browser's Web Speech API
 * (Safari uses Apple's speech recognition; Chrome uses Google's). It is
 * best-effort: it can stop on its own, so it restarts itself, and gives up if
 * it keeps failing. The MP3 recording is always the source of truth; whatever
 * this misses is transcribed by Gemini later (see gaps.ts).
 */

// The Web Speech API isn't in every TS DOM lib; keep the surface we use typed loosely.
type SR = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
type SRCtor = new () => SR

function ctor(): SRCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export const liveSupported = () => !!ctor()

export class LiveTranscriber {
  segments: { t: number; text: string }[] = []
  interim = ''
  failed: string | null = null

  private rec: SR | null = null
  private active = false
  private startTimes = new Map<number, number>()
  private restarts: number[] = []

  private now: () => number
  private onUpdate: () => void

  /** `now` returns the recorder's audio time, so text lines up with the audio. */
  constructor(now: () => number, onUpdate: () => void = () => {}) {
    this.now = now
    this.onUpdate = onUpdate
  }

  start(existing: { t: number; text: string }[] = []) {
    const C = ctor()
    if (!C) {
      this.failed = 'unsupported'
      return false
    }
    this.segments = existing.slice()
    this.active = true
    this.spawn(C)
    return true
  }

  private spawn(C: SRCtor) {
    if (!this.active) return
    const r = new C()
    r.continuous = true
    r.interimResults = true
    r.lang = 'en-US'
    this.startTimes = new Map()
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]
        if (!this.startTimes.has(i)) this.startTimes.set(i, Math.max(0, this.now() - 1.5))
        if (res.isFinal) {
          const text = res[0].transcript.trim()
          if (text) this.segments.push({ t: Math.round(this.startTimes.get(i)! * 10) / 10, text })
          this.interim = ''
        } else {
          this.interim = res[0].transcript
        }
      }
      this.onUpdate()
    }
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.failed = e.error
        this.active = false
      }
    }
    r.onend = () => {
      if (!this.active) return
      // Safari ends recognition on silence or after a while; restart, but not in a tight loop.
      const now = Date.now()
      this.restarts = this.restarts.filter((t) => now - t < 60_000)
      this.restarts.push(now)
      if (this.restarts.length > 20) {
        this.failed = 'unstable'
        this.active = false
        this.onUpdate()
        return
      }
      setTimeout(() => this.spawn(C), 300)
    }
    try {
      r.start()
      this.rec = r
    } catch {
      setTimeout(() => this.spawn(C), 1000)
    }
  }

  stop() {
    this.active = false
    this.interim = ''
    try {
      this.rec?.stop()
    } catch {
      /* already stopped */
    }
    this.rec = null
  }

  get running() {
    return this.active
  }
}
