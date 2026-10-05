'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api, getToken, setToken, type AppConfig, getConfig } from '@/lib/api'
import { Auth } from './Auth'
import type { Security } from '@/lib/account'
import { StartOver } from './StartOver'
import { Stepper } from './Stepper'
import { selfStatusMessage } from '@keycard/sdk'

type Role = 'borrower' | 'guarantor' | 'merchant'
export type Me = {
  user: { wallet: Address; role: Role; username?: string | null } | null
  identity: { verified: boolean; attestationTx: string | null; selfStatus: string | null }
  line: any
  collateral?: { vault: string; deposited: string; locked: string; available: string; max: string } | null
  security?: Security | null
  guaranteeing: any[]
}

/**
 * Shared onboarding for cardholders, merchants and family backups:
 *   1. account: one sign-in / sign-up for everyone (components/Auth.tsx): username, password, optional passkey
 *   2. identity via Self (passport NFC, zero-knowledge; we never see the passport)
 * Calls onReady(me) once the user is signed in AND verified.
 */
const STEPS: Record<Role, string[]> = {
  borrower: ['Account', 'Verify', 'Auto-pay', 'Card'],
  guarantor: ['Account', 'Verify', 'Guarantee'],
  merchant: ['Account', 'Verify', 'Your shop'],
}

export function Onboard({ role, onReady }: { role: Role; onReady: (me: Me) => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)

  const refresh = useCallback(async () => {
    if (!getToken()) return setMe(null)
    try {
      const m = await api<Me>('/api/me')
      // one sign-in for everyone: send cardholders and merchants to their own home
      const r = m.user?.role
      if (r && r !== role && role !== 'guarantor' && r !== 'guarantor') {
        window.location.replace(r === 'merchant' ? '/merchant' : '/start')
        return
      }
      setMe(m)
      if (m.identity.verified) onReady(m)
    } catch {
      setMe(null)
    }
  }, [onReady])

  useEffect(() => {
    getConfig().then(setCfg).catch((e) => setErr(String(e.message)))
    void refresh()
  }, [refresh])

  const waitingForIdentity = Boolean(me && !me.identity.verified)
  useEffect(() => {
    if (!polling && !waitingForIdentity) return
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [polling, waitingForIdentity, refresh])

  const run = (fn: () => Promise<void>) => async () => {
    setErr(null)
    setBusy(true)
    try {
      await fn()
    } catch (e: any) {
      setErr(
        /NotAllowedError|AbortError|timed out or was not allowed/.test(String(e))
          ? 'The passkey request was cancelled or timed out, or the passkey no longer exists. Try again, or use “Start over”.'
          : e.message ?? String(e),
      )
    } finally {
      setBusy(false)
    }
  }

  const verify = run(async () => {
    const r = await api<{ verificationUrl: string }>('/api/self/session', { method: 'POST' })
    window.open(r.verificationUrl, '_blank', 'noopener')
    setPolling(true)
  })

  const skipVerify = run(async () => {
    await api('/api/dev/verify', { method: 'POST' })
    await refresh()
  })

  const step = !me ? 0 : !me.identity.verified ? 1 : 2

  return (
    <div>
      {/* the sign-in screen has its own heading; the steps only matter once you're in */}
      {step > 0 && <Stepper steps={STEPS[role]} at={step} />}
      {err && <p className="error">{err}</p>}

      {step === 0 && <Auth role={role} lockRole={role === 'guarantor'} onSignedIn={refresh} />}

      {step === 1 && (
        <div className="panel">
          <span className="eyebrow">Step 2 · Verify</span>
          <h2>Verify you’re a real, unique person</h2>
          <p className="small">
            This is our KYC, done with <b>Self</b>: tap your passport’s chip on your phone. Self proves three facts with a
            zero-knowledge proof: you’re over 18, you’re a unique person, and you’re not on a sanctions list. <b>We never see your passport, name or number.</b> One passport = one KEYKARD.
          </p>
          {role === 'guarantor' && <p className="small muted">As a guarantor, your nationality is also shared so we can check the family corridor.</p>}
          {cfg && !cfg.selfEnabled && <p className="notice small">Identity verification (Self) is not configured on this server yet.</p>}
          <button className="block" disabled={busy || !cfg?.selfEnabled} onClick={verify}>
            Verify with Self
          </button>
          {cfg?.devVerify && (
            <>
              <p />
              <button className="ghost block" disabled={busy} onClick={skipVerify}>
                Skip verification (testnet only)
              </button>
            </>
          )}
          {polling && <p className="small notice">Waiting for Self… this page updates by itself when your proof arrives.</p>}
          {(() => {
            const m = me && !me.identity.verified ? selfStatusMessage(me.identity.selfStatus) : null
            return m ? <p className={`${m.kind === 'error' ? 'error' : 'notice'} small`}>{m.text}</p> : null
          })()}
        </div>
      )}
      {step >= 1 && <StartOver />}
    </div>
  )
}
