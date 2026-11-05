/**
 * Notes are Markdown split into sections. A section = one heading line (#, ## or ###)
 * plus the text up to the next heading line. "Improve" asks Gemini for only the
 * sections it changes, and this module puts them back in place, so a small fix
 * doesn't pay for rewriting the whole page.
 */

export type Section = { heading: string | null; body: string }
export type SectionEdit = { heading: string; markdown: string; after?: string }

const HEADING = /^#{1,3}\s+\S/

/** Split while ignoring "#" lines inside fenced code and display math. */
export function splitSections(md: string): Section[] {
  const out: Section[] = [{ heading: null, body: '' }]
  let fence = false
  let math = false
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && (line.match(/\$\$/g)?.length ?? 0) % 2 === 1) math = !math
    if (!fence && !math && HEADING.test(line)) out.push({ heading: line.trim(), body: '' })
    else out[out.length - 1].body += line + '\n'
  }
  return out.filter((s, i) => i > 0 || s.body.trim())
}

export const joinSections = (secs: Section[]) =>
  secs
    .map((s) => (s.heading ? `${s.heading}\n${s.body}` : s.body))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'

/** Exact match first; then ignoring case, timestamps, emoji and punctuation. */
const exact = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase()
const loose = (h: string) =>
  h
    .toLowerCase()
    .replace(/\[(\d{1,2}:)?\d{1,2}:\d{2}\]/g, '')
    .replace(/[^a-z0-9]+/g, '')

function find(secs: Section[], heading: string) {
  let i = secs.findIndex((s) => s.heading && exact(s.heading) === exact(heading))
  if (i < 0) i = secs.findIndex((s) => s.heading && loose(s.heading) === loose(heading) && loose(heading).length > 0)
  return i
}

/** Apply edits; returns the new Markdown plus what happened (for tests / debugging). */
export function applySectionEdits(md: string, edits: SectionEdit[]) {
  const secs = splitSections(md)
  let replaced = 0
  let added = 0
  for (const e of edits) {
    if (!e.heading?.trim() || !e.markdown?.trim()) continue
    let text = e.markdown.trim()
    if (!HEADING.test(text.split('\n')[0])) text = `${e.heading.trim()}\n${text}`
    const [first, ...rest] = text.split('\n')
    const next: Section = { heading: first.trim(), body: rest.join('\n').replace(/\s*$/, '\n\n') }
    const i = find(secs, e.heading)
    if (i >= 0) {
      secs[i] = next
      replaced++
    } else {
      const after = e.after ? find(secs, e.after) : -1
      // default spot for new material: before the Key terms / To-do sections, else the end
      const tail = secs.findIndex((s) => s.heading && /key terms|to-?do|questions/i.test(s.heading))
      const at = after >= 0 ? after + 1 : tail >= 0 ? tail : secs.length
      secs.splice(at, 0, next)
      added++
    }
  }
  return { md: joinSections(secs), replaced, added }
}
