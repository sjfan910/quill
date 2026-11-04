export const DEFAULT_STYLE = `• Visual and scannable first. I should get the lecture in 30 seconds by skimming.
• Short bullets, never paragraphs. One idea per bullet, max ~15 words.
• Use symbols to show relationships:
  → leads to / causes     ⇒ therefore     ↔ related / compare     ≠ is not / common confusion
  ⚠️ warning / common mistake     💡 insight / intuition     📌 definition     🧪 example
  ⭐ lecturer emphasized it     🎯 likely exam material     ❓ unclear / ask about
• **Bold** every key term the first time it appears.
• Use tables for comparisons (A vs B) and for definitions.
• For CS: put code, pseudocode and formulas in code blocks; show a tiny worked example when a concept is abstract.
• Plain English. Explain like a smart TA, not a textbook.`

export type Settings = {
  apiKey: string
  model: string
  style: string
  googleClientId: string
  /** Durable preferences learned from Improve feedback ("memory about you"). */
  prefs: string[]
}

const KEY = 'quill.settings'
const defaults: Settings = {
  apiKey: '',
  model: 'gemini-flash-latest',
  style: DEFAULT_STYLE,
  googleClientId: '',
  prefs: [],
}

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
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...defaults }
  }
}
export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
