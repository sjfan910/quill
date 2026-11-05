import { useState } from 'react'
import { setLocalOnly, signInWithGoogle } from '../lib/supabase'

export default function Login({ onSkip }: { onSkip: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <main className="page login">
      <div className="login-center">
        <img className="login-logo" src="/icon.svg" alt="" />
        <h1 className="logo">
          Quill<span>.</span>
        </h1>
        <p className="login-tag">Record the lecture. Get the notes.</p>
        <ul className="login-points">
          <li>📝 Notes on every device you sign in on</li>
          <li>🔒 Your Gemini key stays on the server</li>
          <li>💰 Spending tracked and capped for you</li>
        </ul>
      </div>
      <div className="login-actions">
        <button
          className="big-btn google"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await signInWithGoogle() // redirects to Google and back
            } finally {
              setBusy(false)
            }
          }}
        >
          <svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
        <button
          className="big-btn ghost"
          onClick={() => {
            setLocalOnly(true)
            onSkip()
          }}
        >
          Continue as guest
        </button>
        <p className="fine center guest-note">Guest notes stay on this device. You can sign in later from Settings.</p>
      </div>
    </main>
  )
}
