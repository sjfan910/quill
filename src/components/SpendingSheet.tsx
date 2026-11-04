import { listLectures } from '../lib/db'
import { useData } from '../lib/hooks'
import { fmtUsd, monthSpend } from '../lib/pricing'
import { loadSettings } from '../lib/settings'
import { Sheet } from './ui'

const month = () => new Date().toISOString().slice(0, 7)
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const KIND: Record<string, string> = { transcribe: 'Transcription', generate: 'Notes', refine: 'Improve' }

export default function SpendingSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lectures = useData(listLectures) ?? []
  if (!open) return null
  const cap = loadSettings().monthlyCap
  const runs = lectures
    .flatMap((l) => l.history.filter((h) => h.usage).map((h) => ({ ...h, title: l.title })))
    .filter((h) => new Date(h.at).toISOString().slice(0, 7) === month())
    .sort((a, b) => b.at - a.at)

  const byKind: Record<string, number> = {}
  const tok = { audio: 0, text: 0, cached: 0, out: 0, think: 0 }
  for (const r of runs) {
    const u = r.usage!
    byKind[r.kind] = (byKind[r.kind] ?? 0) + (u.costUsd ?? 0)
    tok.audio += u.audioTokens ?? 0
    tok.text += Math.max(0, u.promptTokens - (u.audioTokens ?? 0))
    tok.cached += u.cachedTokens
    tok.out += u.outputTokens
    tok.think += u.thoughtsTokens
  }
  const total = monthSpend()

  return (
    <Sheet open={open} onClose={onClose} title="Spending this month">
      <div className="spend-hero">
        <b>{fmtUsd(total)}</b>
        <span>estimated{cap > 0 ? ` · cap $${cap}` : ''}</span>
      </div>

      <h3 className="mini-title">Where it went</h3>
      <ul className="confirm-list">
        {['transcribe', 'generate', 'refine'].map((kind) => (
          <li key={kind}>
            <span>{KIND[kind]}</span>
            <b>{fmtUsd(byKind[kind] ?? 0)}</b>
          </li>
        ))}
      </ul>

      <h3 className="mini-title">Tokens</h3>
      <ul className="confirm-list">
        <li><span>Audio in</span><b>{k(tok.audio)}</b></li>
        <li><span>Text in</span><b>{k(tok.text)}{tok.cached ? ` (${k(tok.cached)} cached)` : ''}</b></li>
        <li><span>Written out</span><b>{k(tok.out)}</b></li>
        <li><span>Thinking</span><b>{k(tok.think)}</b></li>
      </ul>

      <h3 className="mini-title">Recent runs</h3>
      {runs.length === 0 ? (
        <p className="empty small">No Gemini runs yet this month.</p>
      ) : (
        <ul className="runs">
          {runs.slice(0, 15).map((r, i) => (
            <li key={i}>
              <span className="row-main">
                <span className="row-title">{r.title}</span>
                <span className="row-sub">
                  {new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {KIND[r.kind] ?? r.kind} · {r.usage!.model.replace('gemini-', '')}
                </span>
              </span>
              <b>{fmtUsd(r.usage!.costUsd ?? 0)}</b>
            </li>
          ))}
        </ul>
      )}

      <div className="real-bill">
        <p>
          <b>Your real bill</b> lives with Google: Quill can't read it with an API key. These numbers are estimates from this phone only.
        </p>
        <a className="big-btn ghost" href="https://aistudio.google.com/" target="_blank" rel="noreferrer">
          AI Studio → Usage &amp; Spend ↗
        </a>
        <a className="big-btn ghost" href="https://console.cloud.google.com/billing" target="_blank" rel="noreferrer">
          Google Cloud billing reports ↗
        </a>
        <p className="fine">Tip: set a spend cap on AI Studio's Spend page. Google enforces that one; Quill's cap is an estimate.</p>
      </div>
    </Sheet>
  )
}
