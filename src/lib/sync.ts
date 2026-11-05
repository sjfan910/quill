/**
 * Keeps this device and your account in step.
 *
 *   push: every local edit marks a record dirty (dirty.ts); dirty records are upserted.
 *   pull: rows whose server timestamp (synced_at) is newer than the last pull are applied,
 *         unless this device has unpushed edits to the same record (those win, then push).
 *
 * Synced: classes, lectures (notes, mind map, transcript, marks, memory…), settings,
 * the month's spend. Not synced: audio (stays on the phone that recorded it), the
 * per-second loudness log and the raw live transcript, the device's own API key.
 */
import { useEffect, useState } from 'react'
import {
  getCourse,
  getLecture,
  listCourses,
  listLectures,
  notifyChanged,
  putCourseFromServer,
  putLectureFromServer,
  removeCourseFromServer,
  removeLectureFromServer,
  wipeAll,
} from './db'
import { DIRTY_EVENT, isEmpty, readDirty, restoreDirty, takeDirty, type Dirty } from './dirty'
import { syncSpend } from './pricing'
import { SYNCED_SETTINGS, loadSettings, saveSettings } from './settings'
import { signOut, supabase } from './supabase'
import type { Course, Lecture } from './types'

// ---------------------------------------------------------------- status (for the Account card)

export type SyncStatus = { state: 'off' | 'syncing' | 'ok' | 'error'; at?: number; error?: string }
let status: SyncStatus = { state: 'off' }
const statusListeners = new Set<(s: SyncStatus) => void>()
function setStatus(s: SyncStatus) {
  status = s
  statusListeners.forEach((fn) => fn(s))
}
export function useSyncStatus() {
  const [s, setS] = useState(status)
  useEffect(() => {
    statusListeners.add(setS)
    return () => void statusListeners.delete(setS)
  }, [])
  return s
}

// ---------------------------------------------------------------- per-user bookkeeping

const userKey = 'quill.syncUser'
const pulledKey = (uid: string) => `quill.pulledAt.${uid}`
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  },
}

/**
 * First sign-in on this device: upload the notes already here. Settings work the other
 * way round: an account that already has settings wins over this device's defaults.
 */
async function adoptLocalData(uid: string) {
  if (ls.get(userKey) === uid) return
  const { data: prof, error } = await supabase!.from('profiles').select('settings,synced_at').eq('user_id', uid).maybeSingle()
  if (error) throw error
  // Drop any settings edit made before signing in; the account's copy (if any) is applied by pull().
  const pending = takeDirty()
  restoreDirty({
    courses: [...pending.courses, ...(await listCourses()).map((c) => c.id)],
    lectures: [...pending.lectures, ...(await listLectures()).map((l) => l.id)],
    delCourses: pending.delCourses,
    delLectures: pending.delLectures,
    settings: !prof, // only seed the account's settings if it has none yet
  })
  ls.set(userKey, uid)
}

// ---------------------------------------------------------------- push

const LOCAL_ONLY: (keyof Lecture)[] = ['loudness', 'live', 'audioFile']

function forServer(l: Lecture) {
  const copy: Partial<Lecture> = { ...l }
  for (const k of LOCAL_ONLY) delete copy[k]
  return copy
}

async function push(uid: string) {
  const sb = supabase!
  const d = takeDirty()
  if (isEmpty(d)) return
  const keep: Dirty = { courses: [], lectures: [], delCourses: [], delLectures: [], settings: false }
  try {
    const courseRows = []
    for (const id of d.courses) {
      const c = await getCourse(id)
      if (c) courseRows.push({ id, user_id: uid, data: c, deleted: false })
    }
    for (const id of d.delCourses) courseRows.push({ id, user_id: uid, data: {}, deleted: true })
    if (courseRows.length) {
      const { error } = await sb.from('courses').upsert(courseRows)
      if (error) throw error
    }

    const lectureRows = []
    for (const id of d.lectures) {
      const l = await getLecture(id)
      if (!l) continue
      if (l.status === 'recording') {
        keep.lectures.push(id) // upload once the recording is finished
        continue
      }
      lectureRows.push({ id, user_id: uid, data: forServer(l), deleted: false })
    }
    for (const id of d.delLectures) lectureRows.push({ id, user_id: uid, data: {}, deleted: true })
    if (lectureRows.length) {
      const { error } = await sb.from('lectures').upsert(lectureRows)
      if (error) throw error
    }

    if (d.settings) {
      const s = loadSettings() as unknown as Record<string, unknown>
      const settings = Object.fromEntries(SYNCED_SETTINGS.map((k) => [k, s[k]]))
      const { error } = await sb.from('profiles').upsert({ user_id: uid, settings })
      if (error) throw error
    }
    if (!isEmpty(keep)) restoreDirty(keep)
  } catch (e) {
    restoreDirty(d)
    throw e
  }
}

// ---------------------------------------------------------------- pull

type Row<T> = { id: string; data: T; deleted: boolean; synced_at: string }

async function pull(uid: string) {
  const sb = supabase!
  const since = ls.get(pulledKey(uid)) ?? '1970-01-01T00:00:00Z'
  let newest = since
  let changed = false
  const dirty = readDirty()

  const { data: courses, error: e1 } = await sb.from('courses').select('id,data,deleted,synced_at').gt('synced_at', since).order('synced_at')
  if (e1) throw e1
  for (const r of (courses ?? []) as Row<Course>[]) {
    if (r.synced_at > newest) newest = r.synced_at
    if (dirty.courses.includes(r.id) || dirty.delCourses.includes(r.id)) continue
    if (r.deleted) await removeCourseFromServer(r.id)
    else await putCourseFromServer(r.data)
    changed = true
  }

  const { data: lectures, error: e2 } = await sb.from('lectures').select('id,data,deleted,synced_at').gt('synced_at', since).order('synced_at')
  if (e2) throw e2
  for (const r of (lectures ?? []) as Row<Lecture>[]) {
    if (r.synced_at > newest) newest = r.synced_at
    if (dirty.lectures.includes(r.id) || dirty.delLectures.includes(r.id)) continue
    if (r.deleted) {
      await removeLectureFromServer(r.id)
    } else {
      const local = await getLecture(r.id)
      const merged: Lecture = { ...r.data, slides: r.data.slides ?? [], history: r.data.history ?? [], marks: r.data.marks ?? [] }
      // keep what only this device has (audio-related fields)
      if (local) for (const k of LOCAL_ONLY) if (local[k] !== undefined) (merged as Record<string, unknown>)[k] = local[k]
      // a run in progress on another device isn't running here
      if (merged.status === 'processing' || merged.status === 'recording') merged.status = merged.notesMd ? 'ready' : 'saved'
      await putLectureFromServer(merged)
    }
    changed = true
  }

  if (!dirty.settings) {
    const { data: prof, error: e3 } = await sb.from('profiles').select('settings,synced_at').eq('user_id', uid).maybeSingle()
    if (e3) throw e3
    const seenKey = `quill.settingsAt.${uid}`
    if (prof && prof.synced_at !== ls.get(seenKey)) {
      saveSettings({ ...loadSettings(), ...(prof.settings as object) }, { fromServer: true })
      ls.set(seenKey, prof.synced_at)
    }
  }

  // This month's spend from the server ledger (all devices).
  const d = new Date()
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
  const { data: usage, error: e4 } = await sb.from('usage_log').select('cost_usd').gte('at', monthStart)
  if (!e4 && usage) syncSpend(usage.reduce((n, x) => n + Number((x as { cost_usd: number }).cost_usd || 0), 0))

  ls.set(pulledKey(uid), newest)
  if (changed) notifyChanged()
}

// ---------------------------------------------------------------- scheduler

let uid: string | null = null
let running: Promise<void> | null = null
let again = false
let timer: number | undefined
let debounce: number | undefined

export async function syncNow() {
  if (!uid || !supabase) return
  if (running) {
    again = true
    return running
  }
  const me = uid
  running = (async () => {
    setStatus({ ...status, state: 'syncing' })
    try {
      await push(me)
      await pull(me)
      setStatus({ state: 'ok', at: Date.now() })
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e)
      setStatus({ state: 'error', at: status.at, error: navigator.onLine ? msg : 'Offline. Changes will sync when you reconnect.' })
    } finally {
      running = null
      if (again) {
        again = false
        void syncNow()
      }
    }
  })()
  return running
}

const onDirty = () => {
  clearTimeout(debounce)
  debounce = window.setTimeout(() => void syncNow(), 2500)
}
const onVisible = () => {
  if (document.visibilityState === 'visible') void syncNow()
}

export async function startSync(userId: string) {
  if (!supabase) return
  if (uid === userId) return
  stopSync()
  uid = userId
  // Signed in, the key lives on the server: don't keep a copy on this device.
  const s = loadSettings()
  if (s.apiKey) saveSettings({ ...s, apiKey: '' }, { fromServer: true })
  await adoptLocalData(userId)
  window.addEventListener(DIRTY_EVENT, onDirty)
  window.addEventListener('online', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  timer = window.setInterval(() => void syncNow(), 60_000)
  await syncNow()
}

export function stopSync() {
  uid = null
  window.removeEventListener(DIRTY_EVENT, onDirty)
  window.removeEventListener('online', onVisible)
  document.removeEventListener('visibilitychange', onVisible)
  clearInterval(timer)
  clearTimeout(debounce)
  setStatus({ state: 'off' })
}

/**
 * Sign out and leave nothing of the account on this device, so a guest (or another
 * account) starts clean. Saves any unsynced edits first; refuses to wipe if that fails.
 * The account's notes stay safe on the server. Audio isn't synced, so it's gone.
 */
export async function signOutAndClear() {
  if (uid) {
    await syncNow()
    if (!isEmpty(readDirty())) {
      throw new Error("Couldn't save your latest changes to your account. Connect to the internet and try again.")
    }
  }
  stopSync()
  await signOut()
  await wipeAll()
  try {
    for (const k of Object.keys(localStorage)) {
      if (k === 'quill.localOnly') continue
      if (k.startsWith('quill.')) localStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
}
