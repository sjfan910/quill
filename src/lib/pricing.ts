import type { GenResponse } from './transport'
import { loadSettings } from './settings'
import type { Usage } from './types'

/**
 * ESTIMATED Gemini prices in USD per 1M tokens. These are deliberately on the high side
 * (from third-party trackers, not Google's official page), so the meter over-estimates
 * rather than under-estimates. Thinking tokens are billed as output. Cached input tokens
 * are assumed to get a 75% discount.
 */
type Rate = { text: number; audio: number; out: number }
const RATES: [RegExp, Rate][] = [
  [/flash-lite/, { text: 0.25, audio: 0.5, out: 1.5 }],
  [/flash/, { text: 0.5, audio: 1.0, out: 3.0 }],
  [/pro/, { text: 2.5, audio: 2.5, out: 15.0 }],
]
const FALLBACK: Rate = { text: 2.5, audio: 2.5, out: 15.0 }
const CACHED_FRACTION = 0.25

export const rateFor = (model: string) => RATES.find(([re]) => re.test(model))?.[1] ?? FALLBACK
export const isPro = (model: string) => /pro/.test(model)

export function usageOf(model: string, kind: Usage['kind'], res: GenResponse): Usage {
  const u = res.usageMetadata ?? {}
  const audioTokens = (u.promptTokensDetails ?? []).filter((d) => d.modality === 'AUDIO').reduce((n, d) => n + (d.tokenCount ?? 0), 0)
  const usage: Usage = {
    model,
    kind,
    promptTokens: u.promptTokenCount ?? 0,
    audioTokens,
    cachedTokens: u.cachedContentTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    thoughtsTokens: u.thoughtsTokenCount ?? 0,
  }
  usage.costUsd = costOf(usage)
  return usage
}

export function costOf(u: Usage) {
  const r = rateFor(u.model)
  const audio = u.audioTokens ?? 0
  const text = Math.max(0, u.promptTokens - audio)
  // Spread the cached discount proportionally over text and audio input.
  const cachedShare = u.promptTokens ? Math.min(1, u.cachedTokens / u.promptTokens) : 0
  const input = (text * r.text + audio * r.audio) * (1 - cachedShare * (1 - CACHED_FRACTION))
  const output = (u.outputTokens + u.thoughtsTokens) * r.out
  return (input + output) / 1e6
}

/** Rough cost of a job before running it, for the monthly cap check. */
export function estimate(job: { transcribeSec: number; transcribeModel: string; notesModel: string; transcriptWords: number }) {
  const t = rateFor(job.transcribeModel)
  const n = rateFor(job.notesModel)
  const transcribe = (job.transcribeSec * 32 * t.audio + job.transcribeSec * 4 * t.out) / 1e6
  const notesIn = job.transcriptWords * 1.4 + 4000
  const notes = (notesIn * n.text + 9000 * n.out) / 1e6
  return transcribe + notes
}

// ---------------------------------------------------------------- monthly spend (this device)

const KEY = 'quill.spend'
const month = () => new Date().toISOString().slice(0, 7)

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}

export function monthSpend() {
  return read()[month()] ?? 0
}

export function addSpend(usd: number) {
  const all = read()
  all[month()] = (all[month()] ?? 0) + usd
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(SPEND_EVENT))
}

export const SPEND_EVENT = 'quill-spend'

/** Signed in: replace this month's figure with the server's ledger total. */
export function syncSpend(serverTotalUsd: number) {
  const all = read()
  all[month()] = serverTotalUsd
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(SPEND_EVENT))
}

export function overCap(extra = 0) {
  const cap = loadSettings().monthlyCap
  return cap > 0 && monthSpend() + extra > cap
}

export const fmtUsd = (usd: number) =>
  usd > 0 && usd < 0.005 ? '<1¢' : usd < 0.995 ? `${Math.max(0, Math.round(usd * 100))}¢` : `$${usd.toFixed(2)}`
