'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api, getConfig, usd, type AppConfig } from '@/lib/api'

type Profile = {
  username: string
  wallet: string
  memberSince: string
  verified: boolean
  attestationTx: string | null
  firstLineAt: string | null
  onTime: number
  missed: number
  defaults: number
  defaultsRepaid: number
  lines: number
  current: { status: string; limit: string; creditAccount: string } | null
  lineBookIds: number[]
}

const month = (d: string | null) => (d ? new Date(d).toLocaleDateString([], { month: 'short', year: 'numeric' }) : '—')

export default function CreditFile() {
  const { username } = useParams<{ username: string }>()
  const [p, setP] = useState<Profile | null>(null)
  const [missing, setMissing] = useState(false)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  useEffect(() => {
    getConfig().then(setCfg).catch(() => {})
    api<Profile>(`/api/profiles/${encodeURIComponent(username)}`, { auth: false }).then(setP).catch(() => setMissing(true))
  }, [username])

  if (missing)
    return (
      <main className="wrap">
        <h1 style={{ marginTop: 40 }}>No credit file here</h1>
        <p className="muted">This account doesn’t exist, or its owner hasn’t chosen to share it.</p>
        <Link href="/" className="btn">What is KEYKARD?</Link>
      </main>
    )
  if (!p) return <main className="wrap"><p className="muted" style={{ marginTop: 40 }}>Loading credit file…</p></main>

  const bills = p.onTime + p.missed
  const rate = bills ? Math.round((p.onTime / bills) * 100) : null
  const standing =
    p.defaults > p.defaultsRepaid ? { text: 'Has an unpaid default', cls: 'bad' }
    : p.missed === 0 && p.onTime > 0 ? { text: 'Every bill paid on time', cls: 'ok' }
    : p.onTime === 0 && p.missed === 0 ? { text: 'New: no bills yet', cls: 'muted' }
    : { text: `${rate}% of bills paid on time`, cls: rate !== null && rate >= 90 ? 'ok' : 'warn' }
  const ex = cfg?.explorerUrl
  const items: [React.ReactNode, string][] = [
    [p.onTime, 'bills paid on time'],
    [p.missed, 'bills missed'],
    [p.defaults === 0 ? 'None' : `${p.defaults}${p.defaultsRepaid ? ` (${p.defaultsRepaid} repaid)` : ''}`, 'defaults'],
    [p.current ? usd(p.current.limit) : '—', 'current credit limit'],
  ]

  return (
    <main className="wrap">
      <span className="eyebrow" style={{ marginTop: 18 }}>KEYKARD credit file</span>
      <h1 style={{ marginTop: 0 }}>@{p.username}</h1>
      <p className={`${standing.cls} small`} style={{ fontWeight: 500 }}>● {standing.text}</p>
      <p className="small muted">
        {p.verified ? 'A real, unique adult, verified with Self in zero knowledge.' : 'Identity check not current.'} Member since {month(p.memberSince)}
        {p.firstLineAt ? ` · first card ${month(p.firstLineAt)}` : ''}.
      </p>

      <div className="grid" style={{ marginTop: 18 }}>
        {items.map(([v, label]) => (
          <div key={label} className="stat"><b>{v}</b><span className="small muted">{label}</span></div>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 22 }}>
        <h2>Check it yourself</h2>
        <p className="small muted">
          These numbers come from KEYKARD’s records, and each one is also written to the LineBook contract on Tempo {cfg?.network}. Nothing here
          needs our word for it.
        </p>
        {ex && (
          <ul className="list">
            {p.attestationTx && (
              <li>
                <span className="ic" aria-hidden>✓</span>
                <span className="grow"><b>Self verification</b><small>Recorded in the KEYKARD registry</small></span>
                <span className="amt"><a href={`${ex}/tx/${p.attestationTx}`} target="_blank" rel="noreferrer">Proof ↗</a></span>
              </li>
            )}
            {cfg?.lineBook && (
              <li>
                <span className="ic" aria-hidden>◆</span>
                <span className="grow">
                  <b>Repayment history</b>
                  <small>LineBook {p.lineBookIds.length ? `line${p.lineBookIds.length > 1 ? 's' : ''} #${p.lineBookIds.join(', #')}` : ''}</small>
                </span>
                <span className="amt"><a href={`${ex}/address/${cfg.lineBook}`} target="_blank" rel="noreferrer">Contract ↗</a></span>
              </li>
            )}
            <li>
              <span className="ic" aria-hidden>◎</span>
              <span className="grow"><b>Wallet</b><small className="mono">{p.wallet}</small></span>
              <span className="amt"><a href={`${ex}/address/${p.wallet}`} target="_blank" rel="noreferrer">Explorer ↗</a></span>
            </li>
          </ul>
        )}
      </section>
      <p className="small muted">
        Shared by its owner, who can hide it at any time. It shows repayment history only: no name, documents, balances or purchases.
        {cfg?.network !== 'mainnet' && ' Tempo testnet.'}
      </p>
      <Link href="/start" className="btn">Get your own KEYKARD</Link>
    </main>
  )
}
