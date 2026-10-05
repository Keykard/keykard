'use client'

import { useCallback, useEffect, useState } from 'react'
import { Onboard, type Me } from '@/components/Onboard'
import { Qr, CopyText } from '@/components/Qr'
import { api, getConfig, short, usd, type AppConfig } from '@/lib/api'
import { signOut } from '@/lib/wallet'
import { TapToCharge } from '@/components/TapToCharge'
import { AccountBar, WrongAccount } from '@/components/AccountBar'
import { SecureNudge, SecurityPanel } from '@/components/Security'

type Dash = {
  merchant: { code: string; label: string; owner: string; settleTo: string; settlement: string }
  payments: { amount: string; pay_tx: string | null; settle_tx: string; status: string; created_at: string | null }[]
  pending?: { amount: string; pay_tx: string; status: string; created_at: string }[]
  settledTotal: string
  settledCount: number
}

export default function MerchantPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [dash, setDash] = useState<Dash | null>(null)
  const [label, setLabel] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setDash(await api<Dash | null>('/api/merchant/me'))
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])
  const reloadMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/me'))
    } catch {}
  }, [])
  const onReady = useCallback((m: Me) => {
    setMe(m)
    if (m.user?.role === 'merchant') void load()
  }, [load])

  useEffect(() => {
    getConfig().then(setCfg).catch(() => {})
  }, [])
  useEffect(() => {
    if (!dash) return
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [dash, load])

  const register = async () => {
    setErr(null)
    setBusy(true)
    try {
      await api('/api/merchants', { body: { label } })
      await load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const payLink = dash && typeof window !== 'undefined' ? `${window.location.origin}/card?pay=${dash.merchant.code}` : ''

  return (
    <main className="wrap">
      <h1>{dash ? dash.merchant.label : 'Accept KEYKARD'}</h1>
      {!dash && (
        <p className="muted small">
          Get paid by KEYKARD holders. Customers pay from their credit line and you’re settled in{' '}
          {cfg?.tokenSymbol ?? 'USDC'} on Tempo within seconds. <b>Coming next:</b> settlement in local currency to your
          bank, and acceptance on any card terminal through our card-network partner.
        </p>
      )}
      {err && <p className="error">{err}</p>}
      {!me && <Onboard role="merchant" onReady={onReady} />}
      {me && <AccountBar me={me} />}
      {me && me.user?.role !== 'merchant' && <WrongAccount me={me} want="merchant" here="Accepting payments" />}
      {me?.user?.username && <SecureNudge username={me.user.username} sec={me.security ?? null} onChange={reloadMe} />}

      {me && me.user?.role === 'merchant' && !dash && (
        <div className="panel">
          <span className="eyebrow">Step 3 · Your shop</span>
          <h2>Your business</h2>
          <label htmlFor="label">Name customers will see</label>
          <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Tita Rosa’s Sari-Sari Store" />
          <button className="block" style={{ marginTop: 14 }} disabled={busy || label.trim().length < 2} onClick={register}>
            Get my merchant code
          </button>
        </div>
      )}

      {dash && (
        <>
          <div className="chips">
            <div>Received<b>{usd(dash.settledTotal)}</b></div>
            <div>Payments<b>{dash.settledCount}</b></div>
          </div>
          <div className="panel till">
            <span className="eyebrow">Your merchant code</span>
            <div className="code">{dash.merchant.code}</div>
            <Qr value={payLink} size={220} />
            <p className="small muted">Customers scan this to pay you.</p>
            <CopyText text={payLink} label="Copy pay link" />
          </div>
          <TapToCharge merchantCode={dash.merchant.code} onPaid={() => setTimeout(load, 3000)} />
          <section className="panel">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Payments</h2>
              <span className="small muted">Live</span>
            </div>
            {dash.pending && dash.pending.length > 0 && (
              <p className="small notice">
                {dash.pending.length} payment{dash.pending.length > 1 ? 's' : ''} settling now: {dash.pending.map((p) => usd(p.amount)).join(', ')}
              </p>
            )}
            {dash.payments.length === 0 ? (
              <p className="empty">No payments yet. Share your code to get paid.</p>
            ) : (
              <ul className="list">
                {dash.payments.map((p) => (
                  <li key={p.settle_tx}>
                    <span className="ic in" aria-hidden>↙</span>
                    <span className="grow">
                      <b>Payment received</b>
                      <small>{p.created_at ? new Date(p.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Settled'}</small>
                    </span>
                    <span className="amt ok">
                      +{usd(p.amount)}
                      {cfg && <a href={`${cfg.explorerUrl}/tx/${p.settle_tx}`} target="_blank" rel="noreferrer">Receipt ↗</a>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted">
              History is read from the Tempo blockchain. Settled to your KEYKARD wallet <span className="mono">{short(dash.merchant.settleTo)}</span>.
            </p>
          </section>
          {me?.user?.username && <SecurityPanel username={me.user.username} sec={me.security ?? null} onChange={reloadMe} />}
          <button className="ghost block" style={{ marginTop: 8 }} onClick={() => (signOut(), location.reload())}>Sign out</button>
        </>
      )}
    </main>
  )
}
