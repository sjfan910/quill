/**
 * Quill's server: the only place the Gemini API key lives.
 *
 *   POST /api/gemini?action=generate | uploadStart | getFile | models | me
 *   Authorization: Bearer <Supabase access token>
 *
 * Every request: verify the Supabase session → check the email is allowed → act.
 * generate: enforce the monthly cap from the usage ledger, call Gemini, log exact usage.
 *
 * Self-contained on purpose (no local imports) so Vercel bundles it without surprises.
 *
 * Env (Vercel → Project → Settings → Environment Variables):
 *   GEMINI_API_KEY             your Gemini key (server only)
 *   VITE_SUPABASE_URL          https://<project>.supabase.co      (also used by the app)
 *   VITE_SUPABASE_ANON_KEY     Supabase anon/public key           (also used by the app)
 *   SUPABASE_SERVICE_ROLE_KEY  Supabase service role key (server only, writes the usage ledger)
 *   ALLOWED_EMAILS             comma-separated emails allowed to use this server
 *   HARD_CAP_USD               optional absolute monthly ceiling, default 20
 */

const GEMINI = 'https://generativelanguage.googleapis.com'

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined) ?? ''
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

// ---------------------------------------------------------------- auth

type User = { id: string; email: string }

async function verify(req: Request): Promise<User> {
  const sb = env('VITE_SUPABASE_URL') || env('SUPABASE_URL')
  const anon = env('VITE_SUPABASE_ANON_KEY') || env('SUPABASE_ANON_KEY')
  if (!sb || !anon || !env('GEMINI_API_KEY') || !env('SUPABASE_SERVICE_ROLE_KEY')) throw new HttpError(503, 'Quill server is not configured yet (see SETUP.md).')
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'Sign in first.')
  const r = await fetch(`${sb}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new HttpError(401, 'Your session expired. Sign in again.')
  const u = (await r.json()) as { id?: string; email?: string }
  if (!u.id || !u.email) throw new HttpError(401, 'Sign in first.')
  const allowed = env('ALLOWED_EMAILS')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  // Safe default: with no allow-list nobody can spend your key.
  if (!allowed.includes(u.email.toLowerCase())) throw new HttpError(403, `${u.email} isn't allowed to use this Quill.`)
  return { id: u.id, email: u.email }
}

// ---------------------------------------------------------------- usage ledger (Supabase, service role)

function sbAdmin(path: string, init: RequestInit = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  // Legacy service_role keys are JWTs and go in both headers; new sb_secret_ keys go in apikey only.
  const auth: Record<string, string> = key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` }
  return fetch(`${env('VITE_SUPABASE_URL') || env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: { ...auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

const monthStart = () => {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

async function monthSpend(userId: string) {
  const r = await sbAdmin(`usage_log?select=cost_usd&user_id=eq.${encodeURIComponent(userId)}&at=gte.${encodeURIComponent(monthStart())}`)
  if (!r.ok) throw new HttpError(502, 'Could not read the usage ledger.')
  const rows = (await r.json()) as { cost_usd: number | string }[]
  return rows.reduce((n, x) => n + Number(x.cost_usd || 0), 0)
}

// Same estimated rates as src/lib/pricing.ts (USD per 1M tokens, deliberately high-side).
const RATES: [RegExp, { text: number; audio: number; out: number }][] = [
  [/flash-lite/, { text: 0.25, audio: 0.5, out: 1.5 }],
  [/flash/, { text: 0.5, audio: 1.0, out: 3.0 }],
  [/pro/, { text: 2.5, audio: 2.5, out: 15.0 }],
]
type UsageMeta = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
  promptTokensDetails?: { modality?: string; tokenCount?: number }[]
}
function cost(model: string, u: UsageMeta) {
  const r = RATES.find(([re]) => re.test(model))?.[1] ?? { text: 2.5, audio: 2.5, out: 15 }
  const prompt = u.promptTokenCount ?? 0
  const audio = (u.promptTokensDetails ?? []).filter((d) => d.modality === 'AUDIO').reduce((n, d) => n + (d.tokenCount ?? 0), 0)
  const cachedShare = prompt ? Math.min(1, (u.cachedContentTokenCount ?? 0) / prompt) : 0
  const input = ((prompt - audio) * r.text + audio * r.audio) * (1 - cachedShare * 0.75)
  return { usd: (input + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * r.out) / 1e6, audio }
}

// ---------------------------------------------------------------- actions

const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,80}$/

async function geminiFetch(path: string, init: RequestInit = {}) {
  return fetch(GEMINI + path, { ...init, headers: { 'x-goog-api-key': env('GEMINI_API_KEY'), 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
}

async function forwardError(r: Response): Promise<never> {
  let msg = `Gemini error ${r.status}`
  try {
    msg = ((await r.json()) as { error?: { message?: string } }).error?.message ?? msg
  } catch {
    /* ignore */
  }
  throw new HttpError(r.status === 429 ? 429 : r.status >= 500 ? 502 : r.status, msg)
}

async function generate(user: User, b: { model?: string; body?: unknown; kind?: string; lectureId?: string; capUsd?: number; overCapOk?: boolean }) {
  const model = String(b.model ?? '')
  if (!MODEL_RE.test(model)) throw new HttpError(400, 'Bad model name.')
  if (!b.body || typeof b.body !== 'object') throw new HttpError(400, 'Missing request body.')

  const hard = Number(env('HARD_CAP_USD')) || 20
  const cap = Math.min(Number(b.capUsd) > 0 ? Number(b.capUsd) : hard, hard)
  const spent = await monthSpend(user.id)
  if (spent >= hard) throw new HttpError(402, `Hard monthly limit of $${hard} reached on the server.`)
  if (spent >= cap && !b.overCapOk) throw new HttpError(402, `Monthly cap reached ($${spent.toFixed(2)} of $${cap}).`)

  const r = await geminiFetch(`/v1beta/models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(b.body) })
  if (!r.ok) await forwardError(r)
  const response = (await r.json()) as { usageMetadata?: UsageMeta }
  const u = response.usageMetadata ?? {}
  const c = cost(model, u)

  const log = await sbAdmin('usage_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.id,
      lecture_id: b.lectureId ?? null,
      kind: b.kind === 'transcribe' || b.kind === 'slides' ? b.kind : 'notes',
      model,
      prompt_tokens: u.promptTokenCount ?? 0,
      audio_tokens: c.audio,
      cached_tokens: u.cachedContentTokenCount ?? 0,
      output_tokens: u.candidatesTokenCount ?? 0,
      thoughts_tokens: u.thoughtsTokenCount ?? 0,
      cost_usd: Math.round(c.usd * 1e6) / 1e6,
    }),
  })
  if (!log.ok) console.error('usage_log insert failed', log.status, await log.text().catch(() => ''))
  return json({ response, monthSpend: spent + c.usd })
}

async function uploadStart(b: { size?: number; mimeType?: string; displayName?: string }) {
  const size = Number(b.size)
  if (!(size > 0 && size <= 200_000_000)) throw new HttpError(400, 'File too large (200 MB max).')
  const mime = String(b.mimeType ?? '')
  if (!/^(audio|image)\/[a-z0-9.+-]+$|^application\/pdf$/.test(mime)) throw new HttpError(400, 'Unsupported file type.')
  const r = await geminiFetch('/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
    },
    body: JSON.stringify({ file: { display_name: String(b.displayName ?? 'quill').slice(0, 100) } }),
  })
  if (!r.ok) await forwardError(r)
  const uploadUrl = r.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new HttpError(502, 'Gemini did not open an upload session.')
  return json({ uploadUrl })
}

async function getFile(b: { name?: string }) {
  const name = String(b.name ?? '')
  if (!/^files\/[a-z0-9-]{1,64}$/.test(name)) throw new HttpError(400, 'Bad file name.')
  const r = await geminiFetch(`/v1beta/${name}`)
  if (!r.ok) await forwardError(r)
  return json(await r.json())
}

async function models() {
  const r = await geminiFetch('/v1beta/models?pageSize=200')
  if (!r.ok) await forwardError(r)
  return json(await r.json())
}

// ---------------------------------------------------------------- entry

export async function POST(req: Request) {
  try {
    const action = new URL(req.url).searchParams.get('action')
    const user = await verify(req)
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    switch (action) {
      case 'generate':
        return await generate(user, body)
      case 'uploadStart':
        return await uploadStart(body)
      case 'getFile':
        return await getFile(body)
      case 'models':
        return await models()
      case 'me':
        return json({ email: user.email, monthSpend: await monthSpend(user.id), hardCap: Number(env('HARD_CAP_USD')) || 20 })
      default:
        throw new HttpError(404, 'Unknown action.')
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    console.error(e)
    return json({ error: 'Server error.' }, 500)
  }
}

export function GET() {
  return json({ error: 'Use POST.' }, 405)
}
