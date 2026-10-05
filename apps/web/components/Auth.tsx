'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getConfig, type AppConfig } from '@/lib/api'
import {
  USERNAME_RE,
  abandonRecovery,
  addPasskey,
  finishRecovery,
  lookup,
  normUsername,
  passkeySignIn,
  passkeysSupported,
  pendingRecovery,
  recoveryStatus,
  resetPassword,
  signInWithPassword,
  signUp,
  startRecovery,
  type AccountInfo,
  type Role,
} from '@/lib/account'
import { MIN_PASSWORD, passwordStrength } from '@/lib/devicekey'
import { getSigner, lastUsername } from '@/lib/wallet'
import { COUNTRIES } from './countries'
import { PasswordInput } from './PasswordInput'

/**
 * One way in for everyone (cardholders, merchants, family backups):
 *   username → existing? sign in (passkey in one tap, or password) : create (password, country, what you're here for)
 *   → after sign-up: "add fingerprint sign-in?"
 *   Forgot password → reset with your passkey, or (lost both) recover with your passport after a waiting period.
 */
type Screen =
  | 'username'
  | 'signin'
  | 'create'
  | 'passkey-offer'
  | 'forgot'
  | 'reset'
  | 'recover'
  | 'recover-wait'

const ROLE_COPY: Record<Exclude<Role, 'guarantor'>, { title: string; sub: string }> = {
  borrower: { title: 'Get a card', sub: 'A credit line that grows when you pay on time.' },
  merchant: { title: 'Accept payments', sub: 'Get paid by KEYKARD customers, by tap or QR.' },
}

const friendly = (e: any) => {
  const s = String(e?.message ?? e)
  if (/NotAllowedError|AbortError|timed out or was not allowed/.test(s)) return 'The fingerprint request was cancelled or timed out. Try again.'
  if (/wrong username or password/i.test(s)) return 'That password isn’t right.'
  if (/too many attempts/i.test(s)) return 'Too many tries. Wait 15 minutes, or use “Forgot password?”.'
  return s
}

export function Auth({ role, lockRole, onSignedIn }: { role: Role; lockRole?: boolean; onSignedIn: () => void }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [screen, setScreen] = useState<Screen>('username')
  const [username, setUsername] = useState('')
  const [account, setAccount] = useState<(AccountInfo & { exists: true }) | null>(null)
  const [pw, setPw] = useState('')
  const [country, setCountry] = useState('')
  const [residence, setResidence] = useState(false)
  const [chosenRole, setChosenRole] = useState<Role>(role)
  const [withPasskey, setWithPasskey] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [selfUrl, setSelfUrl] = useState<string | null>(null)
  const pwRef = useRef<HTMLInputElement>(null)
  // decided after mount: the server render can't know, and both renders must match
  const [canPasskey, setCanPasskey] = useState(false)

  useEffect(() => {
    setCanPasskey(passkeysSupported())
    getConfig().then(setCfg).catch(() => {})
    const r = pendingRecovery()
    if (r) {
      setUsername(r.username)
      setScreen('recover-wait')
    } else setUsername(lastUsername())
  }, [])
  useEffect(() => setChosenRole(role), [role])

  const go = (s: Screen) => {
    setErr(null)
    setNote(null)
    setScreen(s)
  }
  const run = (label: string, fn: () => Promise<void>) => async (e?: { preventDefault?: () => void }) => {
    e?.preventDefault?.()
    setErr(null)
    setBusy(label)
    try {
      await fn()
    } catch (x: any) {
      setErr(friendly(x))
    } finally {
      setBusy(null)
    }
  }

  // ---- 1. username ----
  const next = run('next', async () => {
    const u = normUsername(username)
    if (!USERNAME_RE.test(u)) throw new Error('Usernames are 3–30 characters: letters, numbers, dot, dash or underscore.')
    const a = await lookup(u)
    setPw('')
    if (a.exists) {
      setAccount(a)
      go('signin')
    } else {
      setAccount(null)
      go('create')
    }
    setTimeout(() => pwRef.current?.focus(), 50)
  })
  const passkeyAnywhere = run('passkey', async () => {
    await passkeySignIn()
    onSignedIn()
  })

  // ---- 2a. sign in ----
  const withPassword = run('password', async () => {
    await signInWithPassword(username, pw)
    onSignedIn()
  })
  const withAccountPasskey = run('passkey', async () => {
    await passkeySignIn(account!)
    onSignedIn()
  })

  // ---- 2b. create ----
  const strength = passwordStrength(pw)
  const excluded = cfg?.excludedCountries.includes(country)
  const create = run('create', async () => {
    await signUp({ username, password: pw, role: chosenRole, country })
    if (canPasskey) go('passkey-offer')
    else onSignedIn()
  })
  const addFingerprint = run('addpk', async () => {
    await addPasskey(username, { signer: await getSigner() })
    onSignedIn()
  })

  // ---- 3. forgot password ----
  const resetWithPasskey = run('passkey', async () => {
    await passkeySignIn(account!)
    setPw('')
    go('reset')
  })
  const saveNewPassword = run('reset', async () => {
    await resetPassword(username, pw)
    onSignedIn()
  })
  const beginRecovery = run('recover', async () => {
    const r = await startRecovery(username, pw, withPasskey && canPasskey)
    setSelfUrl(r.verificationUrl)
    window.open(r.verificationUrl, '_blank', 'noopener')
    go('recover-wait')
  })

  const Back = ({ to, label = '‹ Back' }: { to: Screen; label?: string }) => (
    <a href="#" className="small" onClick={(e) => (e.preventDefault(), go(to))}>{label}</a>
  )

  return (
    <div className="panel auth">
      {screen === 'username' && (
        <form onSubmit={next}>
          <span className="eyebrow">KEYKARD</span>
          <h2>Sign in or create an account</h2>
          <p className="small muted">One account for cardholders and merchants.</p>
          <label htmlFor="auth-user">Username</label>
          <input
            id="auth-user"
            autoFocus
            autoComplete="username webauthn"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. maria.santos"
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
          />
          <button className="block" style={{ marginTop: 16 }} disabled={busy !== null || username.trim().length < 3}>
            {busy === 'next' ? 'Checking…' : 'Continue'}
          </button>
          {canPasskey && (
            <button type="button" className="ghost block" style={{ marginTop: 10 }} disabled={busy !== null} onClick={passkeyAnywhere}>
              {busy === 'passkey' ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
            </button>
          )}
        </form>
      )}

      {screen === 'signin' && account && (
        <form onSubmit={withPassword}>
          <Back to="username" label="‹ Not you?" />
          <h2 style={{ marginTop: 10 }}>Welcome back, @{normUsername(username)}</h2>
          {canPasskey && account.passkeys.length > 0 && (
            <>
              <button type="button" className="block" style={{ marginTop: 6 }} disabled={busy !== null} onClick={withAccountPasskey}>
                {busy === 'passkey' ? 'Waiting for your passkey…' : 'Continue with passkey'}
              </button>
              <div className="or"><span>or use your password</span></div>
            </>
          )}
          {account.hasPassword ? (
            <>
              <label htmlFor="auth-pw">Password</label>
              <PasswordInput id="auth-pw" ref={pwRef} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <div className="row between" style={{ marginTop: 8 }}>
                <span />
                <a href="#" className="small" onClick={(e) => (e.preventDefault(), go('forgot'))}>Forgot password?</a>
              </div>
              <button className={account.passkeys.length > 0 && canPasskey ? 'ghost block' : 'block'} style={{ marginTop: 12 }} disabled={busy !== null || !pw}>
                {busy === 'password' ? 'Signing in…' : 'Sign in'}
              </button>
            </>
          ) : (
            <p className="small muted">This account signs in with a passkey. After signing in you’ll be asked to set a password too, so you can sign in anywhere.</p>
          )}
        </form>
      )}

      {screen === 'create' && (
        <form onSubmit={create}>
          <Back to="username" />
          <h2 style={{ marginTop: 10 }}>Create your account</h2>
          <p className="small"><span className="ok">●</span> @{normUsername(username)} is available</p>
          <label htmlFor="auth-newpw">Choose a password</label>
          <PasswordInput id="auth-newpw" ref={pwRef} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className={`strength s${strength.score}`} aria-hidden><i /><i /><i /></div>
          <p className="small muted" style={{ marginTop: 6 }}>{pw ? `${strength.label}.` : `At least ${MIN_PASSWORD} characters.`} It locks your wallet on this device; KEYKARD never sees it.</p>

          {!lockRole && role !== 'guarantor' && (
            <>
              <label>What are you here for?</label>
              <div className="choice" role="radiogroup">
                {(['borrower', 'merchant'] as const).map((r) => (
                  <button type="button" key={r} role="radio" aria-checked={chosenRole === r} className={chosenRole === r ? 'on' : ''} onClick={() => setChosenRole(r)}>
                    <b>{ROLE_COPY[r].title}</b>
                    <span>{ROLE_COPY[r].sub}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <label htmlFor="auth-country">Where do you live?</label>
          <select id="auth-country" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Select country of residence</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
          {excluded && <p className="error small">KEYKARD isn’t available to residents of this country yet.</p>}
          <label className="check">
            <input type="checkbox" checked={residence} onChange={(e) => setResidence(e.target.checked)} />
            <span className="small">This is my country of residence, and I’ll tell KEYKARD if it changes.</span>
          </label>
          <button className="block" style={{ marginTop: 16 }} disabled={busy !== null || strength.score === 0 || !country || excluded || !residence}>
            {busy === 'create' ? 'Creating your wallet…' : 'Create account'}
          </button>
          <p className="small muted center" style={{ marginTop: 10 }}>No seed phrase. No fees to set up. You can add fingerprint sign-in next.</p>
        </form>
      )}

      {screen === 'passkey-offer' && (
        <div className="center">
          <div className="auth-ic" aria-hidden>
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 11v4M8.5 8.5a5 5 0 0 1 7 0M6 6a8.5 8.5 0 0 1 12 0M9 13a3 3 0 0 1 6 0v2a7 7 0 0 1-1 3.6M9 16.5a5 5 0 0 1-.6 2.3" /></svg>
          </div>
          <h2>Sign in faster next time</h2>
          <p className="small muted">Add your fingerprint or face as a passkey. One tap to sign in and to pay, and it can reset your password if you forget it.</p>
          <button className="block" style={{ marginTop: 12 }} disabled={busy !== null} onClick={addFingerprint}>
            {busy === 'addpk' ? 'Follow the prompt…' : 'Add fingerprint sign-in'}
          </button>
          <button className="ghost block" style={{ marginTop: 10 }} disabled={busy !== null} onClick={() => onSignedIn()}>Not now</button>
        </div>
      )}

      {screen === 'forgot' && account && (
        <div>
          <Back to="signin" />
          <h2 style={{ marginTop: 10 }}>Forgot your password?</h2>
          {canPasskey && account.passkeys.length > 0 && (
            <div className="opt">
              <b>Use your passkey</b>
              <span className="small muted">Confirm with your fingerprint or face, then choose a new password.</span>
              <button className="block" style={{ marginTop: 10 }} disabled={busy !== null} onClick={resetWithPasskey}>
                {busy === 'passkey' ? 'Waiting for your passkey…' : 'Continue with passkey'}
              </button>
            </div>
          )}
          <div className="opt">
            <b>{account.passkeys.length > 0 ? 'Lost your passkey too?' : 'Recover with Self'}</b>
            {account.recovery ? (
              <>
                <span className="small muted">Choose a new password, then verify again with Self using the same ID you signed up with. For your safety, access comes back after a short wait.</span>
                <button className="ghost block" style={{ marginTop: 10 }} disabled={busy !== null} onClick={() => (setPw(''), go('recover'))}>Recover with Self</button>
              </>
            ) : (
              <span className="small muted">This account can’t be recovered with Self: it never verified with Self, or its owner turned account recovery off.</span>
            )}
          </div>
        </div>
      )}

      {screen === 'reset' && (
        <form onSubmit={saveNewPassword}>
          <h2>Choose a new password</h2>
          <p className="small muted">Your old password stops working everywhere. Your card, money and history stay exactly as they are.</p>
          <label htmlFor="auth-resetpw">New password</label>
          <PasswordInput id="auth-resetpw" autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className={`strength s${strength.score}`} aria-hidden><i /><i /><i /></div>
          <p className="small muted" style={{ marginTop: 6 }}>{pw ? `${strength.label}.` : `At least ${MIN_PASSWORD} characters.`}</p>
          <button className="block" style={{ marginTop: 14 }} disabled={busy !== null || strength.score === 0}>
            {busy === 'reset' ? 'Confirm with your passkey…' : 'Save new password'}
          </button>
        </form>
      )}

      {screen === 'recover' && (
        <form onSubmit={beginRecovery}>
          <Back to="forgot" />
          <h2 style={{ marginTop: 10 }}>Recover @{normUsername(username)}</h2>
          <ol className="steps small">
            <li>Choose a new password.</li>
            <li>Verify with Self, using the same ID you signed up with.</li>
            <li>Wait a short time, then you’re back in: same card, same money.</li>
          </ol>
          <label htmlFor="auth-recpw">New password</label>
          <PasswordInput id="auth-recpw" autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className={`strength s${strength.score}`} aria-hidden><i /><i /><i /></div>
          <p className="small muted" style={{ marginTop: 6 }}>{pw ? `${strength.label}.` : `At least ${MIN_PASSWORD} characters.`}</p>
          {canPasskey && (
            <label className="check">
              <input type="checkbox" checked={withPasskey} onChange={(e) => setWithPasskey(e.target.checked)} />
              <span className="small">Also add this device’s fingerprint or face</span>
            </label>
          )}
          <button className="block" style={{ marginTop: 14 }} disabled={busy !== null || strength.score === 0}>
            {busy === 'recover' ? 'Preparing…' : 'Continue to Self'}
          </button>
        </form>
      )}

      {screen === 'recover-wait' && <RecoveryWait selfUrl={selfUrl} password={pw} onSignedIn={onSignedIn} onRestart={() => (abandonRecovery(), go('username'))} />}

      {err && <p className="error small" role="alert">{err}</p>}
      {note && <p className="notice small">{note}</p>}
    </div>
  )
}

/** Live status of a recovery started on this device: passport check → waiting period → signed in. */
function RecoveryWait({ selfUrl, password, onSignedIn, onRestart }: { selfUrl: string | null; password: string; onSignedIn: () => void; onRestart: () => void }) {
  const r = pendingRecovery()
  const [st, setSt] = useState<Awaited<ReturnType<typeof recoveryStatus>> | null>(null)
  const [now, setNow] = useState(Date.now())
  const [pw, setPw] = useState(password)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const finishing = useRef(false)

  const finish = useCallback(async (p: string) => {
    if (finishing.current) return
    finishing.current = true
    setBusy(true)
    setErr(null)
    try {
      await finishRecovery(p)
      onSignedIn()
    } catch (e: any) {
      setErr(friendly(e))
      finishing.current = false
    } finally {
      setBusy(false)
    }
  }, [onSignedIn])

  useEffect(() => {
    if (!r) return
    let alive = true
    const tick = () =>
      recoveryStatus(r.id)
        .then((s) => {
          if (!alive) return
          setSt(s)
          if (s.status === 'completed' && password) void finish(password)
        })
        .catch(() => {})
    tick()
    const t = setInterval(tick, 4000)
    const c = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      alive = false
      clearInterval(t)
      clearInterval(c)
    }
  }, [r?.id, password, finish])

  if (!r) return null
  const left = st?.readyAt ? Math.max(0, Math.ceil((new Date(st.readyAt).getTime() - now) / 1000)) : null
  const fmt = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60}s` : `${s}s`)

  return (
    <div>
      <h2>Recovering @{r.username}</h2>
      <ol className="progress-steps">
        <li className="done">New password set on this device</li>
        <li className={st?.status === 'awaiting_self' ? 'on' : st && st.status !== 'failed' ? 'done' : ''}>Verified with Self</li>
        <li className={st?.status === 'waiting' ? 'on' : st?.status === 'completed' ? 'done' : ''}>Safety wait</li>
        <li className={st?.status === 'completed' ? 'on' : ''}>Signed back in</li>
      </ol>
      {(!st || st.status === 'awaiting_self') && (
        <>
          <p className="small">Verify in the Self app. This page moves on by itself when it’s done.</p>
          {selfUrl && <button className="ghost block" onClick={() => window.open(selfUrl, '_blank', 'noopener')}>Open Self again</button>}
        </>
      )}
      {st?.status === 'waiting' && (
        <p className="notice small">
          Your Self ID matches this account. For your safety, access comes back in <b>{left !== null ? fmt(left) : '…'}</b>. If someone else started this, the
          account owner can cancel it from any device they’re still signed in on.
        </p>
      )}
      {st?.status === 'completed' && !password && (
        <>
          <p className="small">You’re cleared. Enter the new password you chose to finish.</p>
          <PasswordInput autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="block" style={{ marginTop: 12 }} disabled={busy || !pw} onClick={() => finish(pw)}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </>
      )}
      {st?.status === 'completed' && password && <p className="small">{busy ? 'Signing you in…' : 'Done.'}</p>}
      {st?.status === 'failed' && (
        <>
          <p className="error small">
            {st.error === 'passport_mismatch' ? 'That isn’t the ID this account was verified with.' : 'The Self verification didn’t go through.'}
          </p>
          <button className="ghost block" onClick={onRestart}>Start again</button>
        </>
      )}
      {st?.status === 'cancelled' && (
        <>
          <p className="error small">This recovery was cancelled from the account owner’s device.</p>
          <button className="ghost block" onClick={onRestart}>Back</button>
        </>
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  )
}
