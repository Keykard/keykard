'use client'
import { useState } from 'react'
import { api } from '@/lib/api'
import { CopyText } from './Qr'

/** Opt-in public credit file at /u/<username>: repayment history only, never balances, spending or documents. */
export function CreditFileShare({ username, on, onChange }: { username: string; on: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const link = typeof window !== 'undefined' ? `${window.location.origin}/u/${username}` : `/u/${username}`
  const toggle = async () => {
    setErr(null)
    setBusy(true)
    try {
      await api('/api/me/profile', { body: { public: !on } })
      onChange()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel" id="credit-file">
      <div className="sec-row" style={{ borderTop: 0, paddingTop: 0 }}>
        <span className="grow">
          <h2 style={{ margin: 0 }}>Your credit file</h2>
          <small>
            {on
              ? 'Shared. Anyone with the link sees your on-time bills, missed bills and Self verification. Never your balance, spending or documents.'
              : 'Show a landlord, lender or employer that you pay on time. Every number is also recorded on Tempo.'}
          </small>
        </span>
        <button className="switch" role="switch" aria-checked={on} aria-label="Share my credit file" disabled={busy} onClick={toggle} />
      </div>
      {on && (
        <div style={{ marginTop: 12 }}>
          <CopyText text={link} label="Copy link" />
          <a href={`/u/${username}`} target="_blank" rel="noreferrer" className="small">See what they see ↗</a>
        </div>
      )}
      {err && <p className="error small">{err}</p>}
    </section>
  )
}
