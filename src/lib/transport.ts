/**
 * The only place Quill talks to Gemini. Two routes, same shapes:
 *  - signed in  → POST /api/gemini (your server holds the key, logs usage, enforces the cap)
 *  - this device only → Gemini REST directly with the key saved in Settings
 * Audio uploads always go phone → Google directly; when signed in, the server only opens
 * the upload session, so the key never reaches the phone.
 */
import { loadSettings } from './settings'
import { accessToken } from './supabase'

export const Type = { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY' } as const
export const ThinkingLevel = { MINIMAL: 'MINIMAL', LOW: 'LOW' } as const

export type Part = {
  text?: string
  thought?: boolean
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType: string; fileUri: string }
}
export type ThinkingConfig = { thinkingBudget?: number; thinkingLevel?: string }
export type GenRequest = {
  contents: { role: 'user'; parts: Part[] }[]
  systemInstruction?: { parts: { text: string }[] }
  generationConfig?: {
    responseMimeType?: string
    responseSchema?: object
    temperature?: number
    maxOutputTokens?: number
    thinkingConfig?: ThinkingConfig
  }
}
export type UsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
  promptTokensDetails?: { modality?: string; tokenCount?: number }[]
}
export type GenResponse = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]
  usageMetadata?: UsageMetadata
}
export type GeminiFile = { name: string; uri: string; mimeType?: string; state?: string; expirationTime?: string }

export const createPartFromUri = (fileUri: string, mimeType: string): Part => ({ fileData: { fileUri, mimeType } })
export const textOf = (r: GenResponse) =>
  (r.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought && p.text)
    .map((p) => p.text)
    .join('')

const API = 'https://generativelanguage.googleapis.com'

type Route = { kind: 'server'; token: string } | { kind: 'local'; key: string }

async function route(): Promise<Route> {
  const token = await accessToken()
  if (token) return { kind: 'server', token }
  const key = loadSettings().apiKey
  if (!key) throw new Error('Sign in, or add your Gemini API key in Settings first.')
  return { kind: 'local', key }
}

export async function serverMode() {
  return !!(await accessToken())
}

async function asError(r: Response) {
  let msg = `${r.status} ${r.statusText}`
  try {
    const j = await r.json()
    msg = j?.error?.message ?? j?.error ?? msg
  } catch {
    /* not JSON */
  }
  return new Error(String(msg))
}

async function local(key: string, path: string, init: RequestInit = {}) {
  const r = await fetch(API + path, { ...init, headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  if (!r.ok) throw await asError(r)
  return r
}

async function server<T>(token: string, action: string, body: object): Promise<T> {
  const r = await fetch(`/api/gemini?action=${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw await asError(r)
  return (await r.json()) as T
}

export type CallMeta = { kind: 'transcribe' | 'notes'; lectureId?: string; overCapOk?: boolean }

/** generateContent. When signed in, also returns the server's month-to-date spend. */
export async function generateContent(model: string, body: GenRequest, meta: CallMeta): Promise<{ res: GenResponse; monthSpend?: number }> {
  const r = await route()
  if (r.kind === 'local') {
    const res = await local(r.key, `/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body: JSON.stringify(body) })
    return { res: (await res.json()) as GenResponse }
  }
  const s = loadSettings()
  const out = await server<{ response: GenResponse; monthSpend: number }>(r.token, 'generate', {
    model,
    body,
    ...meta,
    capUsd: s.monthlyCap,
  })
  return { res: out.response, monthSpend: out.monthSpend }
}

/** Upload a file to the Gemini Files API (resumable, bytes go straight to Google). */
export async function uploadFile(blob: Blob, mimeType: string, displayName: string): Promise<GeminiFile> {
  const r = await route()
  let uploadUrl: string
  if (r.kind === 'local') {
    const start = await local(r.key, '/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    })
    uploadUrl = start.headers.get('x-goog-upload-url') ?? ''
  } else {
    uploadUrl = (await server<{ uploadUrl: string }>(r.token, 'uploadStart', { size: blob.size, mimeType, displayName })).uploadUrl
  }
  if (!uploadUrl) throw new Error('Gemini did not open an upload session.')
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: blob,
  })
  if (!up.ok) throw await asError(up)
  return ((await up.json()) as { file: GeminiFile }).file
}

export async function getFile(name: string): Promise<GeminiFile> {
  const r = await route()
  if (r.kind === 'local') return (await (await local(r.key, `/v1beta/${name}`)).json()) as GeminiFile
  return server<GeminiFile>(r.token, 'getFile', { name })
}

export async function listModels(): Promise<{ name: string; supportedGenerationMethods?: string[] }[]> {
  const r = await route()
  if (r.kind === 'local') return ((await (await local(r.key, '/v1beta/models?pageSize=200')).json()) as { models?: [] }).models ?? []
  return (await server<{ models: [] }>(r.token, 'models', {})).models ?? []
}
