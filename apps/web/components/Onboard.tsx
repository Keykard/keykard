'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { api, getToken, setToken, type AppConfig, getConfig } from '@/lib/api'
import { createPasskey, registrationForDeviceKey, restorePasskey, signIn, storedCredential } from '@/lib/wallet'
import { createDeviceKey, deriveAuthProof, deviceVault, importVaultAndUnlock, unlockDeviceKey } from '@/lib/devicekey'
import { COUNTRIES } from './countries'
import { StartOver } from './StartOver'
import { Stepper } from './Stepper'
import { selfStatusMessage } from '@keycard/sdk'
import { PasswordInput } from './PasswordInput'

type Role = 'borrower' | 'guarantor' | 'merchant'
export type Me = {
  user: { wallet: Address; role: Role; username?: string | null } | null
  identity: { verified: boolean; attestationTx: string | null; selfStatus: string | null }
  line: any
  guaranteeing: any[]
}

/**
 * Shared onboarding for borrowers and guarantors:
 *   1. residence declaration (countries in the server's EXCLUDED_COUNTRIES list are refused)
 *   2. passkey wallet (no seed phrase, no gas token)
 *   3. sign in (WebAuthn assertion)
 *   4. identity via Self (passport NFC, zero-knowledge; we never see the passport)
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
  const [country, setCountry] = useState('')
  const [confirmResidence, setConfirmResidence] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [polling, setPolling] = useState(false)
  const [method, setMethod] = useState<'passkey' | 'password'>('passkey')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [username, setUsername] = useState('')
  const [signinMode, setSigninMode] = useState<'none' | 'password'>('none')

  const refresh = useCallback(async () => {
    if (!getToken()) return setMe(null)
    try {
      const m = await api<Me>('/api/me')
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

  const createAccount = run(async () => {
    const uname = username.trim().toLowerCase()
    if (!/^[a-z0-9._-]{3,30}$/.test(uname)) throw new Error('Username: 3–30 characters, letters, numbers, . _ -')
    const avail = await api<{ available: boolean }>(`/api/username/${encodeURIComponent(uname)}`, { auth: false })
    if (!avail.available) throw new Error('That username is taken.')
    if (method === 'password') {
      if (pw !== pw2) throw new Error('Passwords do not match.')
      const k = await createDeviceKey(pw)
      const keyRegistration = await registrationForDeviceKey(k)
      const authProof = await deriveAuthProof(username, pw)
      const r = await api<{ wallet: Address; token?: string }>('/api/users', {
        auth: false,
        body: { role, username: uname, keyRegistration, backup: { username: uname, authProof, vault: k.vault }, residenceCountry: country, residenceConfirmed: true },
      })
      if (r.token) setToken(r.token)
      else await signIn({ kind: 'password', address: k.address, pk: k.pk }, r.wallet)
      await refresh()
      return
    }
    // the username is the passkey's account name, shown in the phone's passkey picker
    const { cred, registration } = await createPasskey(uname)
    const r = await api<{ wallet: Address; token?: string }>('/api/users', {
      auth: false,
      body: { role, username: uname, registration, residenceCountry: country, residenceConfirmed: true },
    })
    // a verified new registration returns a session directly: no second passkey prompt
    if (r.token) setToken(r.token)
    else await signIn({ kind: 'passkey', cred }, r.wallet)
    await refresh()
  })

  const passwordSignIn = run(async () => {
    const authProof = await deriveAuthProof(username, pw)
    const r = await api<{ wallet: Address; vault: any }>('/api/auth/password', { auth: false, body: { username: username.trim().toLowerCase(), authProof } })
    const k = await importVaultAndUnlock(r.vault, pw)
    if (k.address.toLowerCase() !== r.wallet.toLowerCase()) throw new Error('Wallet mismatch.')
    await signIn({ kind: 'password', address: k.address, pk: k.pk }, k.address)
    await refresh()
  })

  const existingPassword = run(async () => {
    const k = await unlockDeviceKey(pw)
    await signIn({ kind: 'password', address: k.address, pk: k.pk }, k.address)
    await refresh()
  })

  const existing = run(async () => {
    const cred = storedCredential() ?? (await restorePasskey())
    const r = await api<{ wallet: Address; role: Role }>(`/api/passkeys/${encodeURIComponent(cred.id)}`, { auth: false })
    if (r.role !== role) throw new Error(`This passkey belongs to a ${r.role} account.`)
    await signIn({ kind: 'passkey', cred }, r.wallet)
    await refresh()
  })

  const verify = run(async () => {
    const r = await api<{ verificationUrl: string }>('/api/self/session', { method: 'POST' })
    window.open(r.verificationUrl, '_blank', 'noopener')
    setPolling(true)
  })

  const skipVerify = run(async () => {
    await api('/api/dev/verify', { method: 'POST' })
    await refresh()
  })

  const excluded = cfg?.excludedCountries.includes(country)
  const step = !me ? 0 : !me.identity.verified ? 1 : 2

  return (
    <div>
      <Stepper steps={STEPS[role]} at={step} />
      {err && <p className="error">{err}</p>}

      {step === 0 && (
        <div className="panel">
          <span className="eyebrow">Step 1 · Account</span>
          <h2>{role === 'borrower' ? 'Create your KEYKARD' : role === 'merchant' ? 'Accept KEYKARD payments' : 'Create your guarantor account'}</h2>
          {deviceVault() && (
            <div className="notice small">
              This device has a password wallet.{' '}
              <PasswordInput placeholder="Password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ marginTop: 8 }} />
              <button className="block" style={{ marginTop: 8 }} disabled={busy || !pw} onClick={existingPassword}>
                Unlock & sign in
              </button>
            </div>
          )}
          <label htmlFor="un">Username</label>
          <input
            id="un"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
            placeholder="e.g. maria.santos"
          />
          <p className="small muted">Shown on your KEYKARD and in your phone’s passkey list. Letters, numbers, . _ -</p>
          <div className="seg" role="tablist" aria-label="Sign-in method">
            <button role="tab" aria-selected={method === 'passkey'} className={method === 'passkey' ? 'on' : ''} onClick={() => setMethod('passkey')}>
              Face ID
            </button>
            <button role="tab" aria-selected={method === 'password'} className={method === 'password' ? 'on' : ''} onClick={() => setMethod('password')}>
              Password
            </button>
          </div>
          {method === 'passkey' ? (
            <p className="muted small">
              Recommended. Your account is a passkey: Face ID or fingerprint, no seed phrase. KEYKARD pays every network fee.
            </p>
          ) : (
            <>
              <p className="muted small">
                A wallet key is created on this device and locked with your password (the password never leaves the device).
                Faster to sign, but it lives on this device only, and it is only as strong as your password.
              </p>
              <label htmlFor="pw">Password (at least 10 characters)</label>
              <PasswordInput id="pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <label htmlFor="pw2">Repeat password</label>
              <PasswordInput id="pw2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </>
          )}
          <label htmlFor="country">Where do you live?</label>
          <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Select country of residence</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          {excluded && (
            <p className="error small">
              KEYKARD is not available to residents of this country yet.
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={confirmResidence} onChange={(e) => setConfirmResidence(e.target.checked)} />
            <span className="small">I confirm this is my country of residence, and I will tell KEYKARD if it changes.</span>
          </label>
          <p />
          <button
            className="block"
            style={{ marginTop: 8 }}
            disabled={busy || !country || excluded || !confirmResidence || username.trim().length < 3 || (method === 'password' && (pw.length < 10 || pw !== pw2))}
            onClick={createAccount}
          >
            {busy ? (method === 'passkey' ? 'Waiting for passkey…' : 'Creating wallet…') : method === 'passkey' ? 'Create passkey account' : 'Create password account'}
          </button>
          <p className="small muted" style={{ textAlign: 'center' }}>
            Already have one?{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), existing())}>
              Sign in with passkey
            </a>
            {' · '}
            <a href="#" onClick={(e) => (e.preventDefault(), setSigninMode(signinMode === 'password' ? 'none' : 'password'))}>
              Sign in with password
            </a>
          </p>
          {signinMode === 'password' && (
            <div className="panel" style={{ marginTop: 8 }}>
              <label htmlFor="siu">Username</label>
              <input id="siu" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <label htmlFor="sip">Password</label>
              <PasswordInput id="sip" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <p />
              <button className="block" disabled={busy || !username || !pw} onClick={passwordSignIn}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="small muted">Works on any device. Your wallet is stored encrypted; KEYKARD cannot open it.</p>
            </div>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="panel">
          <span className="eyebrow">Step 2 · Verify</span>
          <h2>Verify you’re a real, unique person</h2>
          <p className="small">
            KEYKARD uses <b>Self</b>: tap your passport’s chip on your phone. Self proves three facts with a
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
