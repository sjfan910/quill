/**
 * Decides which parts of a recording still need (paid) transcription.
 *
 * Two signals the phone already has, no second transcription needed:
 *   1. loudness[] — how loud each second of the recording was
 *   2. live[]     — the free live transcript, with the time each phrase started
 *
 * A 30-second window where someone was clearly talking but the live transcript has
 * almost no words is a gap. Only gaps get sent to Gemini. Leading/trailing silence
 * (before class starts, after it ends) is never sent.
 *
 * Limitation: this finds MISSING text, not WRONG text. Misheard words are left to the
 * notes model (context, slides, course glossary).
 */

export type Range = [number, number] // seconds

const WINDOW = 30
const WORDS_PER_SEC = 2.5 // typical lecture speaking rate
const MIN_SPEECH_IN_WINDOW = 6 // seconds of speech before a window can count as a gap
const MIN_WORD_RATE = 0.8 // words per speaking-second below which the live text is missing
const PAD = 3
/** Recognizer confidence below this means the phrase is probably misheard: treat it as missing. */
export const LOW_CONFIDENCE = 0.5
type LiveSeg = { t: number; text: string; c?: number }
const trusted = (s: LiveSeg) => !(s.c !== undefined && s.c > 0 && s.c < LOW_CONFIDENCE)

function percentile(xs: number[], p: number) {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

/**
 * Which seconds contain speech. Lectures are mostly talking, so the quietest 5% is the
 * best guess at the room's noise floor, and the threshold never exceeds half the typical
 * (median) level — otherwise a recording that is all speech would look all silent.
 */
export function speechMask(loudness: number[]) {
  const floor = percentile(loudness, 0.05)
  const median = percentile(loudness, 0.5)
  const threshold = Math.max(0.015, Math.min(floor * 2.5, median * 0.5))
  return loudness.map((v) => v > threshold)
}

/** Spread each live phrase's words over the seconds it plausibly covered. */
function wordsPerSecond(live: LiveSeg[], duration: number) {
  const wps = new Array(Math.ceil(duration) + 1).fill(0)
  const sorted = live.slice().sort((a, b) => a.t - b.t)
  sorted.forEach((seg, i) => {
    const words = seg.text.split(/\s+/).filter(Boolean).length
    if (!words) return
    const next = sorted[i + 1]?.t ?? duration
    const span = Math.max(1, Math.min(next - seg.t, words / WORDS_PER_SEC + 2, 30))
    const start = Math.floor(seg.t)
    for (let s = 0; s < Math.ceil(span); s++) if (start + s < wps.length) wps[start + s] += words / Math.ceil(span)
  })
  return wps
}

export function planTranscription(loudness: number[], allLive: LiveSeg[], duration: number) {
  const live = allLive.filter(trusted)
  const dur = Math.max(duration, loudness.length)
  const speaking = speechMask(loudness)
  const speechSec = speaking.filter(Boolean).length
  const first = speaking.indexOf(true)
  const last = speaking.lastIndexOf(true)

  // No loudness data (older recordings) → transcribe everything.
  if (!loudness.length) return { ranges: [[0, dur]] as Range[], speechSec: dur, liveSec: 0 }
  // Looks silent. Don't trust the detector to skip everything: with no live text either,
  // send the whole thing once (a truly silent clip costs almost nothing).
  if (first < 0) return { ranges: (live.length ? [] : [[0, dur]]) as Range[], speechSec: 0, liveSec: 0 }

  const lo = Math.max(0, first - 2)
  const hi = Math.min(dur, last + 3)

  if (!live.length) return { ranges: [[lo, hi]] as Range[], speechSec, liveSec: 0 }

  const wps = wordsPerSecond(live, dur)
  const gaps: Range[] = []
  for (let w = Math.floor(lo); w < hi; w += WINDOW) {
    const end = Math.min(hi, w + WINDOW)
    let speech = 0
    let words = 0
    for (let s = w; s < end; s++) {
      if (speaking[s]) speech++
      words += wps[s] ?? 0
    }
    if (speech >= MIN_SPEECH_IN_WINDOW && words < speech * MIN_WORD_RATE) gaps.push([w, end])
  }

  // Merge neighbours, pad a little so words cut at the edges aren't lost.
  const merged: Range[] = []
  for (const [a, b] of gaps) {
    const prev = merged.at(-1)
    if (prev && a - prev[1] <= PAD * 2) prev[1] = b
    else merged.push([a, b])
  }
  const ranges = merged.map(([a, b]) => [Math.max(lo, a - PAD), Math.min(hi, b + PAD)] as Range)

  const gapSec = ranges.reduce((n, [a, b]) => n + (b - a), 0)
  // If the live transcript mostly failed, one clean pass is better than many fragments.
  if (gapSec > 0.7 * (hi - lo)) return { ranges: [[lo, hi]] as Range[], speechSec, liveSec: 0 }
  return { ranges, speechSec, liveSec: Math.max(0, hi - lo - gapSec) }
}

/** Split long ranges so each Gemini call stays fast and its output stays well under limits. */
export function chunkRanges(ranges: Range[], max = 1500): Range[] {
  const out: Range[] = []
  for (const [a, b] of ranges) for (let s = a; s < b; s += max) out.push([s, Math.min(b, s + max)])
  return out
}

/** Keep live text outside the gaps; Gemini's text replaces everything inside them. */
export function mergeTranscript(
  live: LiveSeg[],
  paid: { t: number; text: string }[],
  ranges: Range[],
) {
  const inGap = (t: number) => ranges.some(([a, b]) => t >= a && t < b)
  return [
    ...live.filter((s) => !inGap(s.t)).map((s) => ({ t: s.t, text: s.text, src: 'live' as const })),
    ...paid.map((s) => ({ ...s, src: 'gemini' as const })),
  ].sort((a, b) => a.t - b.t)
}
