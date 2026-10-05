'use client'

import { useEffect, useState } from 'react'
import { addPasskey, cancelRecovery, changePassword, passkeysSupported, removePasskey, resetPassword, setRecovery, type Security as Sec } from '@/lib/account'
import { MIN_PASSWORD, passwordStrength } from '@/lib/devicekey'
import { getSigner, storedCredential } from '@/lib/wallet'
import { PasswordInput } from './PasswordInput'

const friendly = (e: any) => {
  const s = String(e?.message ?? e)
  if (/NotAllowedError|AbortError|timed out or was not allowed/.test(s)) return 'The fingerprint request was cancelled or timed out.'
  if (/cancelled/i.test(s)) return null
  return s
}
const ago = (d: string) => new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * "Finish securing your account": shown once for accounts made before the new sign-in, and whenever a recovery
 * is in progress (with Cancel, in case it isn't the owner).
 */
export function SecureNudge({ username, sec, onChange }: { username: string; sec: Sec | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [hideOffer, setHideOffer] = useState(true)
  useEffect(() => {
    try {
      setHideOffer(localStorage.getItem('keycard.passkeyOfferDismissed') === '1')
    } catch {}
  }, [])
  if (!sec) return null
  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
      setPw('')
      onChange()
    } catch (e: any) {
      setErr(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  if (sec.openRecovery) {
    return (
      <div className="error" role="alert">
        <b>Someone started recovering this account.</b> {sec.openRecovery.status === 'waiting' && sec.openRecovery.readyAt
          ? <>If nothing is done, access moves to their new password at {new Date(sec.openRecovery.readyAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.</>
          : <>They still have to verify with Self.</>} If this wasn’t you, cancel it now.
        <button className="block" style={{ marginTop: 10 }} disabled={busy !== null} onClick={run('cancel', cancelRecovery)}>
          {busy === 'cancel' ? 'Cancelling…' : 'It wasn’t me: cancel recovery'}
        </button>
        {err && <p className="small">{err}</p>}
      </div>
    )
  }

  const strength = passwordStrength(pw)
  if (!sec.hasPassword) {
    return (
      <div className="notice">
        <b>Set a password for your account</b>
        <p className="small" style={{ margin: '6px 0 10px' }}>
          You sign in with a passkey today. A password lets you sign in on any device, and either one can reset the other if you lose it.
        </p>
        <PasswordInput autoComplete="new-password" placeholder={`New password (${MIN_PASSWORD}+ characters)`} value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className={`strength s${strength.score}`} aria-hidden><i /><i /><i /></div>
        <button className="block" style={{ marginTop: 10 }} disabled={busy !== null || strength.score === 0} onClick={run('pw', () => resetPassword(username, pw))}>
          {busy === 'pw' ? 'Confirm with your passkey…' : 'Save password'}
        </button>
        {err && <p className="error small">{err}</p>}
      </div>
    )
  }
  if (!sec.recoveryOn && !sec.recoveryOptOut) {
    return (
      <div className="notice">
        <b>Turn on account recovery</b>
        <p className="small" style={{ margin: '6px 0 10px' }}>
          If you ever lose both your password and your passkey, verifying with Self again gets you back into this same account after a safety wait.
          KEYKARD can’t use it for anything else, and you can turn it off any time.
        </p>
        <button className="block" disabled={busy !== null} onClick={run('rec', () => setRecovery(true))}>{busy === 'rec' ? 'Turning on…' : 'Turn on recovery'}</button>
        {err && <p className="error small">{err}</p>}
      </div>
    )
  }
  if (passkeysSupported() && sec.passkeys.length === 0 && !hideOffer) {
    return (
      <div className="notice">
        <b>Sign in with one tap</b>
        <p className="small" style={{ margin: '6px 0 10px' }}>Add your fingerprint or face. It also lets you reset your password if you forget it.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <button disabled={busy !== null} onClick={run('pk', () => addPasskey(username))}>{busy === 'pk' ? 'Follow the prompt…' : 'Add fingerprint sign-in'}</button>
          <button className="ghost" onClick={() => { try { localStorage.setItem('keycard.passkeyOfferDismissed', '1') } catch {}; setHideOffer(true) }}>Not now</button>
        </div>
        {err && <p className="error small">{err}</p>}
      </div>
    )
  }
  return null
}

/** Settings → Sign-in & security. */
export function SecurityPanel({ username, sec, onChange }: { username: string; sec: Sec | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  if (!sec) return null
  const mine = storedCredential()?.id
  const run = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      setMsg(done)
      setChanging(false)
      setCur('')
      setPw('')
      onChange()
    } catch (e: any) {
      setErr(friendly(e))
    } finally {
      setBusy(null)
    }
  }
  const strength = passwordStrength(pw)

  return (
    <section className="panel" id="security">
      <h2>Sign-in &amp; security</h2>

      <div className="sec-row">
        <span className="grow">
          <b>Password</b>
          <small>{sec.hasPassword ? 'Works on any device. Encrypts your wallet; KEYKARD never sees it.' : 'Not set yet.'}</small>
        </span>
        {sec.hasPassword && !changing && <button className="ghost sm" onClick={() => setChanging(true)}>Change</button>}
      </div>
      {changing && (
        <div style={{ paddingBottom: 14 }}>
          <label>Current password</label>
          <PasswordInput autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          <label>New password</label>
          <PasswordInput autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className={`strength s${strength.score}`} aria-hidden><i /><i /><i /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
            <button className="ghost" onClick={() => setChanging(false)}>Cancel</button>
            <button disabled={busy !== null || !cur || strength.score === 0} onClick={run('pw', () => changePassword(username, cur, pw), 'Password changed.')}>
              {busy === 'pw' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <div className="sec-row">
        <span className="grow">
          <b>Passkeys</b>
          <small>{sec.passkeys.length === 0 ? 'Fingerprint or face sign-in. Also resets your password if you forget it.' : `${sec.passkeys.length} on your account`}</small>
        </span>
        {passkeysSupported() && (
          <button className="ghost sm" disabled={busy !== null} onClick={run('add', () => addPasskey(username, { replace: [] }), 'Passkey added. You can sign in with one tap now.')}>
            {busy === 'add' ? 'Follow the prompt…' : sec.passkeys.length ? 'Add another' : 'Add'}
          </button>
        )}
      </div>
      {sec.passkeys.map((p) => (
        <div className="sec-row" key={p.id} style={{ paddingLeft: 14 }}>
          <span className="grow">
            <span className="small">{p.passkeyId === mine ? 'This device' : 'Passkey'} · added {ago(p.addedAt)}</span>
          </span>
          <button
            className="danger sm"
            disabled={busy !== null || (!sec.hasPassword && sec.passkeys.length === 1)}
            onClick={() => confirm('Remove this passkey? It will stop working everywhere.') && run(`rm${p.id}`, () => removePasskey(p.id), 'Passkey removed.')()}
          >
            {busy === `rm${p.id}` ? 'Removing…' : 'Remove'}
          </button>
        </div>
      ))}

      <div className="sec-row">
        <span className="grow">
          <b>Account recovery</b>
          <small>
            {sec.recoveryOn
              ? 'On. Lost your password and passkey? Verify with Self again and you’re back in after a safety wait.'
              : 'Off. If you lose your password and every passkey, nobody can restore access, including KEYKARD.'}
          </small>
        </span>
        <button
          className="switch"
          role="switch"
          aria-checked={sec.recoveryOn}
          aria-label="Account recovery"
          disabled={busy !== null}
          onClick={() => {
            if (sec.recoveryOn && !confirm('Turn off account recovery? If you lose your password and every passkey, your account can’t be restored.')) return
            void run('rec', async () => setRecovery(!sec.recoveryOn, await getSigner()), sec.recoveryOn ? 'Account recovery is off.' : 'Account recovery is on.')()
          }}
        />
      </div>
      {err && <p className="error small">{err}</p>}
      {msg && <p className="notice small">{msg}</p>}
    </section>
  )
}
