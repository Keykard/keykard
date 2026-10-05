'use client'
import { useState } from 'react'
import { api, toBase, usd } from '@/lib/api'

type Offer = { id: number; pctBps: number; maxPerPayment: string; budget: string; spent: string; endsAt: string | null; status: string; live: boolean; ended: boolean }
type Stats = { payments: number; customers: number; cashback: string; sales: string }

/**
 * A shop's own promotion: "N% back, up to $X per payment, until <date>, budget $B". The cashback comes out of the
 * shop's payout automatically and can never exceed the budget. Customers see "N% back" when they pay.
 */
export function MerchantOffer({ offer, stats, feeBps, onChange }: { offer: Offer | null; stats: Stats | null; feeBps: number; onChange: () => void }) {
  const [pct, setPct] = useState('10')
  const [max, setMax] = useState('2')
  const [budget, setBudget] = useState('50')
  const [ends, setEnds] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const current = offer && !offer.ended ? offer : null

  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
      setCreating(false)
      onChange()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const create = run('create', async () => {
    const p = Math.round(Number(pct) * 100)
    if (!(p >= 1 && p <= 5000)) throw new Error('Cashback must be between 0.01% and 50%.')
    await api('/api/merchant/offers', {
      body: { pctBps: p, maxPerPayment: toBase(max).toString(), budget: toBase(budget).toString(), endsAt: ends ? new Date(`${ends}T23:59:59`).toISOString() : null },
    })
  })
  const act = (id: number, a: 'pause' | 'resume' | 'end') => run(a, () => api(`/api/merchant/offers/${id}/${a}`, { method: 'POST' }))

  return (
    <section className="panel" id="offers">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Offers</h2>
        <span className="small muted">KEYKARD fee {feeBps / 100}% per payment</span>
      </div>
      <p className="small muted">Bring customers in with cashback. It’s taken from your payout automatically and never goes over your budget.</p>

      {current && (
        <div className="offer-card">
          <div className="row between">
            <b>{current.pctBps / 100}% back, up to {usd(current.maxPerPayment)} per payment</b>
            <span className={`small ${current.live ? 'ok' : 'warn'}`}>● {current.live ? 'Live' : 'Paused'}</span>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            Budget {usd(current.spent)} of {usd(current.budget)} used{current.endsAt ? ` · ends ${new Date(current.endsAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}
          </p>
          <div className="budget-bar" aria-hidden><i style={{ width: `${Math.min(100, (Number(current.spent) / Number(current.budget)) * 100)}%` }} /></div>
          {stats && (
            <div className="chips" style={{ marginTop: 12 }}>
              <div>Customers<b>{stats.customers}</b></div>
              <div>Sales with offer<b>{usd(stats.sales)}</b></div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            {current.status === 'active'
              ? <button className="ghost" disabled={busy !== null} onClick={act(current.id, 'pause')}>{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>
              : <button disabled={busy !== null} onClick={act(current.id, 'resume')}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>}
            <button className="danger" disabled={busy !== null} onClick={() => confirm('End this offer? Customers stop getting the cashback.') && act(current.id, 'end')()}>
              {busy === 'end' ? 'Ending…' : 'End offer'}
            </button>
          </div>
        </div>
      )}

      {!current && offer?.ended && stats && (
        <p className="small" style={{ marginTop: 10 }}>
          Your last offer ended: {stats.customers} customers, {usd(stats.sales)} in sales, {usd(stats.cashback)} given back.
        </p>
      )}

      {!current && !creating && (
        <button className="block" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>Create an offer</button>
      )}
      {!current && creating && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label htmlFor="o-pct">Cashback (%)</label>
              <input id="o-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
            </div>
            <div>
              <label htmlFor="o-max">Most per payment ($)</label>
              <input id="o-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />
            </div>
            <div>
              <label htmlFor="o-budget">Total budget ($)</label>
              <input id="o-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div>
              <label htmlFor="o-ends">Ends (optional)</label>
              <input id="o-ends" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
            </div>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            Example: a $10 sale gives your customer {usd((toBaseSafe('10') * BigInt(Math.round(Number(pct || 0) * 100))) / 10_000n > toBaseSafe(max) ? toBaseSafe(max) : (toBaseSafe('10') * BigInt(Math.round(Number(pct || 0) * 100))) / 10_000n)} back.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
            <button className="ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button disabled={busy !== null} onClick={create}>{busy === 'create' ? 'Starting…' : 'Start offer'}</button>
          </div>
        </div>
      )}
      {err && <p className="error small">{err}</p>}
    </section>
  )
}

function toBaseSafe(v: string) {
  try {
    return toBase(v || '0')
  } catch {
    return 0n
  }
}
