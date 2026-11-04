import { GoogleGenAI, ThinkingLevel, Type, createPartFromUri, type GenerateContentConfig, type GenerateContentResponse, type Part } from '@google/genai'
import { findOrCreateCourse, getAudio, getBlob, getCourse, getLecture, listCourses, nextLectureNumber, patchLecture, saveCourse } from './db'
import { addPrefs, loadSettings } from './settings'
import type { Course, Lecture, Usage } from './types'
import { fmtTime } from './util'

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

/** Re-use the uploaded audio for 48h; re-upload after it expires. */
async function ensureAudio(l: Lecture) {
  if (l.audioFile && l.audioFile.expiresAt - Date.now() > 10 * 60_000) return l.audioFile
  const audio = await getAudio(l.id)
  if (!audio.size) throw new Error('No audio was saved for this lecture.')
  const f = await uploadAndWait(audio, 'audio/mpeg', `quill-${l.id}.mp3`)
  const audioFile = {
    name: f.name!,
    uri: f.uri!,
    expiresAt: f.expirationTime ? Date.parse(f.expirationTime) : Date.now() + 47 * 3600_000,
  }
  await patchLecture(l.id, { audioFile })
  return audioFile
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
// least stable:  system prompt (fixed) → style → lecture audio → memory, marks, feedback.
// An Improve right after a generate then shares the long system+audio prefix.

const MEMORY_WORDS = 350

function systemPrompt(style: string) {
  return `You are Quill, the personal lecture note-taker of a Georgia Tech computer science sophomore.
You receive the audio of a university lecture (plus, sometimes, slides, the student's live marks and Quill's memory) and produce the notes the student will study from. They must never need to rewrite them.

## Goals
1. Capture ALL substantive content: every concept, definition, example, argument, formula, algorithm and caveat. Comprehensive, but zero filler.
2. Make it obvious what matters: what the lecturer emphasized, repeated, wrote down, or said would be on an exam/homework.
3. Pull out anything the student must DO: readings, assignments, deadlines, exam dates, office hours, announcements.
4. Be honest: never invent content. If audio is unclear, write your best guess followed by (?). Ignore small talk, logistics noise and audience chatter unless it matters.

## Who to listen to
- The lecturer is the primary voice: usually the most continuous speaker, explaining material, often amplified or closer to the mic. Their content is the backbone of the notes.
- Student questions and class discussion matter when the lecturer engages with them: capture the question briefly ("Q from class: …") and the lecturer's answer. During discussion sections, capture the main points raised and any conclusion the lecturer draws.
- Ignore side conversations near the recorder, chatter before class starts and after it ends, phone/notification sounds, and off-topic remarks. Never put private conversation into the notes.
- If the audio is too noisy or quiet to follow for a stretch, say so once in ❓ with the timestamp range instead of guessing.

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

Timestamps: write them as [mm:ss] (or [h:mm:ss] past one hour), measured from the start of the audio. Add a timestamp to every "###" heading, and inline wherever pointing back to the audio would help.
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

// ---------------------------------------------------------------- thinking budget
//
// Thinking tokens are billed like output tokens. Notes need a little reasoning, not a lot.
// Gemini 2.x takes a token budget; Gemini 3+ takes a level. Unknown aliases try the level
// first and fall back to a budget, then to the model default, if the API rejects it.

function thinkingOptions(model: string): (GenerateContentConfig['thinkingConfig'] | undefined)[] {
  if (/gemini-2\.[05]/.test(model)) return [{ thinkingBudget: 1024 }, undefined]
  return [{ thinkingLevel: ThinkingLevel.LOW }, { thinkingBudget: 1024 }, undefined]
}

async function generate(model: string, parts: Part[], system: string) {
  const ai = client()
  let lastErr: unknown
  for (const thinkingConfig of thinkingOptions(model)) {
    try {
      return await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
          temperature: 0.4,
          maxOutputTokens: 32768,
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

function usageOf(model: string, res: GenerateContentResponse): Usage {
  const u = res.usageMetadata ?? {}
  return {
    model,
    promptTokens: u.promptTokenCount ?? 0,
    cachedTokens: u.cachedContentTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    thoughtsTokens: u.thoughtsTokenCount ?? 0,
  }
}

export type Progress = (step: string) => void

// ---------------------------------------------------------------- main entry points

const running = new Map<string, Promise<void>>()
export const isRunning = (id: string) => running.has(id)

/** Generate (or refine) notes for a lecture. Safe to call from any screen. */
export function processLecture(id: string, opts: { feedback?: string; onProgress?: Progress; onLearned?: (prefs: string[]) => void } = {}) {
  const existing = running.get(id)
  if (existing) return existing
  const p = run(id, opts).finally(() => running.delete(id))
  running.set(id, p)
  return p
}

async function run(
  id: string,
  { feedback, onProgress, onLearned }: { feedback?: string; onProgress?: Progress; onLearned?: (prefs: string[]) => void },
) {
  const step = (s: string) => onProgress?.(s)
  let l = await getLecture(id)
  if (!l) return
  const refining = !!l.notesMd && (!!feedback || l.slides.length > 0)
  await patchLecture(id, { status: 'processing', error: undefined })
  try {
    const settings = loadSettings()
    const model = settings.model || 'gemini-flash-latest'

    step('Uploading audio…')
    const audio = await ensureAudio(l)
    l = (await getLecture(id))!
    if (l.slides.length) step('Uploading slides…')
    const slides = await slidesParts(l)

    const courses = await listCourses()
    const fixed = l.courseId ? await getCourse(l.courseId) : undefined
    const number = fixed ? (l.number ?? (await nextLectureNumber(fixed.id, id))) : undefined

    // Stable → variable, for implicit caching (see note above).
    const parts: Part[] = [createPartFromUri(audio.uri, 'audio/mpeg'), { text: `Lecture recording above (${fmtTime(l.durationSec)} long).` }]
    if (slides.length) {
      parts.push(...slides)
      parts.push({
        text: 'The lecture slides are attached above. Use them to fix terminology and spelling, fill in formulas, diagrams-in-words and details the audio missed, and align the section structure with the slides. The audio remains the source of truth for what the lecturer emphasized.',
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

    step(refining ? 'Refining notes…' : 'Gemini is listening to the lecture…')
    const res = await generate(model, parts, systemPrompt(settings.style))
    const text = res.text
    if (!text) throw new Error(`Gemini returned no notes (${res.candidates?.[0]?.finishReason ?? 'unknown reason'}).`)
    const r = JSON.parse(text) as Result
    const usage = usageOf(model, res)

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
        { at: Date.now(), kind: refining ? 'refine' : 'generate', feedback, slides: l.slides.map((s) => s.name), usage, learned },
      ],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await patchLecture(id, { status: l.notesMd ? 'ready' : 'error', error: friendly(msg) })
    throw e
  }
}

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
