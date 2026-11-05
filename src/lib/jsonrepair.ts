/**
 * Gemini returns notes inside JSON, where "\" starts an escape. LaTeX is full of
 * backslashes, so a model that forgets to double one produces either invalid JSON
 * ("\underbrace", "\mathbb") or, worse, valid JSON that silently corrupts the math:
 *   "\frac" → form-feed + "rac", "\beta" → backspace + "eta", "\theta" → tab + "heta",
 *   "\rightarrow" → CR + "ightarrow", "\neq" → newline + "eq".
 * parseModelJson fixes both cases. When the model escapes correctly, nothing changes.
 */

/** Double any backslash that doesn't start a valid JSON escape (so "\m", "\underbrace" survive). */
function fixInvalidEscapes(text: string) {
  // Walk escapes as pairs, left to right, so an already-valid "\\" isn't split in two.
  return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt]|[\s\S])/g, (m, c: string) => (c.length > 1 || '"\\/bfnrt'.includes(c) ? m : `\\\\${c}`))
}

// Valid-but-wrong escapes, recognised by the LaTeX command they cut in half.
const AFTER_TAB = /\t(?=(heta|imes|ext|extbf|extit|extrm|o(?![a-z])|au(?![a-z])|ilde|frac|op(?![a-z])|riangle|herefore|ag\{|imes))/g
const AFTER_CR = /\r(?=(ightarrow|ight[)\]|.\\}]|ho(?![a-z])|angle|ceil|floor|vert|Vert|brace|brack|m(?![a-z])|ightharpoon))/g
const AFTER_LF_IN_MATH =
  /\n(?=(eq(?![a-z])|e(?![a-z])|abla|u(?![a-z])|ot(?![a-z])|otin|mid|leq|geq|ewline|eg(?![a-z])|exists|i(?![a-z])|subseteq|supseteq|parallel|sim|cong|vdash|prec|succ|eq(?![a-z])))/g

export function repairLatex(s: string) {
  if (!/[\x08\x0c\t\r\n]/.test(s)) return s
  let out = s
    .replace(/\x0c/g, '\\f') // form feed never appears in notes on purpose
    .replace(/\x08/g, '\\b') // nor does backspace
    .replace(AFTER_TAB, '\\t')
    .replace(AFTER_CR, '\\r')
  // A real line break followed by "eq" or "ot" is normal prose; only repair inside math.
  out = out.replace(/\$\$[\s\S]*?\$\$|\$[^$]*?\$/g, (m) => m.replace(AFTER_LF_IN_MATH, '\\n'))
  return out
}

function deepRepair<T>(v: T): T {
  if (typeof v === 'string') return repairLatex(v) as T
  if (Array.isArray(v)) return v.map(deepRepair) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRepair(x)])) as T
  return v
}

export function parseModelJson<T>(text: string): T {
  let data: T
  try {
    data = JSON.parse(text) as T
  } catch {
    data = JSON.parse(fixInvalidEscapes(text)) as T
  }
  return deepRepair(data)
}
