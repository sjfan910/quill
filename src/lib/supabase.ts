import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

/**
 * Accounts + sync are optional: they switch on when the build has Supabase settings
 * (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY, set in Vercel). Without them Quill runs
 * exactly as before: this device only, with your own Gemini key.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const cloudEnabled = !!(url && anon)

export const supabase: SupabaseClient | null = cloudEnabled
  ? createClient(url!, anon!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })
  : null

let current: Session | null = null
const listeners = new Set<(s: Session | null) => void>()

if (supabase) {
  supabase.auth.getSession().then(({ data }) => setSession(data.session))
  supabase.auth.onAuthStateChange((_event, s) => setSession(s))
}

function setSession(s: Session | null) {
  current = s
  listeners.forEach((fn) => fn(s))
}

export const session = () => current

/** A fresh access token for the server API, or null when signed out / cloud disabled. */
export async function accessToken() {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export function useSession() {
  const [s, setS] = useState<Session | null | undefined>(cloudEnabled ? (current ?? undefined) : null)
  useEffect(() => {
    if (!supabase) return
    const fn = (x: Session | null) => setS(x)
    listeners.add(fn)
    supabase.auth.getSession().then(({ data }) => setS(data.session))
    return () => void listeners.delete(fn)
  }, [])
  return s // undefined = still loading
}

export async function signInWithGoogle() {
  if (!supabase) return
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${location.origin}/`, queryParams: { prompt: 'select_account' } },
  })
}

export async function signOut() {
  await supabase?.auth.signOut()
}

// --- "use without an account" choice (this device only)
const LOCAL_KEY = 'quill.localOnly'
export const localOnly = () => {
  try {
    return localStorage.getItem(LOCAL_KEY) === '1'
  } catch {
    return false
  }
}
export function setLocalOnly(on: boolean) {
  try {
    if (on) localStorage.setItem(LOCAL_KEY, '1')
    else localStorage.removeItem(LOCAL_KEY)
  } catch {
    /* ignore */
  }
}
