import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Sheet, toast } from '../components/ui'
import { deleteLecture, getAudio, getCourse, getLecture, listCourses, nextLectureNumber, patchLecture, putBlob } from '../lib/db'
import { canDirectExport, copyRich, exportToGoogleDoc, preloadGoogle } from '../lib/gdocs'
import { isRunning, processLecture } from '../lib/gemini'
import { useData } from '../lib/hooks'
import { renderForDocs, renderNotes } from '../lib/markdown'
import { go } from '../lib/router'
import { continueLecture } from '../lib/session'
import { loadSettings } from '../lib/settings'
import { fmtDate, fmtDuration, fmtTime } from '../lib/util'

const MindMap = lazy(() => import('../components/MindMap'))

export default function Lecture({ id }: { id: string }) {
  const l = useData(() => getLecture(id), [id])
  const course = useData(async () => (l?.courseId ? getCourse(l.courseId) : undefined), [l?.courseId])
  const [tab, setTab] = useState<'notes' | 'map'>('notes')
  const [sheet, setSheet] = useState<null | 'improve' | 'export' | 'edit'>(null)
  const [step, setStep] = useState('')
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioUrl, setAudioUrl] = useState<string>()

  useEffect(() => {
    let url: string | undefined
    if (l && l.status !== 'recording') {
      getAudio(id).then((b) => {
        if (b.size) setAudioUrl((url = URL.createObjectURL(b)))
      })
    }
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, l?.status, l?.durationSec]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => preloadGoogle(), [])

  const html = useMemo(() => (l?.notesMd ? renderNotes(l.notesMd) : ''), [l?.notesMd])

  if (!l) return <main className="page" />

  const working = l.status === 'processing' || isRunning(id)
  const heading = course ? `${course.code} · Lecture ${l.number ?? '?'}` : 'Unsorted'

  function generate(feedback?: string) {
    if (!loadSettings().apiKey) return go('/settings')
    setStep('Starting…')
    processLecture(id, { feedback, onProgress: setStep })
      .then(() => toast('✨ Notes ready'))
      .catch(() => {})
  }

  function seek(e: React.MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.ts')?.dataset.t
    if (t && audioRef.current) {
      audioRef.current.currentTime = Number(t)
      audioRef.current.play().catch(() => {})
    }
  }

  return (
    <main className="page lecture">
      <header className="topbar">
        <button className="back" onClick={() => go(l.courseId ? `/course/${l.courseId}` : '/')}>
          ‹ {course?.code ?? 'Home'}
        </button>
        <button className="icon-btn" onClick={() => setSheet('edit')} aria-label="More">
          ⋯
        </button>
      </header>

      <div className="lecture-head">
        <p className="eyebrow" style={{ color: course?.color }}>
          {heading}
        </p>
        <h1>{l.title}</h1>
        <p className="meta">
          {fmtDate(l.createdAt)} · {fmtDuration(l.durationSec)}
        </p>
      </div>

      {working ? (
        <div className="state-card">
          <div className="spinner" />
          <p className="state-title">Making your notes</p>
          <p className="state-sub">{step || 'Working on it…'} You can leave this screen.</p>
        </div>
      ) : !l.notesMd ? (
        <div className="state-card">
          {l.error && <p className="error">{l.error}</p>}
          <p className="state-title">Recording saved</p>
          <p className="state-sub">{fmtDuration(l.durationSec)} of audio, safe on this phone.</p>
          <button className="big-btn blue" onClick={() => generate()}>
            ✨ Make notes
          </button>
          <button
            className="big-btn ghost"
            onClick={() =>
              continueLecture(id)
                .then(() => go(`/record/${id}`))
                .catch(() => toast('🎙️ Microphone unavailable'))
            }
          >
            ● Keep recording
          </button>
        </div>
      ) : (
        <>
          {l.error && <p className="error">{l.error}</p>}
          <div className="seg">
            <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
              Notes
            </button>
            <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>
              Mind map
            </button>
          </div>
          {tab === 'notes' ? (
            <article className="notes" onClick={seek} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <Suspense fallback={<div className="mindmap" />}>
              <MindMap md={l.mindmapMd || `# ${l.title}`} />
            </Suspense>
          )}
        </>
      )}

      <div className="dock">
        {audioUrl && <audio ref={audioRef} src={audioUrl} controls preload="metadata" />}
        {l.notesMd && !working && (
          <div className="dock-actions">
            <button className="btn ghost" onClick={() => setSheet('improve')}>
              ✨ Improve
            </button>
            <button className="btn blue" onClick={() => setSheet('export')}>
              ↗ Google Docs
            </button>
          </div>
        )}
      </div>

      <ImproveSheet open={sheet === 'improve'} onClose={() => setSheet(null)} lectureId={id} onGo={(fb) => (setSheet(null), generate(fb))} />
      <ExportSheet open={sheet === 'export'} onClose={() => setSheet(null)} lectureId={id} heading={heading} />
      <EditSheet open={sheet === 'edit'} onClose={() => setSheet(null)} lectureId={id} onRegenerate={() => (setSheet(null), generate())} />
    </main>
  )
}

// ------------------------------------------------------------------ Improve

const QUICK = ['More concise', 'More detail on examples', 'Explain it simpler', 'Add more exam focus']

function ImproveSheet({ open, onClose, lectureId, onGo }: { open: boolean; onClose: () => void; lectureId: string; onGo: (fb?: string) => void }) {
  const l = useData(() => getLecture(lectureId), [lectureId])
  const [fb, setFb] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function addSlides(files: FileList | null) {
    if (!files?.length || !l) return
    const added = []
    for (const f of Array.from(files)) {
      const key = `${lectureId}:slides:${crypto.randomUUID()}`
      await putBlob(key, f)
      added.push({ key, name: f.name, type: f.type || 'application/pdf', size: f.size })
    }
    await patchLecture(lectureId, { slides: [...l.slides, ...added] })
    toast('📎 Slides attached')
  }

  return (
    <Sheet open={open} onClose={onClose} title="Improve notes">
      <button className="big-btn ghost" onClick={() => fileRef.current?.click()}>
        📎 {l?.slides.length ? `Slides: ${l.slides.map((s) => s.name).join(', ')}` : 'Add lecture slides (PDF)'}
      </button>
      <input ref={fileRef} type="file" accept="application/pdf,image/*" multiple hidden onChange={(e) => addSlides(e.target.files)} />
      <div className="quick">
        {QUICK.map((q) => (
          <button key={q} className={`chip ${fb === q ? 'on' : ''}`} onClick={() => setFb(q)}>
            {q}
          </button>
        ))}
      </div>
      <textarea rows={3} value={fb} onChange={(e) => setFb(e.target.value)} placeholder="Or say what to change…" />
      <button className="big-btn blue" disabled={!fb.trim() && !l?.slides.length} onClick={() => onGo(fb.trim() || undefined)}>
        ✨ Update notes
      </button>
    </Sheet>
  )
}

// ------------------------------------------------------------------ Export

function ExportSheet({ open, onClose, lectureId, heading }: { open: boolean; onClose: () => void; lectureId: string; heading: string }) {
  const l = useData(() => getLecture(lectureId), [lectureId])
  const [busy, setBusy] = useState(false)
  if (!l?.notesMd) return null
  const title = `${heading} — ${l.title}`
  const html = renderForDocs(l.notesMd, `${heading} · ${fmtDate(l.createdAt)} · ${fmtDuration(l.durationSec)}`)

  async function direct() {
    setBusy(true)
    try {
      const url = await exportToGoogleDoc(title, html)
      await patchLecture(lectureId, { gdocUrl: url })
      toast('✅ Saved to Google Docs')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  function copyAndOpen() {
    copyRich(html, l!.notesMd!)
      .then(() => toast('📋 Copied. Paste into the new Doc'))
      .catch(() => toast('Copy failed'))
    window.open('https://docs.new', '_blank')
  }

  return (
    <Sheet open={open} onClose={onClose} title="Send to Google Docs">
      {l.gdocUrl && (
        <a className="big-btn ghost" href={l.gdocUrl} target="_blank" rel="noreferrer">
          📄 Open saved Doc
        </a>
      )}
      {canDirectExport() ? (
        <button className="big-btn blue" onClick={direct} disabled={busy}>
          {busy ? 'Saving…' : l.gdocUrl ? '↻ Save a new copy to Docs' : '↗ Save to Google Docs'}
        </button>
      ) : (
        <>
          <button className="big-btn blue" onClick={copyAndOpen}>
            📋 Copy &amp; open Google Docs
          </button>
          <p className="fine">Then just paste. Want one-tap saving? Add a Google client ID in Settings.</p>
        </>
      )}
      <button
        className="big-btn ghost"
        onClick={() =>
          navigator.clipboard.writeText(l.notesMd!).then(
            () => toast('📋 Markdown copied'),
            () => toast('Copy failed'),
          )
        }
      >
        Copy as Markdown
      </button>
    </Sheet>
  )
}

// ------------------------------------------------------------------ Edit

function EditSheet({ open, onClose, lectureId, onRegenerate }: { open: boolean; onClose: () => void; lectureId: string; onRegenerate: () => void }) {
  const l = useData(() => getLecture(lectureId), [lectureId])
  const courses = useData(listCourses) ?? []
  if (!l) return null

  async function setCourse(courseId: string) {
    const cid = courseId || undefined
    await patchLecture(lectureId, { courseId: cid, number: cid ? await nextLectureNumber(cid, lectureId) : undefined })
  }

  return (
    <Sheet open={open} onClose={onClose} title="Lecture details">
      <label className="field">
        <span>Title</span>
        <input defaultValue={l.title} onBlur={(e) => e.target.value.trim() && patchLecture(lectureId, { title: e.target.value.trim() })} />
      </label>
      <div className="row2">
        <label className="field">
          <span>Class</span>
          <select value={l.courseId ?? ''} onChange={(e) => setCourse(e.target.value)}>
            <option value="">Unsorted</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          <span>Lecture #</span>
          <input type="number" inputMode="numeric" defaultValue={l.number ?? ''} onBlur={(e) => patchLecture(lectureId, { number: Number(e.target.value) || undefined })} />
        </label>
      </div>
      {l.marks.length > 0 && (
        <details className="marks">
          <summary>Your marks ({l.marks.length})</summary>
          <ul>
            {l.marks.map((m, i) => (
              <li key={i}>
                <b>{fmtTime(m.t)}</b> {m.kind === 'star' ? '⭐' : `✎ ${m.text}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      {l.notesMd && (
        <button className="big-btn ghost" onClick={onRegenerate}>
          ↻ Remake notes from scratch
        </button>
      )}
      <button
        className="big-btn danger"
        onClick={async () => {
          if (!confirm('Delete this lecture and its recording?')) return
          await deleteLecture(lectureId)
          go(l.courseId ? `/course/${l.courseId}` : '/', true)
        }}
      >
        Delete lecture
      </button>
    </Sheet>
  )
}
