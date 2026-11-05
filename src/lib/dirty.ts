/**
 * Which local records have changes the server hasn't seen yet. Written by db.ts and
 * settings.ts on every local edit; read and cleared by sync.ts. No imports, on purpose.
 */
export type Dirty = { courses: string[]; lectures: string[]; delCourses: string[]; delLectures: string[]; settings: boolean }
type ListKey = 'courses' | 'lectures' | 'delCourses' | 'delLectures'

const KEY = 'quill.dirty'
export const DIRTY_EVENT = 'quill-dirty'
const empty = (): Dirty => ({ courses: [], lectures: [], delCourses: [], delLectures: [], settings: false })

export function readDirty(): Dirty {
  try {
    return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return empty()
  }
}

function write(d: Dirty) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(DIRTY_EVENT))
}

export function markDirty(kind: ListKey, id: string) {
  const d = readDirty()
  if (!d[kind].includes(id)) d[kind].push(id)
  write(d)
}

export function markSettingsDirty() {
  const d = readDirty()
  d.settings = true
  write(d)
}

/** Take everything that's dirty right now and reset the list (re-add on failure). */
export function takeDirty(): Dirty {
  const d = readDirty()
  try {
    localStorage.setItem(KEY, JSON.stringify(empty()))
  } catch {
    /* ignore */
  }
  return d
}

export function restoreDirty(d: Dirty) {
  const cur = readDirty()
  const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])]
  write({
    courses: merge(cur.courses, d.courses),
    lectures: merge(cur.lectures, d.lectures),
    delCourses: merge(cur.delCourses, d.delCourses),
    delLectures: merge(cur.delLectures, d.delLectures),
    settings: cur.settings || d.settings,
  })
}

export const isEmpty = (d: Dirty) => !d.courses.length && !d.lectures.length && !d.delCourses.length && !d.delLectures.length && !d.settings
