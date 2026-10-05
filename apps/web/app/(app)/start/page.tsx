'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Onboard, type Me } from '@/components/Onboard'
import { StartOver } from '@/components/StartOver'
import { Stepper } from '@/components/Stepper'
import { AccountBar, WrongAccount } from '@/components/AccountBar'
import { api, duration, getConfig, short, usd } from '@/lib/api'
import { explainChainError, getSigner, signMandate } from '@/lib/wallet'

type Prepared = {
  lineId: number
  creditAccount: `0x${string}`
  mandate: { keyId: `0x${string}`; cap: string; periodSeconds: number; recipient: `0x${string}`; expiry: number }
  startingLimit: string
  merchants: string[]
}

export default function Start() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [prep, setPrep] = useState<Prepared | null>(null)
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)

  const onReady = useCallback(
    async (m: Me) => {
      setMe(m)
      if (m.user?.role !== 'borrower') return
      if (m.line && m.line.status !== 'preparing') return router.replace('/card')
      try {
        setPrep(await api<Prepared>('/api/lines/prepare', { method: 'POST' }))
      } catch (e: any) {
        setErr(e.message)
      }
    },
    [router],
  )

  const accept = async () => {
    if (!prep) return
    setErr(null)
    setBusy(true)
    try {
      const signer = await getSigner()
      setStage(signer.kind === 'passkey' ? 'Approve auto-pay with Face ID (one prompt)…' : 'Signing auto-pay…')
      await signMandate(signer, prep.lineId, prep.mandate)
      setStage('Opening your line on Tempo and issuing your card…')
      await api(`/api/lines/${prep.lineId}/open`, { method: 'POST' })
      router.replace('/card')
    } catch (e: any) {
      setErr(explainChainError(e))
      setStage(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="wrap">
      <h1>Get your KEYKARD</h1>
      <p className="muted small">A minute. No documents stored. Free if you pay on time.</p>
      {!me && <Onboard role="borrower" onReady={onReady} />}
      {me && <AccountBar me={me} />}
      {me && me.user?.role !== 'borrower' && <WrongAccount me={me} want="cardholder" here="Getting a KEYKARD" />}
      {err && <p className="error">{err}</p>}

      {me && prep && (
        <>
        <Stepper steps={['Account', 'Verify', 'Auto-pay', 'Card']} at={2} />
        <div className="panel">
          <span className="eyebrow">Step 3 · Auto-pay</span>
          <h2>Your auto-pay</h2>
          <div className="chips">
            <div>Starting limit<b>{usd(prep.startingLimit)}</b></div>
            <div>Bills every<b>{duration(prep.mandate.periodSeconds)}</b></div>
          </div>
          <p className="small muted">
            At the end of each period, what you spent is repaid automatically from your KEYKARD wallet (
            <span className="mono">{short(me.user?.wallet)}</span>). Keep enough there to cover it.
          </p>
          <MandateTerms prep={prep} />
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span className="small">
              I allow KEYKARD to take what I owe from my wallet each period, up to the cap above, only to KEYKARD. I
              understand I can revoke this at any time, and that revoking it freezes my card.
            </span>
          </label>
          <p />
          <button className="block" disabled={!agree || busy} onClick={accept}>
            {busy ? stage ?? 'Working…' : 'Sign & open my line'}
          </button>
          <p className="small muted center">You pay no network fees. KEYKARD sponsors them.</p>
        </div>
        </>
      )}
      {me && <StartOver />}
    </main>
  )
}

function MandateTerms({ prep }: { prep: Prepared }) {
  const [sym, setSym] = useState('USD')
  useEffect(() => {
    getConfig().then((c) => setSym(c.tokenSymbol)).catch(() => {})
  }, [])
  const rows: [string, React.ReactNode][] = [
    ['Most it can take per period', `${usd(prep.mandate.cap)} ${sym}`],
    ['Period', duration(prep.mandate.periodSeconds)],
    ['Can pay only', <>KEYKARD <span className="mono">{short(prep.mandate.recipient)}</span></>],
    ['Ends', new Date(prep.mandate.expiry * 1000).toISOString().slice(0, 10)],
  ]
  return (
    <div className="consent" aria-label="Auto-pay permission, enforced by the Tempo protocol">
      <span className="eyebrow" style={{ marginBottom: 12 }}>Enforced by the Tempo protocol</span>
      <ul className="list">
        {rows.map(([k, v]) => (
          <li key={k} style={{ padding: '8px 0' }}>
            <span className="grow small">{k}</span>
            <span className="small" style={{ color: 'var(--kc-text)' }}>{v}</span>
          </li>
        ))}
      </ul>
      <p className="small" style={{ margin: '10px 0 0' }}>KEYKARD only takes what you actually owe. The cap is the most it could ever take in one period.</p>
    </div>
  )
}
