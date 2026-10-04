import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Haptics from 'expo-haptics'
import type { Address } from 'viem'
import { api, setToken } from '@/lib/api'
import { createDeviceKey, deriveAuthProof, deviceVault } from '@/lib/devicekey'
import { PasskeyCancelled, passkeysSupported } from '@/lib/passkey'
import { useSession, type Role } from '@/lib/session'
import { createPasskey, explainChainError, getSigner, registrationForDeviceKey, signIn, signMandate } from '@/lib/wallet'
import { duration, short, usd } from '@/lib/format'
import { selfStatusMessage } from '@keycard/sdk'
import { Banner, Button, Check, Field, Link, Panel, Row, Screen, Segmented, Stepper, Text } from '@/ui/kit'
import { CountryPicker } from '@/ui/CountryPicker'
import { KeykardCard } from '@/ui/KeykardCard'
import { WrongAccount, switchAccount } from '@/ui/Account'
import { color } from '@/ui/theme'

const STEPS: Record<Role, string[]> = {
  borrower: ['Account', 'Verify', 'Auto-pay', 'Card'],
  merchant: ['Account', 'Verify', 'Your shop'],
  guarantor: ['Account', 'Verify', 'Guarantee'],
}
const TITLE: Record<Role, string> = { borrower: 'Get your KEYKARD', merchant: 'Accept KEYKARD', guarantor: 'Back someone you trust' }
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/

type Prepared = {
  lineId: number
  creditAccount: Address
  mandate: { keyId: Address; cap: string; periodSeconds: number; recipient: Address; expiry: number }
  startingLimit: string
}

export default function Onboard() {
  const params = useLocalSearchParams<{ role?: string; next?: string }>()
  const role: Role = params.role === 'merchant' || params.role === 'guarantor' ? params.role : 'borrower'
  const { me, cfg, signedIn, refresh } = useSession()

  const verified = !!me?.identity.verified
  const wrongRole = !!me?.user && me.user.role !== role
  const [cardReady, setCardReady] = useState(false)
  const step = cardReady ? 3 : !signedIn || !me?.user ? 0 : !verified ? 1 : 2

  // once verified, non-borrowers continue to their own screen
  useEffect(() => {
    if (!me?.user || wrongRole || !verified) return
    if (role === 'merchant') router.replace('/merchant')
    else if (role === 'guarantor') router.replace((params.next as any) ?? '/backing')
    else if (me.line && !['preparing', 'settled'].includes(me.line.status)) router.replace('/home')
  }, [me, verified, wrongRole, role, params.next])

  return (
    <Screen>
      <Row between style={{ marginTop: 6, opacity: cardReady ? 0 : 1 }} >
        <Link title="‹ Back" onPress={() => !cardReady && (router.canGoBack() ? router.back() : router.replace('/welcome'))} />
        {signedIn && <Link title="Switch account" onPress={() => !cardReady && switchAccount()} />}
      </Row>
      <Text v="h1" style={{ marginTop: 18 }}>{TITLE[role]}</Text>
      <Text style={{ marginTop: 6 }}>A minute, no documents stored, no fees.</Text>
      <Stepper steps={STEPS[role]} at={step} />
      {me && wrongRole ? (
        <WrongAccount me={me} want={role === 'borrower' ? 'cardholder' : role === 'merchant' ? 'merchant' : 'family backup'} here={TITLE[role]} />
      ) : step === 0 ? (
        <AccountStep role={role} onDone={refresh} />
      ) : step === 1 ? (
        <VerifyStep role={role} onVerified={refresh} />
      ) : role === 'borrower' ? (
        <AutopayStep onOpened={() => setCardReady(true)} />
      ) : (
        <Panel><Text>Taking you there…</Text></Panel>
      )}
      {cfg?.network === 'testnet' && <Text v="small" style={{ textAlign: 'center', marginTop: 20, color: color.text3 }}>Tempo testnet · test dollars only</Text>}
    </Screen>
  )
}

/* ---------------- Step 1: account ---------------- */
function AccountStep({ role, onDone }: { role: Role; onDone: () => Promise<unknown> }) {
  const { cfg } = useSession()
  const canPasskey = passkeysSupported()
  const [method, setMethod] = useState<'passkey' | 'password'>(canPasskey ? 'passkey' : 'password')
  const [username, setUsername] = useState('')
  const [nameState, setNameState] = useState<'idle' | 'checking' | 'free' | 'taken' | 'invalid'>('idle')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [country, setCountry] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const seq = useRef(0)

  // live username check
  useEffect(() => {
    const u = username.trim().toLowerCase()
    if (!u) return setNameState('idle')
    if (!USERNAME_RE.test(u)) return setNameState('invalid')
    setNameState('checking')
    const n = ++seq.current
    const t = setTimeout(() => {
      api<{ available: boolean }>(`/api/username/${encodeURIComponent(u)}`, { auth: false })
        .then((r) => n === seq.current && setNameState(r.available ? 'free' : 'taken'))
        .catch(() => n === seq.current && setNameState('idle'))
    }, 350)
    return () => clearTimeout(t)
  }, [username])

  const excluded = !!cfg?.excludedCountries.includes(country)
  const pwOk = method === 'passkey' || (pw.length >= 10 && pw === pw2)
  const ready = nameState === 'free' && !!country && !excluded && confirmed && pwOk && !busy

  const create = async () => {
    setErr(null)
    setBusy(true)
    try {
      const uname = username.trim().toLowerCase()
      if (method === 'password') {
        setStage('Securing your wallet on this phone…')
        const k = await createDeviceKey(pw)
        const keyRegistration = await registrationForDeviceKey(k)
        const authProof = await deriveAuthProof(uname, pw)
        setStage('Creating your account…')
        const r = await api<{ wallet: Address; token?: string }>('/api/users', {
          auth: false,
          body: { role, username: uname, keyRegistration, backup: { username: uname, authProof, vault: k.vault }, residenceCountry: country, residenceConfirmed: true },
        })
        if (r.token) await setToken(r.token)
        else await signIn({ kind: 'password', address: k.address, pk: k.pk }, r.wallet)
      } else {
        setStage('Confirm with your fingerprint or screen lock…')
        const { cred, registration } = await createPasskey(uname)
        setStage('Creating your account…')
        const r = await api<{ wallet: Address; token?: string }>('/api/users', {
          auth: false,
          body: { role, username: uname, registration, residenceCountry: country, residenceConfirmed: true },
        })
        if (r.token) await setToken(r.token)
        else await signIn({ kind: 'passkey', cred }, r.wallet)
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      await onDone()
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled)) setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  return (
    <Panel>
      <Text v="eyebrow">Step 1 · Account</Text>
      {deviceVault() && (
        <Banner kind="info">
          <Text v="small" style={{ color: color.text }}>
            This phone already has a password wallet. <Link title="Sign in instead" onPress={() => router.push('/signin')} />
          </Text>
        </Banner>
      )}
      <Field
        testID="onboard-username"
        label="Username"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        placeholder="e.g. maria.santos"
        value={username}
        onChangeText={(t) => setUsername(t.replace(/\s/g, ''))}
        error={nameState === 'taken' ? 'That username is taken.' : nameState === 'invalid' ? '3–30 characters: letters, numbers, . _ -' : null}
        hint={nameState === 'free' ? '✓ Available' : 'Shown on your KEYKARD and in your passkey list.'}
      />
      <Segmented
        value={method}
        onChange={setMethod}
        options={[{ value: 'passkey', label: 'Fingerprint' }, { value: 'password', label: 'Password' }]}
      />
      {method === 'passkey' ? (
        <Text v="small" style={{ marginTop: 10 }}>
          {canPasskey
            ? 'Recommended. Your account is a passkey: fingerprint, face or screen lock. No seed phrase, and it works on the KEYKARD website too.'
            : 'Passkeys need Android 9+ with Google Play services. Use a password account on this phone.'}
        </Text>
      ) : (
        <>
          <Text v="small" style={{ marginTop: 10 }}>
            A wallet key is created on this phone and locked with your password, which never leaves the device. You can sign in with it on any device.
          </Text>
          <Field testID="onboard-password" label="Password (at least 10 characters)" secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw} onChangeText={setPw}
            error={pw.length > 0 && pw.length < 10 ? 'At least 10 characters.' : null} />
          <Field testID="onboard-password2" label="Repeat password" secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw2} onChangeText={setPw2}
            error={pw2.length > 0 && pw2 !== pw ? 'Passwords don’t match.' : null} />
        </>
      )}
      <CountryPicker value={country} onChange={setCountry} excluded={cfg?.excludedCountries ?? []} />
      {excluded && <Banner kind="error">KEYKARD isn’t available to residents of this country yet.</Banner>}
      <Check testID="onboard-residence" checked={confirmed} onChange={setConfirmed}>
        I confirm this is my country of residence, and I will tell KEYKARD if it changes.
      </Check>
      {err && <Banner kind="error">{err}</Banner>}
      <Button
        testID="onboard-create"
        title={busy ? stage ?? 'Working…' : method === 'passkey' ? 'Create passkey account' : 'Create password account'}
        busy={busy}
        disabled={!ready || (method === 'passkey' && !canPasskey)}
        style={{ marginTop: 18 }}
        onPress={create}
      />
      <View style={{ alignItems: 'center', marginTop: 14 }}>
        <Text v="small">Already have one? <Link title="Sign in" onPress={() => router.push('/signin')} /></Text>
      </View>
    </Panel>
  )
}

/* ---------------- Step 2: Self ---------------- */
function VerifyStep({ role, onVerified }: { role: Role; onVerified: () => Promise<unknown> }) {
  const { cfg, me } = useSession()
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!waiting) return
    const t = setInterval(onVerified, 4000)
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void onVerified())
    return () => {
      clearInterval(t)
      sub.remove()
    }
  }, [waiting, onVerified])

  const verify = async () => {
    setErr(null)
    setBusy(true)
    try {
      const r = await api<{ verificationUrl: string }>('/api/self/session', { method: 'POST' })
      setWaiting(true)
      await Linking.openURL(r.verificationUrl)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const skip = async () => {
    setErr(null)
    setBusy(true)
    try {
      await api('/api/dev/verify', { method: 'POST' })
      await onVerified()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  const last = me?.identity.selfStatus
  return (
    <Panel>
      <Text v="eyebrow">Step 2 · Verify</Text>
      <Text v="h2" style={{ marginTop: 8 }}>Verify you’re a real, unique person</Text>
      <Text v="small" style={{ marginTop: 8 }}>
        KEYKARD uses Self: tap your passport’s chip with the Self app. It proves three facts with a zero-knowledge proof: you’re over 18, you’re a
        unique person, and you’re not on a sanctions list. We never see your passport, name or number. One passport = one KEYKARD.
      </Text>
      {role === 'guarantor' && <Text v="small" style={{ marginTop: 6 }}>As a family backup, your nationality is also shared so we can check the family corridor.</Text>}
      {cfg && !cfg.selfEnabled && <Banner kind="info">Identity verification (Self) isn’t switched on for this server yet.</Banner>}
      {(() => {
        const m = !me?.identity.verified ? selfStatusMessage(last) : null
        return m ? <Banner kind={m.kind}>{m.text}</Banner> : null
      })()}
      {err && <Banner kind="error">{err}</Banner>}
      <Button testID="verify-self" title={waiting ? 'Open Self again' : 'Verify with Self'} busy={busy} disabled={!cfg?.selfEnabled} style={{ marginTop: 16 }} onPress={verify} />
      {waiting && <Banner kind="info">Waiting for Self… this screen continues by itself when your proof arrives.</Banner>}
      {cfg?.devVerify && (
        <Button testID="verify-skip" title="Skip verification (testnet only)" kind="ghost" disabled={busy} style={{ marginTop: 10 }} onPress={skip} />
      )}
    </Panel>
  )
}

/* ---------------- Step 3: auto-pay (cardholders) ---------------- */
function AutopayStep({ onOpened }: { onOpened: () => void }) {
  const { me, cfg, refresh } = useSession()
  const [prep, setPrep] = useState<Prepared | null>(null)
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)

  const prepare = useCallback(async () => {
    setErr(null)
    try {
      setPrep(await api<Prepared>('/api/lines/prepare', { method: 'POST' }))
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])
  useEffect(() => {
    void prepare()
  }, [prepare])

  const accept = async () => {
    if (!prep) return
    setErr(null)
    setBusy(true)
    try {
      const signer = await getSigner()
      setStage(signer.kind === 'passkey' ? 'Approve auto-pay with your fingerprint…' : 'Signing auto-pay…')
      await signMandate(signer, prep.lineId, prep.mandate)
      setStage('Opening your line on Tempo…')
      await api(`/api/lines/${prep.lineId}/open`, { method: 'POST' })
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      setOpened(true)
      onOpened() // the session refreshes when they continue, so the celebration isn't skipped
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled) && !/cancelled/i.test(e.message)) setErr(explainChainError(e))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  if (opened) {
    return (
      <View style={{ marginTop: 8 }}>
        <KeykardCard amount={usd(prep?.startingLimit)} sub="Your card is ready" />
        <Text v="h2" style={{ marginTop: 22, textAlign: 'center' }}>You’re in.</Text>
        <Text style={{ textAlign: 'center', marginTop: 6 }}>Pay any KEYKARD merchant. Pay on time and your limit grows.</Text>
        <Button testID="autopay-done" title="Go to my card" style={{ marginTop: 20 }} onPress={async () => {
          await refresh()
          router.replace('/home')
        }} />
      </View>
    )
  }
  if (!prep) return <Panel>{err ? <><Banner kind="error">{err}</Banner><Button title="Try again" style={{ marginTop: 12 }} onPress={prepare} /></> : <Text>Preparing your line…</Text>}</Panel>

  const rows: [string, string][] = [
    ['Most it can take per period', `${usd(prep.mandate.cap)} ${cfg?.tokenSymbol ?? ''}`],
    ['Period', duration(prep.mandate.periodSeconds)],
    ['Can pay only', `KEYKARD ${short(prep.mandate.recipient)}`],
    ['Ends', new Date(prep.mandate.expiry * 1000).toISOString().slice(0, 10)],
  ]
  return (
    <Panel>
      <Text v="eyebrow">Step 3 · Auto-pay</Text>
      <Text v="h2" style={{ marginTop: 8 }}>Your auto-pay</Text>
      <Row style={{ marginTop: 12 }}>
        <View style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: color.surface2 }}>
          <Text v="small">Starting limit</Text>
          <Text v="h2">{usd(prep.startingLimit)}</Text>
        </View>
        <View style={{ flex: 1, padding: 12, borderRadius: 14, backgroundColor: color.surface2 }}>
          <Text v="small">Bills every</Text>
          <Text v="h2">{duration(prep.mandate.periodSeconds)}</Text>
        </View>
      </Row>
      <Text v="small" style={{ marginTop: 12 }}>
        At the end of each period, what you spent is repaid automatically from your KEYKARD wallet ({short(me?.user?.wallet)}). Keep enough there to cover it.
      </Text>
      <View style={{ marginTop: 14, padding: 14, borderRadius: 14, backgroundColor: color.surface2, borderWidth: 1, borderColor: color.hairline }}>
        <Text v="eyebrow" style={{ marginBottom: 6 }}>Enforced by the Tempo protocol</Text>
        {rows.map(([k, v]) => (
          <Row key={k} between style={{ paddingVertical: 7 }}>
            <Text v="small">{k}</Text>
            <Text v="small" style={{ color: color.text }}>{v}</Text>
          </Row>
        ))}
        <Text v="small" style={{ marginTop: 6 }}>KEYKARD only takes what you actually owe. The cap is the most it could ever take in one period.</Text>
      </View>
      <Check testID="autopay-agree" checked={agree} onChange={setAgree}>
        I allow KEYKARD to take what I owe from my wallet each period, up to the cap above, only to KEYKARD. I can turn this off at any time, and doing so freezes my card.
      </Check>
      {err && <Banner kind="error">{err}</Banner>}
      <Button testID="autopay-sign" title={busy ? stage ?? 'Working…' : 'Sign & open my line'} busy={busy} disabled={!agree} style={{ marginTop: 18 }} onPress={accept} />
      <Text v="small" style={{ textAlign: 'center', marginTop: 10 }}>You pay no network fees. KEYKARD sponsors them.</Text>
    </Panel>
  )
}
