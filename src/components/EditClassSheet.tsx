import { useEffect, useState } from 'react'
import { courseWithCode, createCourse, fileUnsorted, mergeCourses, renameCourse } from '../lib/db'
import { go } from '../lib/router'
import { Sheet, SubmitHint, toast } from './ui'

/** Rename a class (code + name). Renaming onto an existing code offers a merge. Also files Unsorted lectures. */
export default function EditClassSheet({
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
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())}
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
        <input onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Intro to Discrete Math" />
      </label>
      {clash && (
        <p className="hint-box">
          {clash.code} already exists.{' '}
          {courseId ? (count === 1 ? 'Tap again to move this lecture into it.' : `Tap again to move these ${count} lectures into it.`) : 'Tap again to add them to it.'}
        </p>
      )}
      <SubmitHint action="save" />
      <button className="big-btn blue" onClick={save} disabled={busy || !code.trim()}>
        {clash ? (courseId ? `Merge into ${clash.code}` : `Add to ${clash.code}`) : 'Save'}
      </button>
    </Sheet>
  )
}
