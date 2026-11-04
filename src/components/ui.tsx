import { useEffect, useState, type ReactNode } from 'react'

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// --- toast
let push: ((m: string) => void) | null = null
export const toast = (m: string) => push?.(m)
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    let t: number
    push = (m) => {
      setMsg(m)
      clearTimeout(t)
      t = window.setTimeout(() => setMsg(null), 2600)
    }
    return () => {
      push = null
    }
  }, [])
  return msg ? <div className="toast">{msg}</div> : null
}

export function TopBar({ back, title, right }: { back?: { label: string; onClick: () => void }; title?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar-side">
        {back && (
          <button className="back" onClick={back.onClick}>
            ‹ {back.label}
          </button>
        )}
      </div>
      {title && <div className="topbar-title">{title}</div>}
      <div className="topbar-side right">{right}</div>
    </header>
  )
}
