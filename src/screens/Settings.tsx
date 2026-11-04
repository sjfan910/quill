import { useEffect, useState } from 'react'
import { TopBar, toast } from '../components/ui'
import { listModels } from '../lib/gemini'
import { go } from '../lib/router'
import { DEFAULT_STYLE, MAX_PREFS, loadSettings, saveSettings, type Settings as S } from '../lib/settings'

export default function Settings() {
  const [s, setS] = useState<S>(loadSettings)
  const [models, setModels] = useState<string[]>([])
  const [usage, setUsage] = useState('')
  const [newPref, setNewPref] = useState('')

  const set = (patch: Partial<S>) => {
    const next = { ...s, ...patch }
    setS(next)
    saveSettings(next)
  }

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setUsage(`${((e.usage ?? 0) / 1e6).toFixed(0)} MB used`))
    navigator.storage?.persist?.()
  }, [])

  async function test() {
    try {
      const m = await listModels()
      setModels(m)
      toast(`✅ Key works · ${m.length} models`)
    } catch (e) {
      toast(e instanceof Error && /key/i.test(e.message) ? '❌ Key rejected' : '❌ Could not reach Gemini')
    }
  }

  return (
    <main className="page settings">
      <TopBar back={{ label: 'Home', onClick: () => go('/') }} title="Settings" />

      <section className="card">
        <h2>Gemini API key</h2>
        <input type="password" autoComplete="off" value={s.apiKey} onChange={(e) => set({ apiKey: e.target.value.trim() })} placeholder="Paste your key" />
        <div className="row-btns">
          <button className="btn blue" onClick={test} disabled={!s.apiKey}>
            Test key
          </button>
          <a className="btn ghost" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            Get a key ↗
          </a>
        </div>
        <p className="fine">Stays on this phone. It's only sent to Google.</p>
      </section>

      <section className="card">
        <h2>Model</h2>
        <select value={s.model} onChange={(e) => set({ model: e.target.value })}>
          {[...new Set(['gemini-flash-latest', 'gemini-pro-latest', s.model, ...models])].map((m) => (
            <option key={m} value={m}>
              {m === 'gemini-flash-latest' ? 'Flash (fast, cheap) · recommended' : m === 'gemini-pro-latest' ? 'Pro (smartest, slower)' : m}
            </option>
          ))}
        </select>
      </section>

      <section className="card">
        <h2>🧠 What Quill knows about you</h2>
        <p className="fine">Learned from your "Improve" feedback and applied to every lecture. Remove anything that's wrong.</p>
        {s.prefs.length === 0 ? (
          <p className="empty small">Nothing yet. Give feedback with ✨ Improve and Quill will remember what sticks.</p>
        ) : (
          <ul className="prefs">
            {s.prefs.map((p, i) => (
              <li key={p}>
                <span>{p}</span>
                <button className="icon-btn small" aria-label={`Forget: ${p}`} onClick={() => set({ prefs: s.prefs.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="note-form"
          onSubmit={(e) => {
            e.preventDefault()
            const v = newPref.trim()
            if (!v) return
            set({ prefs: [...s.prefs.filter((p) => p.toLowerCase() !== v.toLowerCase()), v].slice(-MAX_PREFS) })
            setNewPref('')
          }}
        >
          <input value={newPref} onChange={(e) => setNewPref(e.target.value)} placeholder="Add one, e.g. Always include a worked example" />
          <button className="btn ghost" type="submit" disabled={!newPref.trim()}>
            Add
          </button>
        </form>
      </section>

      <section className="card">
        <h2>My note style</h2>
        <p className="fine">Paste one of your own notes here, or describe your style. Every lecture follows it.</p>
        <textarea rows={10} value={s.style} onChange={(e) => set({ style: e.target.value })} />
        {s.style !== DEFAULT_STYLE && (
          <button className="btn ghost" onClick={() => set({ style: DEFAULT_STYLE })}>
            Reset to default
          </button>
        )}
      </section>

      <details className="card">
        <summary>
          <h2>One-tap Google Docs (optional)</h2>
        </summary>
        <p className="fine">
          Without this, export copies your notes and opens a new Doc for you to paste into. To save straight to Drive, create an OAuth
          client ID (Web) in Google Cloud Console, add this site as an authorized JavaScript origin, enable the Drive API, and paste the ID:
        </p>
        <input value={s.googleClientId} onChange={(e) => set({ googleClientId: e.target.value.trim() })} placeholder="xxxx.apps.googleusercontent.com" />
      </details>

      <p className="fine center">Quill · everything is stored on this device{usage && ` · ${usage}`}</p>
    </main>
  )
}
