import { useState } from 'react'
import { createCourse, listCourses, listLectures } from '../lib/db'
import { useData } from '../lib/hooks'
import { go } from '../lib/router'
import { beginLecture, session } from '../lib/session'
import { loadSettings } from '../lib/settings'
import { toast } from '../components/ui'

export default function Home() {
  const courses = useData(listCourses) ?? []
  const lectures = useData(listLectures) ?? []
  const [courseId, setCourseId] = useState<string>('')
  const [starting, setStarting] = useState(false)
  const hasKey = !!loadSettings().apiKey

  const waiting = lectures.filter((l) => l.status === 'saved' || l.status === 'error')
  const unsorted = lectures.filter((l) => !l.courseId && l.status !== 'recording')

  async function start() {
    if (session.lectureId) return go(`/record/${session.lectureId}`)
    setStarting(true)
    try {
      const id = await beginLecture(courseId || undefined)
      go(`/record/${id}`)
    } catch {
      toast('🎙️ Quill needs microphone access')
    } finally {
      setStarting(false)
    }
  }

  async function onPick(v: string) {
    if (v !== '__new') return setCourseId(v)
    const code = prompt('Class code (e.g. CS 2050)')
    if (!code?.trim()) return
    const c = await createCourse(code)
    setCourseId(c.id)
  }

  return (
    <main className="page home">
      <header className="home-head">
        <h1 className="logo">
          Quill<span>.</span>
        </h1>
        <button className="icon-btn" onClick={() => go('/settings')} aria-label="Settings">
          ⚙︎
        </button>
      </header>

      {!hasKey && (
        <button className="banner blue" onClick={() => go('/settings')}>
          <b>One-time setup:</b> add your Gemini key →
        </button>
      )}

      <section className="hero">
        {session.lectureId ? (
          <button className="rec-btn live" onClick={start} aria-label="Back to recording">
            <span className="rec-dot" />
          </button>
        ) : (
          <button className="rec-btn" onClick={start} disabled={starting} aria-label="Start recording">
            <span className="rec-dot" />
          </button>
        )}
        <p className="hero-label">{session.lectureId ? 'Recording… tap to return' : 'Tap to record'}</p>
        {!session.lectureId && (
          <select className="course-pick" value={courseId} onChange={(e) => onPick(e.target.value)}>
            <option value="">✨ Auto-detect class</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
            <option value="__new">＋ New class…</option>
          </select>
        )}
      </section>

      {waiting.length > 0 && (
        <button className="banner orange" onClick={() => go(`/lecture/${waiting[0].id}`)}>
          {waiting.length === 1 ? '1 recording' : `${waiting.length} recordings`} waiting for notes →
        </button>
      )}

      <section>
        <h2 className="section-title">My classes</h2>
        {courses.length === 0 && unsorted.length === 0 ? (
          <p className="empty">Your classes appear here after your first lecture.</p>
        ) : (
          <div className="grid">
            {courses.map((c) => {
              const n = lectures.filter((l) => l.courseId === c.id).length
              return (
                <button key={c.id} className="tile" style={{ ['--accent' as string]: c.color }} onClick={() => go(`/course/${c.id}`)}>
                  <span className="tile-code">{c.code}</span>
                  <span className="tile-name">{c.name || ' '}</span>
                  <span className="tile-count">{n === 1 ? '1 lecture' : `${n} lectures`}</span>
                </button>
              )
            })}
            {unsorted.length > 0 && (
              <button className="tile unsorted" onClick={() => go('/course/unsorted')}>
                <span className="tile-code">Unsorted</span>
                <span className="tile-name"> </span>
                <span className="tile-count">{unsorted.length} lectures</span>
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  )
}
