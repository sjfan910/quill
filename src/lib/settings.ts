export const DEFAULT_STYLE = `• Visual and scannable first. I should get the lecture in 30 seconds by skimming.
• Short bullets, never paragraphs. One idea per bullet, max ~15 words.
• Use symbols to show relationships:
  → leads to / causes     ⇒ therefore     ↔ related / compare     ≠ is not / common confusion
  ⚠️ warning / common mistake     💡 insight / intuition     📌 definition     🧪 example
  ⭐ lecturer emphasized it     🎯 likely exam material     ❓ unclear / ask about
• **Bold** every key term the first time it appears.
• Use tables for comparisons (A vs B) and for definitions.
• Math looks like worked solutions: LaTeX for every formula, step-by-step aligned derivations, definition/theorem/proof blocks.
• For CS: put code and pseudocode in code blocks; show a tiny worked example when a concept is abstract.
• Plain English. Explain like a smart TA, not a textbook.`

export type Settings = {
  apiKey: string
  model: string
  style: string
  googleClientId: string
  /** Durable preferences learned from Improve feedback ("memory about you"). */
  prefs: string[]
  /** Free on-device live transcription while recording (experimental). */
  liveTranscribe: boolean
  /** Cheap model used to transcribe the parts the live transcript missed. */
  transcribeModel: string
  /** Monthly spending cap in USD (estimated). */
  monthlyCap: number
  /** True once the user has set the cap themselves (protects it from default changes). */
  capCustomized?: boolean
}

const KEY = 'quill.settings'
const defaults: Settings = {
  apiKey: '',
  model: 'gemini-flash-latest',
  style: DEFAULT_STYLE,
  googleClientId: '',
  prefs: [],
  liveTranscribe: true,
  transcribeModel: 'gemini-flash-lite-latest',
  monthlyCap: 2,
}

import { markSettingsDirty } from './dirty'

export const MAX_PREFS = 15

/** Merge newly learned preferences, de-duplicated, newest kept, capped. */
export function addPrefs(learned: string[]) {
  const s = loadSettings()
  const seen = new Set(s.prefs.map((p) => p.toLowerCase().trim()))
  const fresh = learned.map((p) => p.trim()).filter((p) => p && p.length < 200 && !seen.has(p.toLowerCase()))
  if (!fresh.length) return []
  saveSettings({ ...s, prefs: [...s.prefs, ...fresh].slice(-MAX_PREFS) })
  return fresh
}

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>
    // The default cap used to be $5. Anyone still on that untouched default moves to the new one.
    if (saved.monthlyCap === 5 && !saved.capCustomized) saved.monthlyCap = defaults.monthlyCap
    return { ...defaults, ...saved }
  } catch {
    return { ...defaults }
  }
}
export function saveSettings(s: Settings, opts: { fromServer?: boolean } = {}) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
  if (!opts.fromServer) markSettingsDirty()
  window.dispatchEvent(new Event(SETTINGS_EVENT))
}

export const SETTINGS_EVENT = 'quill-settings'

/** Settings that follow your account. The API key and Google client ID stay on each device. */
export const SYNCED_SETTINGS = ['model', 'style', 'prefs', 'liveTranscribe', 'transcribeModel', 'monthlyCap', 'capCustomized'] as const
