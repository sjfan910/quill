import { useEffect, useRef, useState } from 'react'
import { getCourse, getLecture } from '../lib/db'
import { useData } from '../lib/hooks'
import { go } from '../lib/router'
import { addMark, finishLecture, pauseRecording, resumeRecording, session } from '../lib/session'
import { fmtTime } from '../lib/util'
import { toast } from '../components/ui'

export default function Record({ id }: { id: string }) {
  const lecture = useData(() => getLecture(id), [id])
  const course = useData(async () => (lecture?.courseId ? getCourse(lecture.courseId) : undefined), [lecture?.courseId])
  const [, tick] = useState(0)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const rec = session.lectureId === id ? session.rec : null

  useEffect(() => {
    if (!rec) return
    rec.onUpdate = () => tick((n) => n + 1)
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => {
      clearInterval(t)
      rec.onUpdate = undefined
    }
  }, [rec])

  useEffect(() => {
    if (!rec && lecture && lecture.status !== 'recording') go(`/lecture/${id}`, true)
  }, [rec, lecture, id])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (session.rec) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  if (!rec) return <main className="page" />

  const paused = rec.state === 'paused'
  const level = paused ? 0 : rec.level

  async function star() {
    const m = await addMark('star')
    if (m) toast(`⭐ Marked at ${fmtTime(m.t)}`)
  }
  async function saveNote() {
    if (!note.trim()) return setNoteOpen(false)
    await addMark('note', note.trim())
    setNote('')
    setNoteOpen(false)
    toast('✎ Note added')
  }
  async function finish() {
    setBusy(true)
    const lid = await finishLecture()
    go(`/lecture/${lid}`, true)
  }

  return (
    <main className="page record">
      <header className="record-head">
        <button className="back" onClick={() => go('/')}>
          ‹ Home
        </button>
        <span className="chip">{course ? course.code : '✨ Auto-detect'}</span>
      </header>

      <section className="record-center">
        <div className={`pulse ${paused ? 'paused' : ''}`} style={{ ['--lvl' as string]: level.toFixed(2) }}>
          <div className="pulse-core">{paused ? 'Paused' : <span className="live-dot">● REC</span>}</div>
        </div>
        <div className="timer">{fmtTime(rec.liveElapsed)}</div>
        <p className="hint">
          {session.awake ? 'Screen stays on. Dim it, but don\'t lock it: iPhone stops recording when the screen is off.' : 'Keep the screen on while recording: iPhone stops recording when it\'s off.'}
        </p>
        {session.live && !paused && (
          <p className="caption" aria-live="off">
            {session.live.interim || session.live.segments.at(-1)?.text || 'Listening for words…'}
          </p>
        )}
      </section>

      <section className="record-actions">
        <button className="big-btn orange" onClick={star} disabled={paused}>
          ⭐ This is important
        </button>
        {noteOpen ? (
          <form
            className="note-form"
            onSubmit={(e) => {
              e.preventDefault()
              saveNote()
            }}
          >
            <input ref={input} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Type a quick note…" enterKeyHint="done" />
            <button className="btn blue" type="submit">
              Add
            </button>
          </form>
        ) : (
          <button className="big-btn ghost" onClick={() => setNoteOpen(true)}>
            ✎ Add a note
          </button>
        )}
        {lecture && lecture.marks.length > 0 && (
          <p className="marks-count">
            {lecture.marks.filter((m) => m.kind === 'star').length} ⭐ · {lecture.marks.filter((m) => m.kind === 'note').length} ✎
          </p>
        )}
      </section>

      {rec.stalled && (
        <button
          className="stall-overlay"
          onClick={async () => {
            await rec.revive()
            tick((n) => n + 1)
          }}
        >
          <span className="stall-icon">🎙️</span>
          <b>Tap to continue recording</b>
          <span>The screen was off, so iPhone paused the microphone. The missed part will show as a gap in your notes.</span>
        </button>
      )}

      <footer className="record-foot">
        <button className="btn ghost round" onClick={() => (paused ? resumeRecording() : pauseRecording())}>
          {paused ? '▶ Resume' : '❚❚ Pause'}
        </button>
        <button className="btn blue round wide" onClick={finish} disabled={busy}>
          ■ Finish
        </button>
      </footer>
    </main>
  )
}
