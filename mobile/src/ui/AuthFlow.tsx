import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { useSession } from '@/lib/session'
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
import { PasskeyCancelled } from '@/lib/passkey'
import { getSigner, lastUsername } from '@/lib/wallet'
import { Banner, Button, Check, Field, Link, Panel, Row, Text } from './kit'
import { CountryPicker } from './CountryPicker'
import { CheckIcon } from './Icons'
import { color, font } from './theme'

/**
 * One way in for everyone (cardholders, merchants, family backups). Mirrors apps/web/components/Auth.tsx:
 *   username → existing? sign in (passkey in one touch, or password) : create (password, what you're here for, country)
 *   → after sign-up: "add fingerprint sign-in?"
 *   Forgot password → reset with your passkey, or (lost both) recover with your passport after a waiting period.
 */
type Screen = 'username' | 'signin' | 'create' | 'passkey-offer' | 'forgot' | 'reset' | 'recover' | 'recover-wait'

const ROLE_COPY = {
  borrower: { title: 'Get a card', sub: 'A credit line that grows when you pay on time.' },
  merchant: { title: 'Accept payments', sub: 'Get paid by KEYKARD customers, by tap or QR.' },
} as const

const friendly = (e: any): string | null => {
  if (e instanceof PasskeyCancelled || /cancelled/i.test(String(e?.message))) return null
  const s = String(e?.message ?? e)
  if (/wrong username or password/i.test(s)) return 'That password isn’t right.'
  if (/too many attempts/i.test(s)) return 'Too many tries. Wait 15 minutes, or use “Forgot password?”.'
  return s
}

export function Strength({ pw }: { pw: string }) {
  const s = passwordStrength(pw)
  const c = s.score === 1 ? color.bad : s.score === 2 ? color.warn : color.ok
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {[1, 2, 3].map((i) => (
          <View key={i} style={{ flex: 1, height: 3, borderRadius: 3, backgroundColor: s.score >= i ? c : 'rgba(255,255,255,0.08)' }} />
        ))}
      </View>
      <Text v="small" style={{ marginTop: 6 }}>{pw ? `${s.label}.` : `At least ${MIN_PASSWORD} characters.`}</Text>
    </View>
  )
}

function Or({ label }: { label: string }) {
  return (
    <Row style={{ marginTop: 18, gap: 12 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: color.hairline }} />
      <Text v="small" style={{ color: color.text3 }}>{label}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: color.hairline }} />
    </Row>
  )
}

export function AuthFlow({ role, lockRole, onDone }: { role: Role; lockRole?: boolean; onDone: () => void | Promise<unknown> }) {
  const { cfg } = useSession()
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
  const canPasskey = passkeysSupported()

  useEffect(() => {
    const r = pendingRecovery()
    if (r) {
      setUsername(r.username)
      setScreen('recover-wait')
    } else setUsername(lastUsername())
  }, [])
  useEffect(() => setChosenRole(role), [role])

  const go = (s: Screen) => {
    setErr(null)
    setScreen(s)
  }
  const run = (label: string, fn: () => Promise<void>) => async () => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
    } catch (e: any) {
      setErr(friendly(e))
    } finally {
      setBusy(null)
    }
  }
  const success = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})

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
  })
  const anyPasskey = run('passkey', async () => {
    await passkeySignIn()
    success()
    await onDone()
  })
  const withPassword = run('password', async () => {
    await signInWithPassword(username, pw)
    success()
    await onDone()
  })
  const withAccountPasskey = run('passkey', async () => {
    await passkeySignIn(account!)
    success()
    await onDone()
  })
  const strength = passwordStrength(pw)
  const excluded = !!cfg?.excludedCountries.includes(country)
  const create = run('create', async () => {
    await signUp({ username, password: pw, role: chosenRole, country })
    success()
    if (canPasskey) go('passkey-offer')
    else await onDone()
  })
  const addFingerprint = run('addpk', async () => {
    await addPasskey(username, { signer: await getSigner() })
    success()
    await onDone()
  })
  const resetWithPasskey = run('passkey', async () => {
    await passkeySignIn(account!)
    setPw('')
    go('reset')
  })
  const saveNewPassword = run('reset', async () => {
    await resetPassword(username, pw)
    success()
    await onDone()
  })
  const beginRecovery = run('recover', async () => {
    const r = await startRecovery(username, pw, withPasskey && canPasskey)
    go('recover-wait')
    await Linking.openURL(r.verificationUrl)
  })

  return (
    <Panel>
      {screen === 'username' && (
        <>
          <Text v="eyebrow">KEYKARD</Text>
          <Text v="h2" style={{ marginTop: 8 }}>Sign in or create an account</Text>
          <Text v="small" style={{ marginTop: 4 }}>One account for cardholders and merchants.</Text>
          <Field
            testID="auth-username"
            label="Username"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            placeholder="e.g. maria.santos"
            value={username}
            onChangeText={(t) => setUsername(t.replace(/\s/g, ''))}
            onSubmitEditing={() => username.trim().length >= 3 && next()}
            returnKeyType="next"
          />
          <Button testID="auth-continue" title={busy === 'next' ? 'Checking…' : 'Continue'} busy={busy === 'next'} disabled={!!busy || username.trim().length < 3} style={{ marginTop: 16 }} onPress={next} />
          {canPasskey && (
            <Button testID="auth-any-passkey" title={busy === 'passkey' ? 'Waiting for your passkey…' : 'Sign in with a passkey'} kind="ghost" disabled={!!busy} style={{ marginTop: 10 }} onPress={anyPasskey} />
          )}
        </>
      )}

      {screen === 'signin' && account && (
        <>
          <Link title="‹ Not you?" onPress={() => go('username')} />
          <Text v="h2" style={{ marginTop: 12 }}>Welcome back, @{normUsername(username)}</Text>
          {canPasskey && account.passkeys.length > 0 && (
            <>
              <Button testID="auth-passkey" title={busy === 'passkey' ? 'Waiting for your passkey…' : 'Continue with passkey'} busy={busy === 'passkey'} disabled={!!busy} style={{ marginTop: 16 }} onPress={withAccountPasskey} />
              <Or label="or use your password" />
            </>
          )}
          {account.hasPassword ? (
            <>
              <Field testID="auth-password" label="Password" secureTextEntry autoCapitalize="none" autoComplete="current-password" value={pw} onChangeText={setPw} onSubmitEditing={() => pw && withPassword()} />
              <Row between style={{ marginTop: 10 }}>
                <View />
                <Link testID="auth-forgot" title="Forgot password?" onPress={() => go('forgot')} />
              </Row>
              <Button
                testID="auth-signin"
                title={busy === 'password' ? 'Signing in…' : 'Sign in'}
                kind={canPasskey && account.passkeys.length > 0 ? 'ghost' : 'primary'}
                busy={busy === 'password'}
                disabled={!!busy || !pw}
                style={{ marginTop: 14 }}
                onPress={withPassword}
              />
            </>
          ) : (
            <Text v="small" style={{ marginTop: 12 }}>This account signs in with a passkey. After signing in you’ll be asked to set a password too, so you can sign in anywhere.</Text>
          )}
        </>
      )}

      {screen === 'create' && (
        <>
          <Link title="‹ Back" onPress={() => go('username')} />
          <Text v="h2" style={{ marginTop: 12 }}>Create your account</Text>
          <Text v="small" style={{ marginTop: 4, color: color.ok }}>● @{normUsername(username)} is available</Text>
          <Field testID="auth-new-password" label="Choose a password" secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw} onChangeText={setPw} />
          <Strength pw={pw} />
          <Text v="small" style={{ marginTop: 2 }}>It locks your wallet on this phone; KEYKARD never sees it.</Text>
          {!lockRole && role !== 'guarantor' && (
            <>
              <Text v="label" style={{ marginTop: 18, marginBottom: 8 }}>What are you here for?</Text>
              <Row style={{ gap: 8, alignItems: 'stretch' }}>
                {(['borrower', 'merchant'] as const).map((r) => (
                  <Pressable
                    key={r}
                    testID={`auth-role-${r}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: chosenRole === r }}
                    onPress={() => setChosenRole(r)}
                    style={{ flex: 1, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: chosenRole === r ? color.accent : color.hairline, backgroundColor: chosenRole === r ? 'rgba(139,124,255,0.1)' : color.surface2 }}
                  >
                    <Text style={{ color: color.text, fontFamily: font.medium, fontSize: 15 }}>{ROLE_COPY[r].title}</Text>
                    <Text v="small" style={{ marginTop: 4 }}>{ROLE_COPY[r].sub}</Text>
                  </Pressable>
                ))}
              </Row>
            </>
          )}
          <CountryPicker value={country} onChange={setCountry} excluded={cfg?.excludedCountries ?? []} />
          {excluded && <Banner kind="error">KEYKARD isn’t available to residents of this country yet.</Banner>}
          <Check testID="auth-residence" checked={residence} onChange={setResidence}>
            This is my country of residence, and I’ll tell KEYKARD if it changes.
          </Check>
          <Button
            testID="auth-create"
            title={busy === 'create' ? 'Creating your wallet…' : 'Create account'}
            busy={busy === 'create'}
            disabled={!!busy || strength.score === 0 || !country || excluded || !residence}
            style={{ marginTop: 18 }}
            onPress={create}
          />
          <Text v="small" style={{ textAlign: 'center', marginTop: 10 }}>No seed phrase. No fees to set up. You can add fingerprint sign-in next.</Text>
        </>
      )}

      {screen === 'passkey-offer' && (
        <View style={{ alignItems: 'center' }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(139,124,255,0.12)', borderWidth: 1, borderColor: 'rgba(139,124,255,0.35)' }}>
            <Text style={{ fontSize: 28, color: color.accentHi }}>☝︎</Text>
          </View>
          <Text v="h2" style={{ marginTop: 14, textAlign: 'center' }}>Sign in faster next time</Text>
          <Text v="small" style={{ marginTop: 6, textAlign: 'center' }}>Add your fingerprint or face as a passkey. One touch to sign in and to pay, and it can reset your password if you forget it.</Text>
          <Button testID="auth-add-passkey" title={busy === 'addpk' ? 'Follow the prompt…' : 'Add fingerprint sign-in'} busy={busy === 'addpk'} disabled={!!busy} style={{ marginTop: 16, alignSelf: 'stretch' }} onPress={addFingerprint} />
          <Button testID="auth-not-now" title="Not now" kind="ghost" disabled={!!busy} style={{ marginTop: 10, alignSelf: 'stretch' }} onPress={() => void onDone()} />
        </View>
      )}

      {screen === 'forgot' && account && (
        <>
          <Link title="‹ Back" onPress={() => go('signin')} />
          <Text v="h2" style={{ marginTop: 12 }}>Forgot your password?</Text>
          {canPasskey && account.passkeys.length > 0 && (
            <View style={{ marginTop: 14, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface2 }}>
              <Text style={{ color: color.text, fontFamily: font.medium }}>Use your passkey</Text>
              <Text v="small" style={{ marginTop: 4 }}>Confirm with your fingerprint or face, then choose a new password.</Text>
              <Button testID="auth-reset-passkey" title={busy === 'passkey' ? 'Waiting for your passkey…' : 'Continue with passkey'} busy={busy === 'passkey'} disabled={!!busy} style={{ marginTop: 12 }} onPress={resetWithPasskey} />
            </View>
          )}
          <View style={{ marginTop: 12, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: color.hairline, backgroundColor: color.surface2 }}>
            <Text style={{ color: color.text, fontFamily: font.medium }}>{account.passkeys.length > 0 ? 'Lost your passkey too?' : 'Recover with your passport'}</Text>
            {account.recovery ? (
              <>
                <Text v="small" style={{ marginTop: 4 }}>Choose a new password, then scan the passport you verified with. For your safety, access comes back after a short wait.</Text>
                <Button testID="auth-recover" title="Recover with passport" kind="ghost" disabled={!!busy} style={{ marginTop: 12 }} onPress={() => (setPw(''), go('recover'))} />
              </>
            ) : (
              <Text v="small" style={{ marginTop: 4 }}>This account can’t be recovered with a passport: it never verified one, or its owner turned account recovery off.</Text>
            )}
          </View>
        </>
      )}

      {screen === 'reset' && (
        <>
          <Text v="h2">Choose a new password</Text>
          <Text v="small" style={{ marginTop: 6 }}>Your old password stops working everywhere. Your card, money and history stay exactly as they are.</Text>
          <Field testID="auth-reset-password" label="New password" secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw} onChangeText={setPw} />
          <Strength pw={pw} />
          <Button testID="auth-save-password" title={busy === 'reset' ? 'Confirm with your passkey…' : 'Save new password'} busy={busy === 'reset'} disabled={!!busy || strength.score === 0} style={{ marginTop: 16 }} onPress={saveNewPassword} />
        </>
      )}

      {screen === 'recover' && (
        <>
          <Link title="‹ Back" onPress={() => go('forgot')} />
          <Text v="h2" style={{ marginTop: 12 }}>Recover @{normUsername(username)}</Text>
          {['Choose a new password.', 'Scan the passport you verified with, in the Self app.', 'Wait a short time, then you’re back in: same card, same money.'].map((t, i) => (
            <Row key={i} style={{ alignItems: 'flex-start', marginTop: 10 }}>
              <Text style={{ color: color.accentHi, fontFamily: font.monoMedium, width: 18 }}>{i + 1}</Text>
              <Text v="small" style={{ flex: 1, color: color.text }}>{t}</Text>
            </Row>
          ))}
          <Field testID="auth-recover-password" label="New password" secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw} onChangeText={setPw} />
          <Strength pw={pw} />
          {canPasskey && (
            <Check checked={withPasskey} onChange={setWithPasskey}>Also add this phone’s fingerprint or face</Check>
          )}
          <Button testID="auth-recover-go" title={busy === 'recover' ? 'Preparing…' : 'Continue to passport check'} busy={busy === 'recover'} disabled={!!busy || strength.score === 0} style={{ marginTop: 16 }} onPress={beginRecovery} />
        </>
      )}

      {screen === 'recover-wait' && (
        <RecoveryWait password={pw} onDone={onDone} onRestart={async () => (await abandonRecovery(), go('username'))} />
      )}

      {err && <Banner kind="error">{err}</Banner>}
    </Panel>
  )
}

function RecoveryWait({ password, onDone, onRestart }: { password: string; onDone: () => void | Promise<unknown>; onRestart: () => void }) {
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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      await onDone()
    } catch (e: any) {
      setErr(friendly(e))
      finishing.current = false
    } finally {
      setBusy(false)
    }
  }, [onDone])

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
  const steps: [string, 'done' | 'on' | 'todo'][] = [
    ['New password set on this phone', 'done'],
    ['Passport checked with Self', st?.status === 'awaiting_self' || !st ? 'on' : st.status === 'failed' ? 'todo' : 'done'],
    ['Safety wait', st?.status === 'waiting' ? 'on' : st?.status === 'completed' ? 'done' : 'todo'],
    ['Signed back in', st?.status === 'completed' ? 'on' : 'todo'],
  ]
  return (
    <>
      <Text v="h2">Recovering @{r.username}</Text>
      <View style={{ marginTop: 14, gap: 12 }}>
        {steps.map(([label, state]) => (
          <Row key={label} style={{ gap: 12 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: state === 'done' ? color.ok : state === 'on' ? color.accent : 'rgba(255,255,255,0.2)', backgroundColor: state === 'done' ? color.ok : 'transparent' }}>
              {state === 'done' && <CheckIcon size={13} stroke={color.bg} />}
            </View>
            <Text style={{ color: state === 'todo' ? color.text3 : color.text, fontSize: 15 }}>{label}</Text>
          </Row>
        ))}
      </View>
      {(!st || st.status === 'awaiting_self') && (
        <>
          <Text v="small" style={{ marginTop: 14 }}>Scan your passport in the Self app. This screen moves on by itself when it’s done.</Text>
        </>
      )}
      {st?.status === 'waiting' && (
        <Banner kind="info">
          <Text v="small" style={{ color: color.text }}>
            Passport matched. For your safety, access comes back in {left !== null ? fmt(left) : '…'}. If someone else started this, the account owner can cancel it from any device they’re still signed in on.
          </Text>
        </Banner>
      )}
      {st?.status === 'completed' && !password && (
        <>
          <Text v="small" style={{ marginTop: 12 }}>You’re cleared. Enter the new password you chose to finish.</Text>
          <Field secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw} onChangeText={setPw} />
          <Button title={busy ? 'Signing in…' : 'Sign in'} busy={busy} disabled={!pw} style={{ marginTop: 12 }} onPress={() => finish(pw)} />
        </>
      )}
      {st?.status === 'failed' && (
        <>
          <Banner kind="error">{st.error === 'passport_mismatch' ? 'That passport isn’t the one this account was verified with.' : 'The passport check didn’t go through.'}</Banner>
          <Button title="Start again" kind="ghost" style={{ marginTop: 12 }} onPress={onRestart} />
        </>
      )}
      {st?.status === 'cancelled' && (
        <>
          <Banner kind="error">This recovery was cancelled from the account owner’s device.</Banner>
          <Button title="Back" kind="ghost" style={{ marginTop: 12 }} onPress={onRestart} />
        </>
      )}
      {err && <Banner kind="error">{err}</Banner>}
    </>
  )
}
