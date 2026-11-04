import { loadSettings } from './settings'

/**
 * Two ways to get notes into Google Docs:
 *  1. One-tap: with a Google OAuth client ID set in Settings, create the Doc via the Drive API.
 *  2. Zero setup: copy formatted notes to the clipboard and open a new Doc to paste into.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string
            scope: string
            callback: (r: { access_token?: string; error?: string; expires_in?: number }) => void
            error_callback?: (e: { type: string; message?: string }) => void
          }): { requestAccessToken(o?: { prompt?: string }): void }
        }
      }
    }
  }
}

let token: { value: string; exp: number } | null = null

function loadGis() {
  if (window.google?.accounts) return Promise.resolve()
  return new Promise<void>((res, rej) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => res()
    s.onerror = () => rej(new Error('Could not load Google sign-in.'))
    document.head.appendChild(s)
  })
}

/** Preload so the sign-in popup can open inside the tap gesture (iOS blocks it otherwise). */
export function preloadGoogle() {
  if (loadSettings().googleClientId) loadGis().catch(() => {})
}

function getToken(clientId: string) {
  if (token && token.exp > Date.now() + 60_000) return Promise.resolve(token.value)
  return new Promise<string>((res, rej) => {
    if (!window.google?.accounts) return rej(new Error('Google sign-in is still loading. Tap again.'))
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (r) => {
        if (!r.access_token) return rej(new Error(r.error || 'Google sign-in was cancelled.'))
        token = { value: r.access_token, exp: Date.now() + (r.expires_in ?? 3600) * 1000 }
        res(r.access_token)
      },
      error_callback: (e) => rej(new Error(e.message || 'Google sign-in was cancelled.')),
    })
    tc.requestAccessToken()
  })
}

export const canDirectExport = () => !!loadSettings().googleClientId

/** Creates a Google Doc from HTML. Returns its URL. */
export async function exportToGoogleDoc(title: string, html: string) {
  const at = await getToken(loadSettings().googleClientId)
  const boundary = 'quill' + Math.random().toString(36).slice(2)
  const meta = { name: title, mimeType: 'application/vnd.google-apps.document' }
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${at}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!r.ok) {
    if (r.status === 401) token = null
    throw new Error(`Google Drive said ${r.status}: ${(await r.text()).slice(0, 200)}`)
  }
  const j = (await r.json()) as { id: string; webViewLink?: string }
  return j.webViewLink ?? `https://docs.google.com/document/d/${j.id}/edit`
}

/** Copies rich HTML + markdown fallback. Must be called synchronously inside a tap. */
export function copyRich(html: string, plain: string) {
  if ('ClipboardItem' in window && navigator.clipboard?.write) {
    return navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ])
  }
  return navigator.clipboard.writeText(plain)
}
