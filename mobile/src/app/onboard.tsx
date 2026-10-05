import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Haptics from 'expo-haptics'
import type { Address } from 'viem'
import { api, setToken } from '@/lib/api'
import { PasskeyCancelled } from '@/lib/passkey'
import { homeFor, useSession, type Role } from '@/lib/session'
import { resetTo } from '@/lib/nav'
import { explainChainError, getSigner, signMandate } from '@/lib/wallet'
import { AuthFlow } from '@/ui/AuthFlow'
import { duration, short, usd } from '@/lib/format'
import { selfStatusMessage } from '@keycard/sdk'
import { Banner, Button, Check, Link, Panel, Row, Screen, Stepper, Text } from '@/ui/kit'
import { KeykardCard } from '@/ui/KeykardCard'
import { WrongAccount, switchAccount } from '@/ui/Account'
import { color } from '@/ui/theme'

const STEPS: Record<Role, string[]> = {
  borrower: ['Account', 'Verify', 'Auto-pay', 'Card'],
  merchant: ['Account', 'Verify', 'Your shop'],
  guarantor: ['Account', 'Verify', 'Guarantee'],
}
const TITLE: Record<Role, string> = { borrower: 'Get your KEYKARD', merchant: 'Accept KEYKARD', guarantor: 'Back someone you trust' }

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

  // one sign-in for everyone: a cardholder who signed in on the merchant path (or the reverse) goes to their own home
  useEffect(() => {
    if (me?.user && wrongRole && role !== 'guarantor' && me.user.role !== 'guarantor') resetTo(homeFor(me) as any)
  }, [me, wrongRole, role])

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
      <Text style={{ marginTop: 6 }}>A minute. No documents stored. Free if you pay on time.</Text>
      {/* the sign-in screen has its own heading; the steps only matter once you're in */}
      {step > 0 && <Stepper steps={STEPS[role]} at={step} />}
      {me && wrongRole ? (
        <WrongAccount me={me} want={role === 'borrower' ? 'cardholder' : role === 'merchant' ? 'merchant' : 'family backup'} here={TITLE[role]} />
      ) : step === 0 ? (
        <AuthFlow role={role} lockRole={role === 'guarantor'} onDone={refresh} />
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
        This is our KYC, done with Self: tap your passport’s chip with the Self app. It proves three facts with a zero-knowledge proof: you’re over 18, you’re a
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
