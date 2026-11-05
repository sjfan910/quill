import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { markDirty } from './dirty'
import type { Course, Lecture } from './types'

interface QuillDB extends DBSchema {
  courses: { key: string; value: Course }
  lectures: { key: string; value: Lecture; indexes: { byCourse: string } }
  chunks: { key: [string, number]; value: { lectureId: string; seq: number; data: Blob } }
  blobs: { key: string; value: Blob }
}

let dbp: Promise<IDBPDatabase<QuillDB>> | null = null
function db() {
  dbp ??= openDB<QuillDB>('quill', 1, {
    upgrade(d) {
      d.createObjectStore('courses', { keyPath: 'id' })
      const l = d.createObjectStore('lectures', { keyPath: 'id' })
      l.createIndex('byCourse', 'courseId')
      d.createObjectStore('chunks', { keyPath: ['lectureId', 'seq'] })
      d.createObjectStore('blobs')
    },
  })
  return dbp
}

// --- tiny change bus so screens re-render when data changes
type Listener = () => void
const listeners = new Set<Listener>()
export function subscribe(fn: Listener) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
function changed() {
  listeners.forEach((fn) => fn())
}

// --- courses
const PALETTE = ['#3D8BFF', '#FFA36C', '#5CC8FF', '#FFCB8E', '#8FA8FF', '#FF8757']

export async function listCourses() {
  const all = await (await db()).getAll('courses')
  return all.sort((a, b) => a.code.localeCompare(b.code))
}
export async function getCourse(id: string) {
  return (await db()).get('courses', id)
}
export async function createCourse(code: string, name = '') {
  const existing = await listCourses()
  const course: Course = {
    id: crypto.randomUUID(),
    code: normalizeCode(code),
    name,
    color: PALETTE[existing.length % PALETTE.length],
    createdAt: Date.now(),
  }
  await (await db()).put('courses', course)
  markDirty('courses', course.id)
  changed()
  return course
}
export async function saveCourse(c: Course) {
  await (await db()).put('courses', c)
  markDirty('courses', c.id)
  changed()
}
export async function deleteCourse(id: string) {
  const d = await db()
  for (const l of await d.getAllFromIndex('lectures', 'byCourse', id)) {
    l.courseId = undefined
    l.number = undefined
    await d.put('lectures', l)
    markDirty('lectures', l.id)
  }
  await d.delete('courses', id)
  markDirty('delCourses', id)
  changed()
}
export function normalizeCode(code: string) {
  // "cs2050" -> "CS 2050"
  const m = code.trim().toUpperCase().match(/^([A-Z]{2,5})\s*-?\s*(\d{4}[A-Z]?)$/)
  return m ? `${m[1]} ${m[2]}` : code.trim()
}
export async function findOrCreateCourse(code: string, name: string) {
  const norm = normalizeCode(code)
  const hit = (await listCourses()).find((c) => c.code.toUpperCase() === norm.toUpperCase())
  if (hit) {
    if (!hit.name && name) await saveCourse({ ...hit, name })
    return hit
  }
  return createCourse(norm, name)
}

// --- lectures
export async function listLectures() {
  const all = await (await db()).getAll('lectures')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}
export async function getLecture(id: string) {
  return (await db()).get('lectures', id)
}
export async function saveLecture(l: Lecture) {
  await (await db()).put('lectures', l)
  markDirty('lectures', l.id)
  changed()
}
export async function patchLecture(id: string, patch: Partial<Lecture>) {
  const d = await db()
  const cur = await d.get('lectures', id)
  if (!cur) return
  const next = { ...cur, ...patch }
  await d.put('lectures', next)
  markDirty('lectures', id)
  changed()
  return next
}
export async function nextLectureNumber(courseId: string, excludeId?: string) {
  const ls = await (await db()).getAllFromIndex('lectures', 'byCourse', courseId)
  return ls.filter((l) => l.id !== excludeId).reduce((m, l) => Math.max(m, l.number ?? 0), 0) + 1
}
export async function deleteLecture(id: string) {
  const d = await db()
  const l = await d.get('lectures', id)
  const tx = d.transaction(['lectures', 'chunks', 'blobs'], 'readwrite')
  await tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]))
  for (const s of l?.slides ?? []) await tx.objectStore('blobs').delete(s.key)
  await tx.objectStore('lectures').delete(id)
  await tx.done
  markDirty('delLectures', id)
  changed()
}

// --- audio chunks (MP3 frames, appended every few seconds while recording)
export async function putChunk(lectureId: string, seq: number, data: Blob) {
  await (await db()).put('chunks', { lectureId, seq, data })
}
export async function getAudio(lectureId: string) {
  const rows = await (await db()).getAll('chunks', IDBKeyRange.bound([lectureId, 0], [lectureId, Infinity]))
  return new Blob(
    rows.map((r) => r.data),
    { type: 'audio/mpeg' },
  )
}

// --- misc blobs (slides)
export async function putBlob(key: string, b: Blob) {
  await (await db()).put('blobs', b, key)
}
export async function getBlob(key: string) {
  return (await db()).get('blobs', key)
}

export async function audioStats(lectureId: string) {
  const rows = await (await db()).getAll('chunks', IDBKeyRange.bound([lectureId, 0], [lectureId, Infinity]))
  const bytes = rows.reduce((n, r) => n + r.data.size, 0)
  const nextSeq = rows.length ? rows[rows.length - 1].seq + 1 : 0
  return { bytes, nextSeq, durationSec: (bytes * 8) / 32000 } // 32 kbps CBR
}

/** Another class already using this code (case-insensitive), if any. */
export async function courseWithCode(code: string, exceptId?: string) {
  const norm = normalizeCode(code).toUpperCase()
  return (await listCourses()).find((c) => c.id !== exceptId && c.code.toUpperCase() === norm)
}

export async function renameCourse(id: string, code: string, name: string) {
  const c = await getCourse(id)
  if (!c) return
  await saveCourse({ ...c, code: normalizeCode(code), name: name.trim() })
}

/** Move every lecture from `fromId` into `intoId` (numbered after its existing ones), then delete `fromId`. */
export async function mergeCourses(fromId: string, intoId: string) {
  const d = await db()
  const from = await d.get('courses', fromId)
  const into = await d.get('courses', intoId)
  if (!from || !into) return
  const moving = (await d.getAllFromIndex('lectures', 'byCourse', fromId)).sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.createdAt - b.createdAt)
  let next = await nextLectureNumber(intoId)
  for (const l of moving) {
    await d.put('lectures', { ...l, courseId: intoId, number: next++ })
    markDirty('lectures', l.id)
  }
  // Keep the target's memory; fall back to the merged class's if the target has none yet.
  await d.put('courses', { ...into, name: into.name || from.name, memory: into.memory || from.memory, memoryUpdatedAt: Date.now() })
  await d.delete('courses', fromId)
  markDirty('courses', intoId)
  markDirty('delCourses', fromId)
  changed()
}

/** File unsorted lectures under a class, numbered after its existing ones. */
export async function fileUnsorted(intoId: string) {
  const d = await db()
  const loose = (await d.getAll('lectures')).filter((l) => !l.courseId && l.status !== 'recording').sort((a, b) => a.createdAt - b.createdAt)
  let next = await nextLectureNumber(intoId)
  for (const l of loose) {
    await d.put('lectures', { ...l, courseId: intoId, number: next++ })
    markDirty('lectures', l.id)
  }
  changed()
  return loose.length
}

// --- applying changes that came from the server (sync.ts). These never mark anything dirty.
export async function putCourseFromServer(c: Course) {
  await (await db()).put('courses', c)
}
export async function removeCourseFromServer(id: string) {
  await (await db()).delete('courses', id)
}
export async function putLectureFromServer(l: Lecture) {
  await (await db()).put('lectures', l)
}
export async function removeLectureFromServer(id: string) {
  const d = await db()
  const tx = d.transaction(['lectures', 'chunks'], 'readwrite')
  await tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]))
  await tx.objectStore('lectures').delete(id)
  await tx.done
}
export const notifyChanged = () => changed()
