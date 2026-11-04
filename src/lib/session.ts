import { audioStats, getLecture, listLectures, patchLecture, saveLecture } from './db'
import { processLecture } from './gemini'
import { LectureRecorder, keepAwake } from './recorder'
import { loadSettings } from './settings'
import type { Lecture, Mark } from './types'

/** The one active recording, shared across screens. */
export const session: { rec: LectureRecorder | null; lectureId: string | null; awake: boolean } = {
  rec: null,
  lectureId: null,
  awake: false,
}
let saveTimer: number | undefined

function track(id: string, rec: LectureRecorder) {
  session.rec = rec
  session.lectureId = id
  clearInterval(saveTimer)
  saveTimer = window.setInterval(() => {
    if (session.rec) patchLecture(id, { durationSec: session.rec.elapsed, chunkCount: session.rec.chunkCount })
  }, 10_000)
  keepAwake(true).then((ok) => (session.awake = ok))
}

/** Call directly from a tap handler: iOS only allows audio to start inside a user gesture. */
export async function beginLecture(courseId?: string) {
  const id = crypto.randomUUID()
  const rec = new LectureRecorder()
  const started = rec.start(id) // creates the AudioContext synchronously, inside the gesture
  const now = new Date()
  const lecture: Lecture = {
    id,
    courseId,
    title: `Lecture · ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    createdAt: now.getTime(),
    durationSec: 0,
    chunkCount: 0,
    status: 'recording',
    marks: [],
    slides: [],
    history: [],
  }
  await saveLecture(lecture)
  try {
    await started
  } catch (e) {
    await patchLecture(id, { status: 'saved', error: 'Microphone unavailable. Allow mic access for Quill and try again.' })
    throw e
  }
  track(id, rec)
  return id
}

/** Append more audio to a saved lecture (e.g. after iOS interrupted the recording). */
export async function continueLecture(id: string) {
  const rec = new LectureRecorder()
  rec.prepare() // inside the tap
  const stats = await audioStats(id)
  await rec.start(id, stats.durationSec, stats.nextSeq)
  await patchLecture(id, { status: 'recording', error: undefined })
  track(id, rec)
}

export async function addMark(kind: Mark['kind'], text?: string) {
  if (!session.rec || !session.lectureId) return
  const l = await getLecture(session.lectureId)
  if (!l) return
  const mark: Mark = { t: Math.max(0, session.rec.elapsed - (kind === 'star' ? 3 : 0)), kind, text }
  await patchLecture(l.id, { marks: [...l.marks, mark] })
  return mark
}

/** Stop, save, and (if a key is set) start generating notes in the background. */
export async function finishLecture() {
  const { rec, lectureId } = session
  if (!rec || !lectureId) return
  clearInterval(saveTimer)
  const durationSec = await rec.stop()
  session.rec = null
  session.lectureId = null
  await keepAwake(false)
  await patchLecture(lectureId, { status: 'saved', durationSec, chunkCount: rec.chunkCount })
  if (loadSettings().apiKey) processLecture(lectureId).catch(() => {})
  return lectureId
}

/** On launch: anything still marked "recording" was cut off. Recover what was saved. */
export async function recoverInterrupted() {
  for (const l of await listLectures()) {
    if (l.status === 'recording' && l.id !== session.lectureId) {
      const s = await audioStats(l.id)
      await patchLecture(l.id, { status: 'saved', durationSec: s.durationSec, chunkCount: s.nextSeq })
    }
    if (l.status === 'processing') await patchLecture(l.id, { status: l.notesMd ? 'ready' : 'saved' })
  }
}
