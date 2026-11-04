import { GoogleGenAI, ThinkingLevel, Type, createPartFromUri, type GenerateContentConfig, type Part } from '@google/genai'
import { findOrCreateCourse, getAudio, getBlob, getCourse, getLecture, listCourses, nextLectureNumber, patchLecture, saveCourse } from './db'
import { chunkRanges, mergeTranscript, planTranscription } from './gaps'
import { addSpend, estimate, fmtUsd, isPro, monthSpend, overCap, usageOf } from './pricing'
import { addPrefs, loadSettings } from './settings'
import type { Course, HistoryEntry, Lecture, TranscriptSeg, Usage } from './types'
import { fmtTime, parseTime } from './util'

function client() {
  const { apiKey } = loadSettings()
  if (!apiKey) throw new Error('Add your Gemini API key in Settings first.')
  return new GoogleGenAI({ apiKey })
}

export async function listModels() {
  const ai = client()
  const out: string[] = []
  const pager = await ai.models.list({ config: { pageSize: 100 } })
  for await (const m of pager) {
    const name = (m.name ?? '').replace(/^models\//, '')
    if (!name.startsWith('gemini')) continue
    if (!m.supportedActions?.includes('generateContent')) continue
    if (/(image|tts|live|audio|embedding|robotics|computer)/.test(name)) continue
    out.push(name)
  }
  return out.sort().reverse()
}

// ---------------------------------------------------------------- uploads

async function uploadAndWait(blob: Blob, mimeType: string, displayName: string) {
  const ai = client()
  let f = await ai.files.upload({ file: blob, config: { mimeType, displayName } })
  for (let i = 0; i < 120 && f.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    f = await ai.files.get({ name: f.name! })
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
One "###" section per topic, in lecture order. Start each section heading with the timestamp where it begins, like "### [12:34] Topic". Inside: concise bullets, nested where useful, tables for comparisons, code blocks for code/pseudocode/math, 🧪 worked examples.

## 🔑 Key terms
| Term | Meaning |  (every important term, one line each; reuse the course glossary's wording for terms already defined)

## ✅ To-do
- [ ] task — due date if mentioned. If nothing was assigned, write "- Nothing assigned this lecture."

## ❓ Questions / unclear
Things that were confusing, contradictory or worth asking the professor or TA about. Include the student's own typed questions.

Timestamps: write them as [mm:ss] (or [h:mm:ss] past one hour), measured from the start of the recording; reuse the transcript's timestamps. Add a timestamp to every "###" heading, and inline wherever pointing back to the audio would help.
Do not use LaTeX ($...$). Write math in plain text or code blocks.

## mindmapMarkdown: a mind map of the lecture (rendered with markmap)
- First line "# <short lecture title>".
- 4-7 main branches as "## <emoji> <label>", each with nested "- " bullets up to 2 levels deep.
- Labels are 1-6 words: keywords, not sentences. Show relationships with → where useful.
- Cover the whole lecture; make the structure reveal how ideas connect. Plain text only, no HTML.

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

async function slidesParts(l: Lecture): Promise<Part[]> {
  const parts: Part[] = []
  for (const s of l.slides) {
    const blob = await getBlob(s.key)
    if (!blob) continue
    const f = await uploadAndWait(blob, s.type, s.name)
    parts.push(createPartFromUri(f.uri!, f.mimeType ?? s.type))
  }
  return parts
}

// ---------------------------------------------------------------- model calls
//
// Thinking tokens are billed like output tokens. Gemini 2.x takes a token budget; Gemini 3+
// takes a level. Unknown aliases try the level first and fall back if the API rejects it.

type Effort = 'minimal' | 'low'

function thinkingOptions(model: string, effort: Effort): (GenerateContentConfig['thinkingConfig'] | undefined)[] {
  if (/gemini-2\.[05]/.test(model)) {
    const budget = effort === 'minimal' ? (/pro/.test(model) ? 128 : 0) : 1024
    return [{ thinkingBudget: budget }, undefined]
  }
  const level = effort === 'minimal' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW
  return [{ thinkingLevel: level }, { thinkingBudget: effort === 'minimal' ? 0 : 1024 }, undefined]
}

async function callOnce(model: string, parts: Part[], system: string, schema: object, effort: Effort, maxOutputTokens: number) {
  const ai = client()
  let lastErr: unknown
  for (const thinkingConfig of thinkingOptions(model, effort)) {
    try {
      return await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.3,
          maxOutputTokens,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      })
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
  kind: 'transcribe' | 'notes',
  parts: Part[],
  system: string,
  schema: object,
  effort: Effort,
  maxOutputTokens: number,
): Promise<{ data: T; usages: Usage[] }> {
  const usages: Usage[] = []
  let attempt = parts
  for (let i = 0; i < 2; i++) {
    const res = await callOnce(model, attempt, system, schema, effort, maxOutputTokens)
    const usage = usageOf(model, kind, res)
    usages.push(usage)
    addSpend(usage.costUsd ?? 0)
    const reason = res.candidates?.[0]?.finishReason
    try {
      if (!res.text) throw new Error('empty')
      return { data: JSON.parse(res.text) as T, usages }
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
  if (clip.size < 6_000_000) return { inlineData: { mimeType: 'audio/mpeg', data: await toBase64(clip) } }
  const f = await uploadAndWait(clip, 'audio/mpeg', name)
  return createPartFromUri(f.uri!, 'audio/mpeg')
}

/** Builds the transcript once: free live text + Gemini only for the gaps. */
/** Free live text is used unless the user asked for an accurate (Gemini-only) transcript. */
const liveFor = (l: Lecture, accurate: boolean) => (accurate ? [] : (l.live ?? []))

async function ensureTranscript(id: string, step: Progress, accurate: boolean) {
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

type RunOpts = { feedback?: string; manual?: boolean; retranscribe?: boolean; onProgress?: Progress; onLearned?: (prefs: string[]) => void }

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

async function run(id: string, { feedback, manual = false, retranscribe = false, onProgress, onLearned }: RunOpts) {
  const step = (s: string) => onProgress?.(s)
  let l = await getLecture(id)
  if (!l) return
  const accurate = retranscribe || !loadSettings().liveTranscribe
  const blocked = await guard(l, manual, retranscribe, accurate)
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
    const transcript = await ensureTranscript(id, step, accurate)
    if (!transcript.length) throw new Error("Quill couldn't hear any speech in this recording.")

    l = (await getLecture(id))!
    if (l.slides.length) step('Uploading slides…')
    const slides = await slidesParts(l)

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
    if (slides.length) {
      parts.push(...slides)
      parts.push({
        text: 'The lecture slides are attached above. Use them to fix terminology and spelling, fill in formulas, diagrams-in-words and details the transcript missed, and align the section structure with the slides. The transcript remains the source of truth for what the lecturer emphasized.',
      })
    }
    parts.push({ text: memoryText(courses, fixed, number, settings.prefs) })
    parts.push({ text: marksText(l) })
    if (refining && l.notesMd) {
      parts.push({ text: `Current version of the notes:\n\n${l.notesMd}` })
      parts.push({
        text: feedback
          ? `Revise the notes according to the student's feedback, keeping everything else that is good:\n"""${feedback}"""\nAlso decide whether this feedback reveals a durable preference (learnedPreferences).`
          : 'Revise and improve the current notes using the slides. There is no feedback, so learnedPreferences must be [].',
      })
    } else {
      parts.push({ text: 'There is no feedback yet, so learnedPreferences must be [].' })
    }

    step(refining ? 'Refining notes…' : 'Writing your notes…')
    const { data: r, usages } = await callJson<Result>(model, 'notes', parts, systemPrompt(settings.style), SCHEMA, 'low', 32768)

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
