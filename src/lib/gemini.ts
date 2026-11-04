import { GoogleGenAI, Type, createPartFromUri, type Part } from '@google/genai'
import { findOrCreateCourse, getAudio, getBlob, getCourse, getLecture, listCourses, nextLectureNumber, patchLecture } from './db'
import { loadSettings } from './settings'
import type { Lecture } from './types'
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

// ---------------------------------------------------------------- prompt

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    courseCode: { type: Type.STRING, description: 'e.g. "CS 2050". "UNSORTED" if unknown.' },
    courseName: { type: Type.STRING, description: 'Course name, short. Empty if unknown.' },
    lectureTitle: { type: Type.STRING, description: 'Topic of this lecture, 2-6 words, no course code or lecture number.' },
    summary: { type: Type.STRING, description: 'One sentence: what this lecture was about.' },
    notesMarkdown: { type: Type.STRING },
    mindmapMarkdown: { type: Type.STRING },
  },
  required: ['courseCode', 'courseName', 'lectureTitle', 'summary', 'notesMarkdown', 'mindmapMarkdown'],
  propertyOrdering: ['courseCode', 'courseName', 'lectureTitle', 'summary', 'notesMarkdown', 'mindmapMarkdown'],
}

function systemPrompt(style: string) {
  return `You are Quill, the personal lecture note-taker of a Georgia Tech computer science sophomore.
You receive the audio of a university lecture (plus, sometimes, slides and the student's own live marks) and produce the notes the student will study from. They must never need to rewrite them.

## Goals
1. Capture ALL substantive content: every concept, definition, example, argument, formula, algorithm and caveat. Comprehensive, but zero filler.
2. Make it obvious what matters: what the lecturer emphasized, repeated, wrote down, or said would be on an exam/homework.
3. Pull out anything the student must DO: readings, assignments, deadlines, exam dates, office hours, announcements.
4. Be honest: never invent content. If audio is unclear, write your best guess followed by (?). Ignore small talk, logistics noise and audience chatter unless it matters.

## The student's personal formatting style (follow it closely)
${style}

## notesMarkdown: use exactly this structure (GitHub-flavored Markdown)
# <Lecture title>
> **TL;DR:** 2-3 short lines capturing the whole lecture.

## 🎯 Focus on this
3-7 bullets: the most important / most testable ideas. Include every moment the student starred (⭐) and explain why it matters.

## 🗺️ Big picture
How the ideas connect, as a short arrow chain or 3-5 bullets. Link to previous lectures if the lecturer did.

## 📚 Notes
One "###" section per topic, in lecture order. Start each section heading with the timestamp where it begins, like "### [12:34] Topic". Inside: concise bullets, nested where useful, tables for comparisons, code blocks for code/pseudocode/math, 🧪 worked examples.

## 🔑 Key terms
| Term | Meaning |  (every important term, one line each)

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
- Cover the whole lecture; make the structure reveal how ideas connect.

## Course detection
Pick the course this lecture belongs to. If it clearly matches one of the student's known courses, return that course's exact code and name. Otherwise infer it from what is said (Georgia Tech codes look like "CS 2050", "MATH 1554", "INTA 2050"). If you can't tell, return courseCode "UNSORTED".`
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

type Result = {
  courseCode: string
  courseName: string
  lectureTitle: string
  summary: string
  notesMarkdown: string
  mindmapMarkdown: string
}

export type Progress = (step: string) => void

// ---------------------------------------------------------------- main entry points

const running = new Map<string, Promise<void>>()
export const isRunning = (id: string) => running.has(id)

/** Generate (or refine) notes for a lecture. Safe to call from any screen. */
export function processLecture(id: string, opts: { feedback?: string; onProgress?: Progress } = {}) {
  const existing = running.get(id)
  if (existing) return existing
  const p = run(id, opts).finally(() => running.delete(id))
  running.set(id, p)
  return p
}

async function run(id: string, { feedback, onProgress }: { feedback?: string; onProgress?: Progress }) {
  const step = (s: string) => onProgress?.(s)
  let l = await getLecture(id)
  if (!l) return
  const refining = !!l.notesMd && (!!feedback || l.slides.length > 0)
  await patchLecture(id, { status: 'processing', error: undefined })
  try {
    const settings = loadSettings()
    const ai = client()

    step('Uploading audio…')
    const audio = await ensureAudio(l)
    l = (await getLecture(id))!
    if (l.slides.length) step('Uploading slides…')
    const slides = await slidesParts(l)

    const courses = await listCourses()
    const fixed = l.courseId ? await getCourse(l.courseId) : undefined
    const courseInfo = fixed
      ? `This lecture is from ${fixed.code}${fixed.name ? ` (${fixed.name})` : ''}. Return exactly that course code and name.`
      : courses.length
        ? `The student's known courses:\n${courses.map((c) => `- ${c.code}${c.name ? `: ${c.name}` : ''}`).join('\n')}`
        : 'The student has no saved courses yet.'

    const parts: Part[] = [createPartFromUri(audio.uri, 'audio/mpeg')]
    parts.push({ text: `Lecture recording above (${fmtTime(l.durationSec)} long).` })
    if (slides.length) {
      parts.push(...slides)
      parts.push({
        text: 'The lecture slides are attached above. Use them to fix terminology and spelling, fill in formulas, diagrams-in-words and details the audio missed, and align the section structure with the slides. The audio remains the source of truth for what the lecturer emphasized.',
      })
    }
    parts.push({ text: courseInfo })
    parts.push({ text: marksText(l) })
    if (refining && l.notesMd) {
      parts.push({ text: `Current version of the notes:\n\n${l.notesMd}` })
      parts.push({
        text: feedback
          ? `Revise the notes according to the student's feedback, keeping everything else that is good:\n"""${feedback}"""`
          : 'Revise and improve the current notes using the slides.',
      })
    }

    step(refining ? 'Refining notes…' : 'Gemini is listening to the lecture…')
    const res = await ai.models.generateContent({
      model: settings.model || 'gemini-flash-latest',
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: systemPrompt(settings.style),
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 32768,
      },
    })
    const text = res.text
    if (!text) throw new Error(`Gemini returned no notes (${res.candidates?.[0]?.finishReason ?? 'unknown reason'}).`)
    const r = JSON.parse(text) as Result

    step('Filing it in your library…')
    l = (await getLecture(id))!
    let courseId = l.courseId
    let number = l.number
    if (!courseId && r.courseCode && r.courseCode.toUpperCase() !== 'UNSORTED') {
      courseId = (await findOrCreateCourse(r.courseCode, r.courseName)).id
    }
    if (courseId && !number) number = await nextLectureNumber(courseId, id)

    await patchLecture(id, {
      status: 'ready',
      courseId,
      number,
      title: r.lectureTitle || l.title,
      summary: r.summary,
      notesMd: r.notesMarkdown,
      mindmapMd: r.mindmapMarkdown,
      history: [
        ...l.history,
        { at: Date.now(), kind: refining ? 'refine' : 'generate', feedback, slides: l.slides.map((s) => s.name) },
      ],
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await patchLecture(id, { status: l.notesMd ? 'ready' : 'error', error: friendly(msg) })
    throw e
  }
}

function friendly(msg: string) {
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Your Gemini API key was rejected. Check it in Settings.'
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) return 'Gemini rate limit or quota hit. Wait a minute and retry, or check billing.'
  if (/not found|404/i.test(msg) && /model/i.test(msg)) return 'That Gemini model isn\'t available. Pick another in Settings.'
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'No connection. Your recording is saved; retry when you\'re online.'
  return msg
}
