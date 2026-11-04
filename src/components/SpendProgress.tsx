import { useEffect, useState } from 'react'
import { SPEND_EVENT, fmtUsd, monthSpend } from '../lib/pricing'

/** This month's spend, updated the moment any Gemini call is charged. */
export function useMonthSpend() {
  const [spend, setSpend] = useState(monthSpend)
  useEffect(() => {
    const update = () => setSpend(monthSpend())
    window.addEventListener(SPEND_EVENT, update)
    window.addEventListener('storage', update) // other tabs
    window.addEventListener('focus', update) // month rollover / returning to the app
    return () => {
      window.removeEventListener(SPEND_EVENT, update)
      window.removeEventListener('storage', update)
      window.removeEventListener('focus', update)
    }
  }, [])
  return spend
}

export default function SpendProgress({ cap, big = false }: { cap: number; big?: boolean }) {
  const spend = useMonthSpend()
  const hasCap = cap > 0
  const pct = hasCap ? (100 * spend) / cap : 0
  const level = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok'
  return (
    <div className={`spend-progress ${big ? 'big' : ''} ${level}`}>
      <div className="spend-progress-top">
        <span className="spend-progress-amount">{fmtUsd(spend)}</span>
        <span className="spend-progress-of">{hasCap ? `of $${cap} this month` : 'this month · no cap'}</span>
      </div>
      {hasCap && (
        <>
          <div
            className="spend-progress-track"
            role="progressbar"
            aria-label="Spending toward monthly cap"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(100, pct))}
          >
            <span style={{ width: `${Math.max(spend > 0 ? 1.5 : 0, Math.min(100, pct))}%` }} />
          </div>
          <div className="spend-progress-foot">
            <span>{pct < 1 && spend > 0 ? '<1%' : `${Math.round(pct)}%`} used</span>
            <span>{level === 'over' ? `${fmtUsd(spend - cap)} over cap` : `${fmtUsd(cap - spend)} left`}</span>
          </div>
        </>
      )}
    </div>
  )
}
