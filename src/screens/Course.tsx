import { deleteCourse, getCourse, listLectures, saveCourse } from '../lib/db'
import { useData } from '../lib/hooks'
import { go } from '../lib/router'
import { fmtDate, fmtDuration } from '../lib/util'
import { TopBar } from '../components/ui'

const STATUS: Record<string, string> = { saved: 'Needs notes', error: 'Needs notes', processing: 'Working…', recording: 'Recording' }

export default function Course({ id }: { id: string }) {
  const unsorted = id === 'unsorted'
  const course = useData(() => (unsorted ? Promise.resolve(undefined) : getCourse(id)), [id])
  const lectures =
    useData(async () => {
      const all = await listLectures()
      return all.filter((l) => (unsorted ? !l.courseId : l.courseId === id)).sort((a, b) => (b.number ?? 0) - (a.number ?? 0) || b.createdAt - a.createdAt)
    }, [id]) ?? []

  async function rename() {
    if (!course) return
    const name = prompt(`Name for ${course.code}`, course.name)
    if (name !== null) await saveCourse({ ...course, name: name.trim() })
  }

  return (
    <main className="page">
      <TopBar
        back={{ label: 'Home', onClick: () => go('/') }}
        right={
          course && (
            <button className="icon-btn" onClick={rename} aria-label="Rename class">
              ✎
            </button>
          )
        }
      />
      <div className="lecture-head">
        <p className="eyebrow" style={{ color: course?.color }}>
          {lectures.length} {lectures.length === 1 ? 'lecture' : 'lectures'}
        </p>
        <h1>{unsorted ? 'Unsorted' : course?.code}</h1>
        {course?.name && <p className="meta">{course.name}</p>}
      </div>

      <ul className="list">
        {lectures.map((l) => (
          <li key={l.id}>
            <button className="list-row" onClick={() => go(l.status === 'recording' ? `/record/${l.id}` : `/lecture/${l.id}`)}>
              <span className="num" style={{ borderColor: course?.color }}>
                {l.number ?? '•'}
              </span>
              <span className="row-main">
                <span className="row-title">{l.title}</span>
                <span className="row-sub">
                  {fmtDate(l.createdAt)} · {fmtDuration(l.durationSec)}
                  {STATUS[l.status] && <em> · {STATUS[l.status]}</em>}
                </span>
              </span>
              <span className="chev">›</span>
            </button>
          </li>
        ))}
      </ul>
      {lectures.length === 0 && <p className="empty">No lectures yet.</p>}

      {course && lectures.length === 0 && (
        <button
          className="big-btn danger"
          onClick={async () => {
            if (confirm(`Delete ${course.code}?`)) {
              await deleteCourse(course.id)
              go('/', true)
            }
          }}
        >
          Delete class
        </button>
      )}
    </main>
  )
}
