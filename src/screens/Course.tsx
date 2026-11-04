import { useEffect, useState } from 'react'
import { courseWithCode, createCourse, deleteCourse, fileUnsorted, getCourse, listLectures, mergeCourses, renameCourse, saveCourse } from '../lib/db'
import { renderMemory } from '../lib/markdown'
import { useData } from '../lib/hooks'
import { go } from '../lib/router'
import { fmtDate, fmtDuration } from '../lib/util'
import { Sheet, TopBar, toast } from '../components/ui'

const STATUS: Record<string, string> = { saved: 'Needs notes', error: 'Needs notes', processing: 'Working…', recording: 'Recording' }

export default function Course({ id }: { id: string }) {
  const unsorted = id === 'unsorted'
  const course = useData(() => (unsorted ? Promise.resolve(undefined) : getCourse(id)), [id])
  const lectures =
    useData(async () => {
      const all = await listLectures()
      return all.filter((l) => (unsorted ? !l.courseId : l.courseId === id)).sort((a, b) => (b.number ?? 0) - (a.number ?? 0) || b.createdAt - a.createdAt)
    }, [id]) ?? []

  const [memOpen, setMemOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const [editOpen, setEditOpen] = useState(false)

  return (
    <main className="page">
      <TopBar
        back={{ label: 'Home', onClick: () => go('/') }}
        right={
          (course || (unsorted && lectures.length > 0)) && (
            <button className="icon-btn" onClick={() => setEditOpen(true)} aria-label={course ? 'Rename class' : 'File these under a class'}>
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

      {course && (
        <button className="memory-chip" onClick={() => setMemOpen(true)}>
          <span>🧠</span>
          <span className="row-main">
            <span className="row-title">What Quill remembers</span>
            <span className="row-sub">{course.memory ? 'Past lectures, terms, deadlines, prof habits' : 'Builds up after your first lecture'}</span>
          </span>
          <span className="chev">›</span>
        </button>
      )}

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
      <EditClassSheet
        open={editOpen}
        onClose={() => setEditOpen(false)}
        courseId={course?.id}
        initialCode={course?.code ?? ''}
        initialName={course?.name ?? ''}
        count={lectures.length}
      />

      {course && (
        <Sheet
          open={memOpen}
          onClose={() => {
            setMemOpen(false)
            setEditing(null)
          }}
          title={`${course.code} memory`}
        >
          {editing !== null ? (
            <>
              <textarea rows={14} value={editing} onChange={(e) => setEditing(e.target.value)} />
              <button
                className="big-btn blue"
                onClick={async () => {
                  await saveCourse({ ...course, memory: editing.trim() || undefined, memoryUpdatedAt: Date.now() })
                  setEditing(null)
                  toast('🧠 Memory saved')
                }}
              >
                Save
              </button>
            </>
          ) : course.memory ? (
            <>
              <p className="fine">Quill reads this before every {course.code} lecture so notes connect to what came before. It updates itself.</p>
              <article className="notes memory" dangerouslySetInnerHTML={{ __html: renderMemory(course.memory) }} />
              <button className="big-btn ghost" onClick={() => setEditing(course.memory ?? '')}>
                ✎ Edit
              </button>
              <button
                className="big-btn danger"
                onClick={async () => {
                  if (!confirm(`Forget everything Quill remembers about ${course.code}?`)) return
                  await saveCourse({ ...course, memory: undefined, memoryUpdatedAt: Date.now() })
                }}
              >
                Forget all
              </button>
            </>
          ) : (
            <p className="empty">Nothing yet. After your first {course.code} lecture, Quill keeps a short summary of each lecture, key terms, deadlines and your professor's habits here.</p>
          )}
        </Sheet>
      )}
    </main>
  )
}

/** Rename a class (code + name). Renaming onto an existing code offers a merge. Also files Unsorted lectures. */
function EditClassSheet({
  open,
  onClose,
  courseId,
  initialCode,
  initialName,
  count,
}: {
  open: boolean
  onClose: () => void
  courseId?: string
  initialCode: string
  initialName: string
  count: number
}) {
  const [code, setCode] = useState(initialCode)
  const [name, setName] = useState(initialName)
  const [clash, setClash] = useState<{ id: string; code: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setCode(initialCode)
      setName(initialName)
      setClash(null)
    }
  }, [open, initialCode, initialName])

  async function save() {
    if (!code.trim()) return
    setBusy(true)
    try {
      const other = await courseWithCode(code, courseId)
      if (other && !clash) {
        setClash({ id: other.id, code: other.code })
        return
      }
      if (courseId) {
        if (other) {
          await mergeCourses(courseId, other.id)
          toast(`Merged into ${other.code}`)
          onClose()
          go(`/course/${other.id}`, true)
          return
        }
        await renameCourse(courseId, code, name)
        toast('✎ Class renamed')
        onClose()
        return
      }
      // Unsorted → file everything under an existing or new class
      const target = other ?? (await createCourse(code, name.trim()))
      const n = await fileUnsorted(target.id)
      toast(`Filed ${n} lecture${n === 1 ? '' : 's'} under ${target.code}`)
      onClose()
      go(`/course/${target.id}`, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={courseId ? 'Edit class' : 'File under a class'}>
      {!courseId && <p className="fine top">All {count} unsorted lecture{count === 1 ? '' : 's'} will move to this class.</p>}
      <label className="field">
        <span>Class code</span>
        <input
          value={code}
          onChange={(e) => {
            setCode(e.target.value)
            setClash(null)
          }}
          placeholder="e.g. CS 2050"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Class name (optional)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Intro to Discrete Math" />
      </label>
      {clash && (
        <p className="hint-box">
          {clash.code} already exists.{' '}
          {courseId ? (count === 1 ? 'Tap again to move this lecture into it.' : `Tap again to move these ${count} lectures into it.`) : 'Tap again to add them to it.'}
        </p>
      )}
      <button className="big-btn blue" onClick={save} disabled={busy || !code.trim()}>
        {clash ? (courseId ? `Merge into ${clash.code}` : `Add to ${clash.code}`) : 'Save'}
      </button>
    </Sheet>
  )
}
