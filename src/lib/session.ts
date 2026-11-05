import { audioStats, getLecture, listLectures, patchLecture, saveLecture } from './db'
import { processLecture } from './gemini'
import { toast } from '../components/ui'
import { LiveTranscriber } from './live'
import { LectureRecorder, keepAwake } from './recorder'
import { loadSettings, saveSettings } from './settings'
import { session as currentSession } from './supabase'
import type { Lecture, Mark } from './types'

/** The one active recording, shared across screens. */
export const session: { rec: LectureRecorder | null; live: LiveTranscriber | null; lectureId: string | null; awake: boolean } = {
  rec: null,
  live: null,
  lectureId: null,
  awake: false,
}
let saveTimer: number | undefined

function snapshot() {
  const { rec, live } = session
  if (!rec) return {}
  return {
    durationSec: rec.elapsed,
    chunkCount: rec.chunkCount,
    loudness: rec.loudness.slice(),
    gaps: rec.gaps.slice(),
    ...(live ? { live: live.segments.slice() } : {}),
  }
}

function track(id: string, rec: LectureRecorder, existingLive: { t: number; text: string }[] = []) {
  session.rec = rec
  session.lectureId = id
  rec.onGap = (g) => {
    const m = Math.round(g.to - g.from)
    toast(`⏸ ${m >= 60 ? `${Math.floor(m / 60)} min ${m % 60} s` : `${m} s`} weren't recorded while the screen was off. Keep it on (dimmed).`)
    void patchLecture(id, snapshot())
  }
  clearInterval(saveTimer)
  saveTimer = window.setInterval(() => {
    if (session.rec) patchLecture(id, snapshot())
  }, 10_000)
  keepAwake(true).then((ok) => (session.awake = ok))
  startLive(id, rec, existingLive)
}

/**
 * Free live transcript. On some iPhones the speech recognizer and the recorder fight over
 * the microphone; if the recording stalls right after starting it, turn it off for good
 * and rescue the recording.
 */
function startLive(id: string, rec: LectureRecorder, existing: { t: number; text: string }[]) {
  session.live = null
  if (!loadSettings().liveTranscribe) return
  const live = new LiveTranscriber(() => rec.elapsed, () => rec.onUpdate?.())
  if (!live.start(existing)) {
    patchLecture(id, { liveNote: 'Free live transcription is not available in this browser.' })
    return
  }
  session.live = live
  const t0 = rec.elapsed
  window.setTimeout(async () => {
    if (session.rec !== rec || rec.state !== 'recording') return
    if (rec.elapsed - t0 < 2.5) {
      live.stop()
      session.live = null
      await rec.revive()
      saveSettings({ ...loadSettings(), liveTranscribe: false })
      await patchLecture(id, { liveNote: 'Free live transcription interrupted the microphone on this device, so it was turned off.' })
      toast('🎙️ Free transcription clashed with the mic — turned it off. Recording is fine.')
    }
  }, 5000)
}

export async function pauseRecording() {
  session.live?.stop()
  await session.rec?.pause()
}

export async function resumeRecording() {
  await session.rec?.resume()
  if (session.rec && session.lectureId && session.live) {
    const segs = session.live.segments
    startLive(session.lectureId, session.rec, segs)
  }
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
  const prev = await getLecture(id)
  await rec.start(id, stats.durationSec, stats.nextSeq, prev?.loudness ?? [])
  rec.gaps = prev?.gaps?.slice() ?? []
  // New audio invalidates any transcript/notes made from the shorter recording's transcript.
  await patchLecture(id, { status: 'recording', error: undefined, transcript: undefined, transcriptStats: undefined })
  track(id, rec, prev?.live ?? [])
}

export async function addMark(kind: Mark['kind'], text?: string) {
  if (!session.rec || !session.lectureId) return
  const l = await getLecture(session.lectureId)
  if (!l) return
  const mark: Mark = { t: Math.max(0, session.rec.liveElapsed - (kind === 'star' ? 3 : 0)), kind, text }
  await patchLecture(l.id, { marks: [...l.marks, mark] })
  return mark
}

/** Stop, save, and (if a key is set) start generating notes in the background. */
export async function finishLecture() {
  const { rec, lectureId } = session
  if (!rec || !lectureId) return
  clearInterval(saveTimer)
  const live = session.live
  live?.stop()
  const durationSec = await rec.stop()
  const snap = snapshot()
  session.rec = null
  session.live = null
  session.lectureId = null
  await keepAwake(false)
  await patchLecture(lectureId, {
    ...snap,
    status: 'saved',
    durationSec,
    chunkCount: rec.chunkCount,
    ...(live?.failed && live.failed !== 'unsupported' ? { liveNote: `Free live transcription stopped (${live.failed}); Gemini will cover the rest.` } : {}),
  })
  if (loadSettings().apiKey || currentSession()) processLecture(lectureId).catch(() => {})
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
