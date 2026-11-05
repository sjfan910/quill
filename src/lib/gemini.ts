import { findOrCreateCourse, getAudio, getBlob, getCourse, getLecture, listCourses, nextLectureNumber, patchLecture, saveCourse } from './db'
import { chunkRanges, mergeTranscript, planTranscription } from './gaps'
import { applySectionEdits, type SectionEdit } from './sections'
import { addSpend, estimate, fmtUsd, isPro, monthSpend, overCap, syncSpend, usageOf } from './pricing'
import { addPrefs, loadSettings } from './settings'
import type { Course, HistoryEntry, Lecture, TranscriptSeg, Usage } from './types'
import {
  ThinkingLevel,
  Type,
  createPartFromUri,
  generateContent,
  getFile,
  listModels as listModelsRaw,
  textOf,
  uploadFile,
  type Part,
  type ThinkingConfig,
} from './transport'
import { fmtTime, parseTime } from './util'

export async function listModels() {
  const out: string[] = []
  for (const m of await listModelsRaw()) {
    const name = (m.name ?? '').replace(/^models\//, '')
    if (!name.startsWith('gemini')) continue
    if (!m.supportedGenerationMethods?.includes('generateContent')) continue
    if (/(image|tts|live|audio|embedding|robotics|computer)/.test(name)) continue
    out.push(name)
  }
  return out.sort().reverse()
}

// ---------------------------------------------------------------- uploads

async function uploadAndWait(blob: Blob, mimeType: string, displayName: string) {
  let f = await uploadFile(blob, mimeType, displayName)
  for (let i = 0; i < 120 && f.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    f = await getFile(f.name)
  }
  if (f.state === 'FAILED') throw new Error(`Gemini could not process ${displayName}.`)
  return f
}

// ---------------------------------------------------------------- output schema

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    courseCode: { type: Type.STRING, description: 'e.g. "CS 2050". "UNSORTED" if unknown.' },
    courseName: { type: Type.STRING, description: 'Course name, short. Empty if unknown.' },
    lectureTitle: { type: Type.STRING, description: 'Topic of this lecture, 2-6 words, no course code or lecture number.' },
    summary: { type: Type.STRING, description: 'One sentence: what this lecture was about.' },
    notesMarkdown: { type: Type.STRING },
    mindmapMarkdown: { type: Type.STRING },
    courseMemory: { type: Type.STRING, description: 'The full, rewritten memory for this lecture\'s course. Empty if courseCode is UNSORTED.' },
    learnedPreferences: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Durable preferences learned from the student\'s feedback. Usually empty.',
    },
  },
  required: ['courseCode', 'courseName', 'lectureTitle', 'summary', 'notesMarkdown', 'mindmapMarkdown', 'courseMemory', 'learnedPreferences'],
  propertyOrdering: ['courseCode', 'courseName', 'lectureTitle', 'summary', 'notesMarkdown', 'mindmapMarkdown', 'courseMemory', 'learnedPreferences'],
}

type Result = {
  courseCode: string
  courseName: string
  lectureTitle: string
  summary: string
  notesMarkdown: string
  mindmapMarkdown: string
  courseMemory: string
  learnedPreferences: string[]
}

// ---------------------------------------------------------------- prompt
//
// Cost note: Gemini gives an automatic discount (implicit caching) when a request starts
// with the same tokens as a recent one. So the request is ordered from most stable to
// least stable: system prompt (fixed) → transcript → memory, marks, feedback.
// Notes never include audio: audio is only sent once, for the parts the free transcript missed.

const MEMORY_WORDS = 350

function systemPrompt(style: string) {
  return `You are Quill, the personal lecture note-taker of a Georgia Tech computer science sophomore.
You receive the timestamped transcript of a university lecture (plus, sometimes, slides, the student's live marks and Quill's memory) and produce the notes the student will study from. They must never need to rewrite them.

## Goals
1. Capture ALL substantive content: every concept, definition, example, argument, formula, algorithm and caveat. Comprehensive, but zero filler.
2. Make it obvious what matters: what the lecturer emphasized, repeated, wrote down, or said would be on an exam/homework.
3. Pull out anything the student must DO: readings, assignments, deadlines, exam dates, office hours, announcements.
4. Be honest: never invent content. The transcript is machine-made: silently fix obviously misheard words using context, the slides and the course glossary; if the meaning is genuinely unclear, write your best guess followed by (?). Ignore small talk and chatter unless it matters.

## Who to listen to
- The lecturer is the primary voice: the most continuous speaker, explaining material. Their content is the backbone of the notes. Lines starting "Q:"/"A:" are student questions and the lecturer's answers.
- Student questions and class discussion matter when the lecturer engages with them: capture the question briefly ("Q from class: …") and the lecturer's answer. During discussion sections, capture the main points raised and any conclusion the lecturer draws.
- Ignore side conversations near the recorder, chatter before class starts and after it ends, phone/notification sounds, and off-topic remarks. Never put private conversation into the notes.
- If a stretch is marked [inaudible] or doesn't make sense, say so once in ❓ with the timestamp range instead of guessing.

## The student's personal formatting style (follow it closely)
${style}

## notesMarkdown: use exactly this structure (GitHub-flavored Markdown)
# <Lecture title>
> **TL;DR:** 2-3 short lines capturing the whole lecture.

## 🎯 Focus on this
3-7 bullets: the most important / most testable ideas. Include every moment the student starred (⭐) and explain why it matters.

## 🗺️ Big picture
How the ideas connect, as a short arrow chain or 3-5 bullets. Use the course memory to link to earlier lectures ("builds on L3: …") when relevant.

## 📚 Notes
One "###" section per topic, in lecture order. Start each section heading with the timestamp where it begins, like "### [12:34] Topic". Inside: concise bullets, nested where useful, tables for comparisons, code blocks for code/pseudocode, LaTeX for all math, 🧪 worked examples.

## 🔑 Key terms
| Term | Meaning |  (every important term, one line each; reuse the course glossary's wording for terms already defined)

## ✅ To-do
- [ ] task — due date if mentioned. If nothing was assigned, write "- Nothing assigned this lecture."

## ❓ Questions / unclear
Things that were confusing, contradictory or worth asking the professor or TA about. Include the student's own typed questions.

Timestamps: write them as [mm:ss] (or [h:mm:ss] past one hour), measured from the start of the recording; reuse the transcript's timestamps. Add a timestamp to every "###" heading, and inline wherever pointing back to the audio would help.
## Math: write it like worked solutions, in LaTeX (the app typesets it)
- Every formula, symbol, variable, set, sum, probability, complexity bound or equation is LaTeX: inline $...$ (e.g. $\Pr[X = k] = \frac{\lambda^k e^{-\lambda}}{k!}$, $O(n \log n)$, $\forall x \in S$), display $$...$$ on its own line for anything important.
- Derivations and worked examples are step-by-step aligned blocks, one step per line, with a short reason after each step:
  $$\begin{aligned} \sum_{v \in V} \deg(v) &= \sum_{e \in E} 2 && \text{each edge has 2 endpoints} \\ &= 2|E| \end{aligned}$$
- Definitions, theorems, lemmas and proofs read like a textbook: "> **📌 Definition (Tree).** A connected graph with no cycles." / "> **Theorem.** …" then "**Proof.** …" with steps, ending with $\blacksquare$.
- Use LaTeX inside tables too. Never put math in code blocks; code blocks are for actual code and pseudocode only.
- Write dollar amounts as "USD 5" or "5 dollars", never "$5", so they aren't mistaken for math.

## mindmapMarkdown: a mind map of the lecture (rendered with markmap)
- First line "# <short lecture title>".
- 4-7 main branches as "## <emoji> <label>", each with nested "- " bullets up to 2 levels deep.
- Labels are 1-6 words: keywords, not sentences. Show relationships with → where useful.
- Cover the whole lecture; make the structure reveal how ideas connect. Plain text only: no HTML, no LaTeX (write x^2, Σ, ≤ as plain symbols).

## Course detection
Pick the course this lecture belongs to. If it clearly matches one of the student's known courses, return that course's exact code and name. Otherwise infer it from what is said (Georgia Tech codes look like "CS 2050", "MATH 1554", "INTA 2050"). If you can't tell, return courseCode "UNSORTED".

## Memory
Quill keeps a short memory per course and a list of the student's standing preferences. Use them, and keep them up to date.

### Using memory
- Standing preferences override the default style when they conflict.
- Use the course memory for continuity: consistent terminology and spelling of course-specific names, links to earlier lectures, the professor's emphasis cues, deadlines that are now closer.

### courseMemory (always return it unless courseCode is UNSORTED)
Return the COMPLETE rewritten memory for this lecture's course: the previous memory merged with what this lecture adds. Hard limit: ${MEMORY_WORDS} words. Markdown, exactly these sections:
## Lectures
One bullet per lecture, oldest first: "- L<n> · <title>: <core idea, ≤12 words>". Never drop a lecture; when space is tight, shorten older lines. If this lecture is already listed (re-processing), update its line instead of adding a new one.
## Glossary
"- term: meaning (≤10 words)". Keep the ~25 most important course terms.
## Professor
Teaching habits, emphasis cues ("says 'key point' before exam material"), exam/grading hints.
## Deadlines
Upcoming only, with dates. Drop anything already past relative to today's date.
## Threads
Open questions and topics announced for next time.
Every section is a "- " bullet list (write "- none" if empty). Compress, don't grow: merge duplicates, drop trivia, prefer keywords to sentences.

### learnedPreferences
Only when the student gave feedback: list durable preferences that should apply to ALL future lectures (e.g. "Keep bullets under 10 words", "Always show a worked example for proofs"). Phrase each as a short instruction. Return [] when the feedback only concerns this lecture's content, or when there was no feedback. Don't repeat existing standing preferences.`
}

function marksText(l: Lecture) {
  if (!l.marks.length) return 'The student made no live marks.'
  return (
    'Live marks the student made while recording (timestamps relative to audio start):\n' +
    l.marks
      .map((m) => (m.kind === 'star' ? `- [${fmtTime(m.t)}] ⭐ starred: this moment is important` : `- [${fmtTime(m.t)}] typed note: "${m.text}"`))
      .join('\n') +
    '\nWork the typed notes into the right sections (questions go under ❓, tasks under ✅, insights inline, marked "(my note)").'
  )
}

function memoryText(courses: Course[], fixed: Course | undefined, number: number | undefined, prefs: string[]) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
  const out: string[] = [`Today's date: ${today}.`]
  out.push(
    prefs.length ? `## Standing preferences (follow strictly)\n${prefs.map((p) => `- ${p}`).join('\n')}` : '## Standing preferences\n(none yet)',
  )
  if (fixed) {
    out.push(`## Course\nThis lecture is from ${fixed.code}${fixed.name ? ` (${fixed.name})` : ''}${number ? `, lecture ${number}` : ''}. Return exactly that course code and name.`)
    out.push(`## Course memory for ${fixed.code}\n${fixed.memory?.trim() || '(empty: this is the first lecture Quill has seen for this course)'}`)
  } else if (courses.length) {
    out.push(
      "## The student's known courses and their memories\nDetect which course this lecture belongs to, then update that course's memory. If it's a new course, start a fresh memory.\n\n" +
        courses
          .slice(0, 10)
          .map((c) => `### ${c.code}${c.name ? `: ${c.name}` : ''}\n${c.memory?.trim() || '(no memory yet)'}`)
          .join('\n\n'),
    )
  } else {
    out.push('## Courses\nThe student has no saved courses yet. If you detect the course, start its memory from this lecture.')
  }
  return out.join('\n\n')
}

// ---------------------------------------------------------------- slides: read once, reuse as text

const SLIDES_SCHEMA = { type: Type.OBJECT, properties: { markdown: { type: Type.STRING } }, required: ['markdown'] }
const SLIDES_PROMPT = `You convert lecture slides into compact Markdown for a student's note-taking app.
- For each slide, in order: "### Slide <n>: <title>" then terse bullets with all of its text content.
- All math as LaTeX ($...$ inline, $$...$$ display). Code as code blocks.
- Describe each diagram, chart or figure in one line ("Diagram: …").
- Skip logos, footers, page numbers and purely decorative text.`

/**
 * Slides are sent to Gemini once (cheapest model) and kept as text on the lecture. Every
 * later Improve/remake reuses that text instead of re-uploading and re-reading the files.
 * Re-reads only when the set of slide files changes.
 */
async function ensureSlidesText(id: string, step: Progress, meta: Meta) {
  const l = (await getLecture(id))!
  if (!l.slides.length) return l.slidesText
  const key = l.slides.map((s) => s.key).join('|')
  if (l.slidesText && l.slidesTextKey === key) return l.slidesText
  const parts: Part[] = []
  for (const s of l.slides) {
    const blob = await getBlob(s.key)
    if (!blob) continue // slide files live on the device they were added on
    step('Reading your slides (once)…')
    const f = await uploadAndWait(blob, s.type, s.name)
    parts.push(createPartFromUri(f.uri!, f.mimeType ?? s.type))
  }
  if (!parts.length) return l.slidesText
  parts.push({ text: `${parts.length} slide file(s) above.` })
  const model = loadSettings().transcribeModel || 'gemini-flash-lite-latest'
  const { data, usages } = await callJson<{ markdown: string }>(model, 'slides', parts, SLIDES_PROMPT, SLIDES_SCHEMA, 'minimal', 16384, meta)
  const text = (data.markdown ?? '').trim()
  const now = (await getLecture(id))!
  await patchLecture(id, {
    slidesText: text,
    slidesTextKey: key,
    history: [...now.history, ...usages.map((usage) => ({ at: Date.now(), kind: 'slides' as const, slides: l.slides.map((s) => s.name), usage }))],
  })
  return text
}

// ---------------------------------------------------------------- Improve: change only what the feedback is about

const IMPROVE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    scope: { type: Type.STRING, enum: ['sections', 'all'] },
    edits: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING, description: 'Existing heading line copied exactly, or a new heading line.' },
          markdown: { type: Type.STRING, description: 'The complete new section, starting with its heading line.' },
          after: { type: Type.STRING, description: 'For a NEW section: the existing heading line it follows. Otherwise "".' },
        },
        required: ['heading', 'markdown', 'after'],
        propertyOrdering: ['heading', 'markdown', 'after'],
      },
    },
    notesMarkdown: { type: Type.STRING, description: 'Only when scope is "all": the complete revised notes. Otherwise "".' },
    mindmapMarkdown: { type: Type.STRING, description: '"" to keep the current mind map.' },
    learnedPreferences: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['scope', 'edits', 'notesMarkdown', 'mindmapMarkdown', 'learnedPreferences'],
  propertyOrdering: ['scope', 'edits', 'notesMarkdown', 'mindmapMarkdown', 'learnedPreferences'],
}
type ImproveResult = { scope: 'sections' | 'all'; edits: SectionEdit[]; notesMarkdown: string; mindmapMarkdown: string; learnedPreferences: string[] }

const editInstructions = (feedback: string) => `The student's feedback on the current notes:
"""${feedback}"""

Change ONLY what the feedback asks for; keep everything else word for word. Reply in the edit format:
- The notes are made of sections. A section is one heading line ("#", "##" or "###") plus the text up to the next heading line.
- If the feedback concerns particular parts, set scope "sections" and put each changed section in "edits": "heading" = that section's heading line copied EXACTLY from the current notes (or a new heading line for a new section), "markdown" = the complete new section starting with its heading line, "after" = for a new section, the existing heading line it should follow (else ""). Leave notesMarkdown "".
- Only if the feedback genuinely changes the whole document (e.g. "make everything shorter", a different overall structure), set scope "all", put the complete revised notes in notesMarkdown and leave edits [].
- mindmapMarkdown: "" unless the change alters the lecture's structure.
- Course memory is not needed for this edit. Decide whether the feedback reveals a durable preference (learnedPreferences).`

// ---------------------------------------------------------------- model calls
//
// Thinking tokens are billed like output tokens. Gemini 2.x takes a token budget; Gemini 3+
// takes a level. Unknown aliases try the level first and fall back if the API rejects it.

type Effort = 'minimal' | 'low'

function thinkingOptions(model: string, effort: Effort): (ThinkingConfig | undefined)[] {
  if (/gemini-2\.[05]/.test(model)) {
    const budget = effort === 'minimal' ? (/pro/.test(model) ? 128 : 0) : 1024
    return [{ thinkingBudget: budget }, undefined]
  }
  const level = effort === 'minimal' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW
  return [{ thinkingLevel: level }, { thinkingBudget: effort === 'minimal' ? 0 : 1024 }, undefined]
}

type Meta = { lectureId?: string; overCapOk?: boolean }

async function callOnce(model: string, kind: 'transcribe' | 'notes' | 'slides', parts: Part[], system: string, schema: object, effort: Effort, maxOutputTokens: number, meta: Meta) {
  let lastErr: unknown
  for (const thinkingConfig of thinkingOptions(model, effort)) {
    try {
      return await generateContent(
        model,
        {
          contents: [{ role: 'user', parts }],
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0.3,
            maxOutputTokens,
            ...(thinkingConfig ? { thinkingConfig } : {}),
          },
        },
        { kind, ...meta },
      )
    } catch (e) {
      lastErr = e
      // Only retry when the model rejected the thinking setting; anything else is a real error.
      if (!(e instanceof Error && /thinking/i.test(e.message))) throw e
    }
  }
  throw lastErr
}

/**
 * One JSON call with exactly one retry if the reply is cut off or isn't valid JSON.
 * Every attempt's usage is returned so the cost meter stays honest.
 */
async function callJson<T>(
  model: string,
  kind: 'transcribe' | 'notes' | 'slides',
  parts: Part[],
  system: string,
  schema: object,
  effort: Effort,
  maxOutputTokens: number,
  meta: Meta = {},
): Promise<{ data: T; usages: Usage[] }> {
  const usages: Usage[] = []
  let attempt = parts
  for (let i = 0; i < 2; i++) {
    const { res, monthSpend: serverSpend } = await callOnce(model, kind, attempt, system, schema, effort, maxOutputTokens, meta)
    const usage = usageOf(model, kind, res)
    usages.push(usage)
    // Signed in: the server's ledger is the truth. Otherwise count it on this device.
    if (serverSpend !== undefined) syncSpend(serverSpend)
    else addSpend(usage.costUsd ?? 0)
    const reason = res.candidates?.[0]?.finishReason
    const text = textOf(res)
    try {
      if (!text) throw new Error('empty')
      return { data: JSON.parse(text) as T, usages }
    } catch {
      if (i === 1) throw new Error(`Gemini's reply was ${reason === 'MAX_TOKENS' ? 'cut off' : 'unreadable'} twice. Try again, or pick another model in Settings.`)
      attempt = [
        ...parts,
        { text: 'IMPORTANT: your previous reply was cut off or was not valid JSON. Reply again as complete, valid JSON. Be more concise if needed.' },
      ]
    }
  }
  throw new Error('unreachable')
}

// ---------------------------------------------------------------- pass 1: transcript

const TRANSCRIPT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          t: { type: Type.STRING, description: 'Start time "mm:ss" relative to the start of THIS clip.' },
          text: { type: Type.STRING },
        },
        required: ['t', 'text'],
        propertyOrdering: ['t', 'text'],
      },
    },
  },
  required: ['segments'],
}

const TRANSCRIBE_PROMPT = `You transcribe university lecture audio for a student's note-taking app.
- Clean verbatim: keep every substantive word; drop filler ("um", "uh", false starts).
- One segment per paragraph (roughly every 15-40 seconds, or at a change of speaker or topic). t = when the segment starts, relative to the start of this clip.
- The lecturer is the main speaker. Prefix student questions with "Q: " and the lecturer's reply with "A: ".
- Skip side conversations near the microphone, pre-/post-class chatter and noise. Never transcribe private conversation.
- Spell technical terms, code identifiers and names correctly. If a stretch is unintelligible write "[inaudible]".`

const MP3_BYTES_PER_SEC = 4000 // 32 kbps CBR
const MP3_FRAME = 288 // 16 kHz MPEG-2 Layer III frame at 32 kbps

function sliceMp3(audio: Blob, a: number, b: number) {
  const at = (s: number) => Math.floor((s * MP3_BYTES_PER_SEC) / MP3_FRAME) * MP3_FRAME
  return audio.slice(at(a), Math.min(audio.size, at(b) + MP3_FRAME), 'audio/mpeg')
}

async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function audioPart(clip: Blob, name: string): Promise<Part> {
  // Small clips go inline (one request); big ones through the Files API.
  // Inline when small (and under the ~4.5 MB server request limit once base64'd); else Files API.
  if (clip.size < 2_500_000) return { inlineData: { mimeType: 'audio/mpeg', data: await toBase64(clip) } }
  const f = await uploadAndWait(clip, 'audio/mpeg', name)
  return createPartFromUri(f.uri!, 'audio/mpeg')
}

/** Builds the transcript once: free live text + Gemini only for the gaps. */
/** Free live text is used unless the user asked for an accurate (Gemini-only) transcript. */
const liveFor = (l: Lecture, accurate: boolean) => (accurate ? [] : (l.live ?? []))

async function ensureTranscript(id: string, step: Progress, accurate: boolean, meta: Meta) {
  let l = (await getLecture(id))!
  if (l.transcript?.length) return l.transcript

  const plan = planTranscription(l.loudness ?? [], liveFor(l, accurate), l.durationSec)
  const model = loadSettings().transcribeModel || 'gemini-flash-lite-latest'
  const chunks = chunkRanges(plan.ranges)
  const paid: { t: number; text: string }[] = []
  const history: HistoryEntry[] = []
  if (chunks.length) {
    const audio = await getAudio(id)
    if (!audio.size) throw new Error('No audio was saved for this lecture.')
    let done = 0
    for (const [a, b] of chunks) {
      step(plan.liveSec > 0 ? `Filling gaps in the free transcript… ${++done}/${chunks.length}` : `Transcribing… ${++done}/${chunks.length}`)
      const part = await audioPart(sliceMp3(audio, a, b), `quill-${id}-${Math.round(a)}.mp3`)
      const { data, usages } = await callJson<{ segments: { t: string; text: string }[] }>(
        model,
        'transcribe',
        [part, { text: `This clip is ${fmtTime(b - a)} long.` }],
        TRANSCRIBE_PROMPT,
        TRANSCRIPT_SCHEMA,
        'minimal',
        24576,
        meta,
      )
      for (const s of data.segments ?? []) {
        const rel = parseTime(String(s.t).replace(/[[\]]/g, ''))
        if (s.text?.trim()) paid.push({ t: Math.round((a + (Number.isFinite(rel) ? rel : 0)) * 10) / 10, text: s.text.trim() })
      }
      usages.forEach((usage) => history.push({ at: Date.now(), kind: 'transcribe', usage, paidSec: Math.round(b - a) }))
    }
  }
  const transcript = mergeTranscript(liveFor(l, accurate), paid, plan.ranges)
  const paidSec = plan.ranges.reduce((n, [a, b]) => n + (b - a), 0)
  l = (await getLecture(id))!
  await patchLecture(id, {
    transcript,
    transcriptStats: { liveSec: Math.round(plan.liveSec), paidSec: Math.round(paidSec), speechSec: plan.speechSec },
    history: [...l.history, ...history],
  })
  return transcript
}

/** Compact "[mm:ss] text" paragraphs (~30 s each) to keep the notes prompt small. */
function transcriptText(segs: TranscriptSeg[]) {
  const out: string[] = []
  let cur: { t: number; parts: string[] } | null = null
  for (const s of segs) {
    if (!cur || s.t - cur.t > 30 || /^(Q|A):/.test(s.text)) {
      if (cur) out.push(`[${fmtTime(cur.t)}] ${cur.parts.join(' ')}`)
      cur = { t: s.t, parts: [] }
    }
    cur.parts.push(s.text)
  }
  if (cur) out.push(`[${fmtTime(cur.t)}] ${cur.parts.join(' ')}`)
  return out.join('\n')
}

export type Progress = (step: string) => void

// ---------------------------------------------------------------- main entry points

const running = new Map<string, Promise<void>>()
export const isRunning = (id: string) => running.has(id)

type RunOpts = { feedback?: string; manual?: boolean; retranscribe?: boolean; confirmed?: boolean; onProgress?: Progress; onLearned?: (prefs: string[]) => void }

/** Generate (or refine) notes for a lecture. Safe to call from any screen. */
export function processLecture(id: string, opts: RunOpts = {}) {
  const existing = running.get(id)
  if (existing) return existing
  const p = run(id, opts).finally(() => running.delete(id))
  running.set(id, p)
  return p
}

/** Monthly cap + Pro guard. Auto-runs never overspend; manual runs ask first. */
async function guard(l: Lecture, manual: boolean, retranscribe: boolean, accurate: boolean) {
  const s = loadSettings()
  const needsTranscript = !l.transcript?.length || retranscribe
  const plan = needsTranscript ? planTranscription(l.loudness ?? [], liveFor(l, accurate), l.durationSec) : { ranges: [] }
  const transcribeSec = plan.ranges.reduce((n, [a, b]) => n + (b - a), 0)
  const words = l.transcript ? l.transcript.reduce((n, x) => n + x.text.split(/\s+/).length, 0) : l.durationSec * 2.3
  const est = estimate({ transcribeSec, transcribeModel: s.transcribeModel, notesModel: s.model, transcriptWords: words })

  if (isPro(s.model)) {
    if (!manual) return 'Pro model selected. Tap "Make notes" to confirm the higher cost.'
    if (!confirm(`Pro costs roughly 5× more than Flash. This run ≈ ${fmtUsd(est)}. Continue?`)) return 'cancelled'
  }
  if (overCap(est)) {
    const msg = `Monthly cap: ${fmtUsd(monthSpend())} of $${s.monthlyCap} used.`
    if (!manual) return `${msg} Tap "Make notes" to go over it.`
    if (!confirm(`${msg} This run ≈ ${fmtUsd(est)} would go over. Continue anyway?`)) return 'cancelled'
  }
  return null
}

async function run(id: string, { feedback, manual = false, retranscribe = false, confirmed = false, onProgress, onLearned }: RunOpts) {
  const step = (s: string) => onProgress?.(s)
  let l = await getLecture(id)
  if (!l) return
  const accurate = retranscribe || !loadSettings().liveTranscribe
  const blocked = confirmed ? null : await guard(l, manual, retranscribe, accurate)
  if (blocked) {
    if (blocked !== 'cancelled') await patchLecture(id, { status: l.notesMd ? 'ready' : 'saved', error: blocked })
    return
  }
  const refining = !retranscribe && !!l.notesMd && (!!feedback || l.slides.length > 0)
  await patchLecture(id, { status: 'processing', error: undefined, ...(retranscribe ? { transcript: undefined, transcriptStats: undefined } : {}) })
  try {
    const settings = loadSettings()
    const model = settings.model || 'gemini-flash-latest'

    // Pass 1 — transcript (free live text; Gemini only for the gaps). Done once per lecture.
    const meta: Meta = { lectureId: id, overCapOk: manual }
    const transcript = await ensureTranscript(id, step, accurate, meta)
    if (!transcript.length) throw new Error("Quill couldn't hear any speech in this recording.")

    const slidesText = await ensureSlidesText(id, step, meta)
    l = (await getLecture(id))!
    const editing = refining && !!feedback && !!l.notesMd

    const courses = await listCourses()
    const fixed = l.courseId ? await getCourse(l.courseId) : undefined
    const number = fixed ? (l.number ?? (await nextLectureNumber(fixed.id, id))) : undefined

    // Pass 2 — notes from TEXT. Ordered stable → variable for implicit caching:
    // system prompt (fixed) → transcript (fixed per lecture) → slides → memory, marks, feedback.
    const parts: Part[] = [
      {
        text: `Lecture transcript (${fmtTime(l.durationSec)} recording; machine transcription, may contain misheard words):\n\n${transcriptText(transcript)}`,
      },
    ]
    if (slidesText) {
      parts.push({
        text: `Lecture slides (text extracted from the deck):\n\n${slidesText}\n\nUse the slides to fix terminology and spelling, fill in formulas, diagrams-in-words and details the transcript missed, and align the section structure with them. The transcript remains the source of truth for what the lecturer emphasized.`,
      })
    }
    parts.push({ text: memoryText(courses, fixed, number, settings.prefs) })
    parts.push({ text: marksText(l) })
    if (refining && l.notesMd) {
      parts.push({ text: `Current version of the notes:\n\n${l.notesMd}` })
      parts.push({
        text: editing
          ? editInstructions(feedback!)
          : 'Revise and improve the current notes using the slides. There is no feedback, so learnedPreferences must be [].',
      })
    } else {
      parts.push({ text: 'There is no feedback yet, so learnedPreferences must be [].' })
    }

    step(editing ? 'Editing your notes…' : refining ? 'Refining notes…' : 'Writing your notes…')
    let r: Result
    let usages: Usage[]
    if (editing) {
      const out = await callJson<ImproveResult>(model, 'notes', parts, systemPrompt(settings.style), IMPROVE_SCHEMA, 'low', 32768, meta)
      usages = out.usages
      const e = out.data
      let notes: string
      // A full rewrite is accepted whenever that's what came back (scope "all", or no edits at all).
      if (e.notesMarkdown?.trim() && (e.scope === 'all' || !e.edits?.length)) notes = e.notesMarkdown
      else {
        const applied = applySectionEdits(l.notesMd!, e.edits ?? [])
        if (!applied.replaced && !applied.added) throw new Error('Gemini made no changes. Try wording the feedback differently.')
        notes = applied.md
      }
      r = {
        courseCode: '',
        courseName: '',
        lectureTitle: l.title,
        summary: l.summary ?? '',
        notesMarkdown: notes,
        mindmapMarkdown: e.mindmapMarkdown?.trim() || l.mindmapMd || '',
        courseMemory: '', // unchanged by an edit
        learnedPreferences: e.learnedPreferences ?? [],
      }
    } else {
      const out = await callJson<Result>(model, 'notes', parts, systemPrompt(settings.style), SCHEMA, 'low', 32768, meta)
      r = out.data
      usages = out.usages
    }

    step('Filing it in your library…')
    l = (await getLecture(id))!
    let courseId = l.courseId
    let num = l.number
    if (!courseId && r.courseCode && r.courseCode.toUpperCase() !== 'UNSORTED') {
      courseId = (await findOrCreateCourse(r.courseCode, r.courseName)).id
    }
    if (courseId && !num) num = await nextLectureNumber(courseId, id)

    // Course memory: trust it only if it looks like a real memory, never let it balloon.
    if (courseId && r.courseMemory?.trim()) {
      const c = await getCourse(courseId)
      const mem = clampWords(r.courseMemory.trim(), MEMORY_WORDS * 1.5)
      if (c && mem.includes('## Lectures')) await saveCourse({ ...c, memory: mem, memoryUpdatedAt: Date.now() })
    }

    // Memory about you: only learned from explicit feedback.
    const learned = feedback ? addPrefs(r.learnedPreferences ?? []) : []
    if (learned.length) onLearned?.(learned)

    await patchLecture(id, {
      status: 'ready',
      courseId,
      number: num,
      title: r.lectureTitle || l.title,
      summary: r.summary,
      notesMd: r.notesMarkdown,
      mindmapMd: r.mindmapMarkdown,
      history: [
        ...l.history,
        ...usages.map((usage, i) => ({
          at: Date.now(),
          kind: refining ? ('refine' as const) : ('generate' as const),
          feedback: i === usages.length - 1 ? feedback : undefined,
          slides: l!.slides.map((s) => s.name),
          usage,
          learned: i === usages.length - 1 ? learned : undefined,
        })),
      ],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    l = (await getLecture(id)) ?? l
    await patchLecture(id, { status: l.notesMd ? 'ready' : 'error', error: friendly(msg) })
    throw e
  }
}

/** Total estimated cost of everything Gemini did for this lecture. */
export const lectureCost = (l: Lecture) => l.history.reduce((n, h) => n + (h.usage?.costUsd ?? 0), 0)

function clampWords(s: string, max: number) {
  const words = s.split(/(\s+)/)
  let n = 0
  let out = ''
  for (const w of words) {
    if (w.trim()) n++
    if (n > max) break
    out += w
  }
  return out
}

function friendly(msg: string) {
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Your Gemini API key was rejected. Check it in Settings.'
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) return 'Gemini rate limit or quota hit. Wait a minute and retry, or check billing.'
  if (/not found|404/i.test(msg) && /model/i.test(msg)) return "That Gemini model isn't available. Pick another in Settings."
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "No connection. Your recording is saved; retry when you're online."
  return msg
}
