'use client'

import { useEffect, useState } from 'react'
import { api, getConfig, usd, type AppConfig } from '@/lib/api'

export default function Stats() {
  const [s, setS] = useState<any>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  useEffect(() => {
    const load = () => api('/api/stats', { auth: false }).then(setS).catch(() => {})
    getConfig().then(setCfg).catch(() => {})
    void load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [])
  if (!s) return <main className="wrap"><p className="muted" style={{ marginTop: 40 }}>Loading live numbers…</p></main>
  const items: [React.ReactNode, string][] = [
    [s.lines.opened, 'credit lines opened'],
    [s.users.verified, 'verified humans (Self)'],
    [usd(s.spent.amount), `spent · ${s.spent.count} payments`],
    [usd(s.repaid.amount), `auto-paid · ${s.repaid.count} bills`],
    [s.onTimeRate === null ? '—' : `${Math.round(s.onTimeRate * 100)}%`, 'bills paid on time'],
    [s.lines.withGuarantor, 'lines with a family backup'],
    [usd(s.guarantorPulls.amount), 'paid by family backups'],
    [s.mandatesRevoked, 'auto-pay turned off → frozen'],
    [s.lines.defaulted, 'defaults'],
  ]
  return (
    <main className="wrap wide">
      <span className="eyebrow" style={{ marginTop: 18 }}>Network stats</span>
      <h1 style={{ marginTop: 0 }}>KEYKARD, live</h1>
      <p className="muted small">Every number reconciles to a transaction on Tempo {cfg?.network}. Updates every 15 seconds.</p>
      <div className="grid" style={{ marginTop: 18 }}>
        {items.map(([v, label]) => (
          <div key={label} className="stat"><b>{v}</b><span className="small muted">{label}</span></div>
        ))}
      </div>
      <section className="panel" style={{ marginTop: 22 }}>
        <h2>Recent on-chain events</h2>
        <ul className="list">
          {s.recent.map((r: any) => (
            <li key={r.tx_hash + r.action}>
              <span className="ic" aria-hidden>◆</span>
              <span className="grow">
                <b>{String(r.action).replace(/[._]/g, ' ')}</b>
                <small>{new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small>
              </span>
              <span className="amt">{cfg && <a href={`${cfg.explorerUrl}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">Receipt ↗</a>}</span>
            </li>
          ))}
        </ul>
      </section>
      {cfg && (
        <p className="small muted">
          Contracts: registry <a href={`${cfg.explorerUrl}/address/${(cfg as any).registry}`} className="mono">{(cfg as any).registry}</a> · credit file{' '}
          <a href={`${cfg.explorerUrl}/address/${(cfg as any).lineBook}`} className="mono">{(cfg as any).lineBook}</a>
        </p>
      )}
    </main>
  )
}
