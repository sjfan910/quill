import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Sheet, toast } from '../components/ui'
import { deleteLecture, getAudio, getCourse, getLecture, listCourses, nextLectureNumber, patchLecture, putBlob } from '../lib/db'
import { canDirectExport, copyRich, exportToGoogleDoc, preloadGoogle } from '../lib/gdocs'
import { isRunning, lectureCost, processLecture } from '../lib/gemini'
import { planTranscription } from '../lib/gaps'
import { estimate, fmtUsd, monthSpend } from '../lib/pricing'
import { useData } from '../lib/hooks'
import { renderForDocs, renderNotes } from '../lib/markdown'
import { go } from '../lib/router'
import { continueLecture } from '../lib/session'
import { loadSettings } from '../lib/settings'
import type { Lecture as LectureT } from '../lib/types'
import { fmtDate, fmtDuration, fmtTime } from '../lib/util'

const MindMap = lazy(() => import('../components/MindMap'))

export default function Lecture({ id }: { id: string }) {
  const l = useData(() => getLecture(id), [id])
  const course = useData(async () => (l?.courseId ? getCourse(l.courseId) : undefined), [l?.courseId])
  const [tab, setTab] = useState<'notes' | 'map' | 'text'>('notes')
  const [sheet, setSheet] = useState<null | 'improve' | 'export' | 'edit' | 'accurate' | 'preview'>(null)
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

  function generate(feedback?: string, retranscribe = false) {
    if (!loadSettings().apiKey) return go('/settings')
    setStep('Starting…')
    processLecture(id, {
      feedback,
      retranscribe,
      confirmed: retranscribe, // the "Send to Gemini?" sheet already showed cost and cap
      manual: true,
      onProgress: setStep,
      onLearned: (prefs) => setTimeout(() => toast(`🧠 Learned: ${prefs[0]}`), 2800),
    })
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
          {lectureCost(l) > 0 && <span title="Estimated Gemini cost"> · {fmtUsd(lectureCost(l))}</span>}
        </p>
      </div>

      {working ? (
        <div className="state-card">
          <div className="spinner" />
          <p className="state-title">Making your notes</p>
          <p className="state-sub">{step || 'Working on it…'} Keep Quill open for a minute.</p>
          {(l.transcript?.length || l.live?.length) ? (
            <button className="big-btn ghost" onClick={() => setSheet('preview')}>
              👀 Preview transcript
            </button>
          ) : null}
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
            <button className={tab === 'text' ? 'on' : ''} onClick={() => setTab('text')}>
              Transcript
            </button>
          </div>
          {tab === 'notes' ? (
            <article className="notes" onClick={seek} dangerouslySetInnerHTML={{ __html: html }} />
          ) : tab === 'text' ? (
            <Transcript
              l={l}
              onAccurate={() => setSheet('accurate')}
              onSeek={(t) => {
                if (audioRef.current) {
                  audioRef.current.currentTime = t
                  audioRef.current.play().catch(() => {})
                }
              }}
            />
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

      <AccurateSheet
        open={sheet === 'accurate'}
        onClose={() => setSheet(null)}
        lecture={l}
        onSend={() => {
          setSheet(null)
          setTab('notes')
          generate(undefined, true)
        }}
      />
      <Sheet open={sheet === 'preview'} onClose={() => setSheet(null)} title="Transcript preview">
        <TranscriptPreview l={l} />
      </Sheet>
      <ImproveSheet open={sheet === 'improve'} onClose={() => setSheet(null)} lectureId={id} onGo={(fb) => (setSheet(null), generate(fb))} />
      <ExportSheet open={sheet === 'export'} onClose={() => setSheet(null)} lectureId={id} heading={heading} />
      <EditSheet open={sheet === 'edit'} onClose={() => setSheet(null)} lectureId={id} onRegenerate={() => (setSheet(null), generate())} />
    </main>
  )
}

// ------------------------------------------------------------------ Transcript

function Transcript({ l, onSeek, onAccurate }: { l: LectureT; onSeek: (t: number) => void; onAccurate: () => void }) {
  const segs = l.transcript ?? []
  const st = l.transcriptStats
  const freePct = st && st.liveSec + st.paidSec > 0 ? Math.round((100 * st.liveSec) / (st.liveSec + st.paidSec)) : 0
  return (
    <div className="transcript">
      {st && (
        <p className="fine">
          {freePct > 0 ? `${freePct}% transcribed free on your phone · ` : ''}
          {st.paidSec === 0 ? 'Nothing' : fmtDuration(st.paidSec)} sent to Gemini
          {l.liveNote ? ` · ${l.liveNote}` : ''}
        </p>
      )}
      {segs.length > 0 && (
        <div className="transcript-actions">
          <button
            className="btn ghost"
            onClick={() =>
              navigator.clipboard.writeText(transcriptPlain(l)).then(
                () => toast('📋 Transcript copied'),
                () => toast('Copy failed'),
              )
            }
          >
            📋 Copy transcript
          </button>
          {segs.some((s) => s.src === 'live') && (
            <button className="btn ghost" onClick={onAccurate}>
              ✨ Make it accurate
            </button>
          )}
        </div>
      )}
      {segs.length === 0 && <p className="empty">No transcript yet.</p>}
      {segs.map((s, i) => (
        <p key={i} className={s.src === 'gemini' ? 'paid' : ''}>
          <button className="ts" onClick={() => onSeek(s.t)}>
            {fmtTime(s.t)}
          </button>{' '}
          {s.text}
        </p>
      ))}
    </div>
  )
}

function transcriptPlain(l: LectureT) {
  const head = `${l.title} · ${fmtDate(l.createdAt)} · ${fmtDuration(l.durationSec)}`
  return [head, '', ...(l.transcript ?? []).map((s) => `[${fmtTime(s.t)}] ${s.text}`)].join('\n')
}

// ------------------------------------------------------------------ Transcript preview (while notes are being made)

function TranscriptPreview({ l }: { l: LectureT }) {
  const final = l.transcript ?? []
  const draft = l.live ?? []
  const segs = final.length ? final : draft.map((s) => ({ ...s, src: 'live' as const }))
  return (
    <div className="transcript preview">
      <p className="fine">
        {final.length
          ? 'Final transcript. Notes are being written from this.'
          : draft.length
            ? "Free draft from your phone. Gemini is filling any gaps it missed."
            : 'No transcript yet.'}
      </p>
      {segs.map((s, i) => (
        <p key={i} className={s.src === 'gemini' ? 'paid' : ''}>
          <span className="ts">{fmtTime(s.t)}</span> {s.text}
        </p>
      ))}
      {segs.some((s) => s.src === 'live') && (
        <p className="fine hint-box">Looks rough? When the notes are ready, open Transcript → ✨ Make it accurate.</p>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Accurate transcript confirmation

function AccurateSheet({ open, onClose, lecture: l, onSend }: { open: boolean; onClose: () => void; lecture: LectureT; onSend: () => void }) {
  if (!open) return null
  const s = loadSettings()
  const ranges = planTranscription(l.loudness ?? [], [], l.durationSec).ranges
  const sec = ranges.reduce((n, [a, b]) => n + (b - a), 0)
  const words = (l.transcript ?? []).reduce((n, x) => n + x.text.split(/\s+/).length, 0) || l.durationSec * 2.3
  const est = estimate({ transcribeSec: sec, transcribeModel: s.transcribeModel, notesModel: s.model, transcriptWords: words })
  const after = monthSpend() + est
  const overCap = s.monthlyCap > 0 && after > s.monthlyCap
  return (
    <Sheet open={open} onClose={onClose} title="Send to Gemini?">
      <ul className="confirm-list">
        <li>
          <span>Audio sent</span>
          <b>{fmtDuration(sec)}</b>
        </li>
        <li>
          <span>Transcribed by</span>
          <b>{s.transcribeModel.replace('gemini-', '').replace('-latest', '')}</b>
        </li>
        <li>
          <span>Then</span>
          <b>notes remade from the new transcript</b>
        </li>
        <li>
          <span>Estimated cost</span>
          <b>{fmtUsd(est)}</b>
        </li>
        <li>
          <span>This month after</span>
          <b className={overCap ? 'warn' : ''}>
            {fmtUsd(after)}
            {s.monthlyCap > 0 ? ` of $${s.monthlyCap}` : ''}
          </b>
        </li>
      </ul>
      {overCap && <p className="error">This goes over your monthly cap.</p>}
      <p className="fine">The free transcript is replaced. Silence before and after class isn't sent.</p>
      <button className="big-btn blue" onClick={onSend}>
        ✨ Send to Gemini
      </button>
      <button className="big-btn ghost" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
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
