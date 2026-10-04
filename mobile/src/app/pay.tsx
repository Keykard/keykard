import { useEffect, useMemo, useState } from 'react'
import { Modal, Pressable, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as Haptics from 'expo-haptics'
import * as WebBrowser from 'expo-web-browser'
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated'
import type { Address } from 'viem'
import { MERCHANT_CODE_RE } from '@keycard/sdk'
import { api } from '@/lib/api'
import { toBase, usd } from '@/lib/format'
import { useSession } from '@/lib/session'
import { PasskeyCancelled } from '@/lib/passkey'
import { explainChainError, getSigner, payRawAddress, payWithCard } from '@/lib/wallet'
import { Banner, Button, Field, Link, Row, Screen, Text } from '@/ui/kit'
import { color, font, radius } from '@/ui/theme'
import { CardFlowSheet, type FlowState } from '@/ui/CardFlowSheet'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

export default function Pay() {
  const params = useLocalSearchParams<{ code?: string }>()
  const { me, cfg, refresh } = useSession()
  const [code, setCode] = useState('')
  const [merchant, setMerchant] = useState<string | null | ''>(null) // null unknown · '' not found · label
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [flow, setFlow] = useState<{ state: FlowState; amount: bigint; label: string; kind: 'passkey' | 'password'; hash?: string; error?: string } | null>(null)
  const [demo, setDemo] = useState(false)

  useEffect(() => {
    if (params.code) setCode(String(params.code).toUpperCase())
  }, [params.code])

  useEffect(() => {
    setMerchant(null)
    if (!MERCHANT_CODE_RE.test(code)) return
    let alive = true
    api<{ label: string }>(`/api/merchants/${code}`, { auth: false })
      .then((m) => alive && setMerchant(m.label))
      .catch(() => alive && setMerchant(''))
    return () => {
      alive = false
    }
  }, [code])

  const line = me?.line
  const spendable = BigInt(line?.spendable ?? '0')
  const base = useMemo(() => {
    try {
      return amount ? toBase(amount) : 0n
    } catch {
      return -1n
    }
  }, [amount])
  const over = base > spendable
  const frozen = !line || line.status !== 'active'

  const press = (k: string) => {
    Haptics.selectionAsync().catch(() => {})
    setErr(null)
    setAmount((a) => {
      if (k === '⌫') return a.slice(0, -1)
      if (k === '.') return a.includes('.') ? a : (a || '0') + '.'
      const next = a === '0' ? k : a + k
      const [, f] = next.split('.')
      if (f && f.length > 2) return a
      if (next.replace('.', '').length > 7) return a
      return next
    })
  }

  const pay = async () => {
    if (!line || !merchant || base <= 0n) return
    setErr(null)
    let signer
    try {
      signer = await getSigner() // a password wallet asks for the password first
    } catch (e: any) {
      if (!/cancelled/i.test(e?.message)) setErr(e.message)
      return
    }
    const v = base
    setFlow({ state: 'signing', amount: v, label: merchant, kind: signer.kind })
    try {
      const tx = await payWithCard(signer, line.creditAccount as Address, code, v, (st) =>
        setFlow((f) => (f ? { ...f, state: st === 'approve' ? 'signing' : 'confirming' } : f)),
      )
      setFlow((f) => (f ? { ...f, state: 'done', hash: tx } : f))
      setAmount('')
      void refresh()
    } catch (e: any) {
      if (e instanceof PasskeyCancelled || /cancelled/i.test(e?.message)) setFlow(null)
      else setFlow((f) => (f ? { ...f, state: 'error', error: explainChainError(e) } : f))
    }
  }

  return (
    <Screen>
      <Row between style={{ marginTop: 6 }}>
        <Text v="h1">Pay</Text>
        <Link title="Close" onPress={() => router.back()} />
      </Row>
      {frozen && <Banner kind="error">Your card isn’t active right now. Check the message on your home screen.</Banner>}

      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <Field
            testID="pay-code"
            label="Merchant code"
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="e.g. 7QX2MD"
            value={code}
            onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
            style={{ fontFamily: font.monoMedium, letterSpacing: 4, fontSize: 18 }}
          />
        </View>
        <Button testID="pay-scan" title="Scan" kind="quiet" style={{ minHeight: 54, paddingHorizontal: 18 }} onPress={() => router.push('/scan')} />
      </View>
      {merchant ? <Text v="small" style={{ color: color.ok, marginTop: 8 }}>Paying {merchant}</Text> : merchant === '' ? <Text v="small" style={{ color: color.warn, marginTop: 8 }}>No KEYKARD merchant with this code.</Text> : null}
      {!code && cfg && cfg.merchants.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {cfg.merchants.slice(0, 6).map((m) => (
            <Pressable key={m.code} onPress={() => setCode(m.code)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99, backgroundColor: color.surface1, borderWidth: 1, borderColor: color.hairline }}>
              <Text v="small" style={{ color: color.text }}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={{ alignItems: 'center', marginTop: 26 }}>
        <Text testID="pay-amount" v="amount" style={{ fontSize: 58, lineHeight: 64, color: amount ? color.text : color.text3 }} adjustsFontSizeToFit numberOfLines={1}>
          ${amount || '0'}
        </Text>
        <Text v="small" style={{ color: over ? color.bad : color.text3, marginTop: 4 }}>
          {over ? `More than your ${usd(spendable)} available` : `Available ${usd(spendable)}`}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 16 }}>
        {KEYS.map((k) => (
          <Pressable key={k} testID={`key-${k}`} accessibilityLabel={k === '⌫' ? 'Delete' : k} onPress={() => press(k)} style={({ pressed }) => ({ width: '33.33%', height: 62, alignItems: 'center', justifyContent: 'center', borderRadius: radius.input, backgroundColor: pressed ? color.surface1 : 'transparent' })}>
            <Text style={{ fontFamily: font.regular, fontSize: 26, color: color.text }}>{k}</Text>
          </Pressable>
        ))}
      </View>

      {err && <Banner kind="error">{err}</Banner>}
      <Button
        testID="pay-confirm"
        title={merchant && base > 0n ? `Pay ${usd(base)} to ${merchant}` : 'Pay with KEYKARD'}
        busy={busy}
        disabled={frozen || !merchant || base <= 0n || over}
        style={{ marginTop: 14 }}
        onPress={pay}
      />
      <Text v="small" style={{ textAlign: 'center', marginTop: 14, color: color.text3 }}>
        Your card can only pay KEYKARD merchants. The blockchain enforces this, not us.
      </Text>
      <Link testID="pay-demo" title="See it refuse a random wallet" style={{ textAlign: 'center', marginTop: 8, paddingVertical: 6 }} onPress={() => setDemo(true)} />
      <CardFlowSheet
        visible={!!flow}
        mode="pay"
        state={flow?.state ?? 'signing'}
        title={`Paying ${usd(flow?.amount ?? 0n)} to ${flow?.label ?? ''}`}
        approveHint={flow?.kind === 'passkey' ? 'Confirm with your fingerprint' : 'Signing with your wallet…'}
        error={flow?.error}
        done={flow?.state === 'done' ? {
          headline: 'Paid',
          amount: usd(flow.amount),
          lines: [`To ${flow.label}`, 'Settling to the merchant now. It shows in your activity.'],
          receiptUrl: cfg && flow.hash ? `${cfg.explorerUrl}/tx/${flow.hash}` : undefined,
        } : undefined}
        onCancel={() => setFlow(null)}
        onClose={() => {
          const ok = flow?.state === 'done'
          setFlow(null)
          if (ok) router.back()
        }}
        onRetry={pay}
        onReceipt={(u) => WebBrowser.openBrowserAsync(u)}
      />
      <RefusalDemo open={demo} onClose={() => setDemo(false)} creditAccount={line?.creditAccount as Address | undefined} />
    </Screen>
  )
}

/** Pay $1 straight to any wallet with the card key: the Tempo protocol must refuse it. */
function RefusalDemo({ open, onClose, creditAccount }: { open: boolean; onClose: () => void; creditAccount?: Address }) {
  const [addr, setAddr] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr)
  const tryIt = async () => {
    if (!creditAccount) return
    setBusy(true)
    setResult(null)
    try {
      const s = await getSigner()
      await payRawAddress(s, creditAccount, addr as Address, 1_000_000n)
      setResult({ ok: false, text: 'Unexpected: the payment went through.' })
    } catch (e: any) {
      if (e instanceof PasskeyCancelled || /cancelled/i.test(e?.message)) return
      setResult({ ok: true, text: explainChainError(e) })
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {})
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} onPress={onClose} />
      <View style={{ backgroundColor: color.surface1, padding: 22, paddingBottom: 34, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, borderWidth: 1, borderColor: color.hairline }}>
        <Text v="h2">Try to pay a random wallet</Text>
        <Text v="small" style={{ marginTop: 6 }}>Paste any wallet address. Your card will try to send it $1 directly. Tempo should refuse, before any KEYKARD server sees it.</Text>
        <TextInput
          testID="demo-address"
          value={addr}
          onChangeText={(t) => setAddr(t.trim())}
          placeholder="0x…"
          placeholderTextColor={color.text3}
          autoCapitalize="none"
          autoCorrect={false}
          style={{ marginTop: 14, minHeight: 52, borderRadius: radius.input, backgroundColor: color.surface2, color: color.text, paddingHorizontal: 14, fontFamily: font.mono, fontSize: 13 }}
        />
        <Row style={{ marginTop: 10 }}>
          <Link title="Use a random address" onPress={() => setAddr('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex'))} />
        </Row>
        {result && <Banner kind={result.ok ? 'warn' : 'error'}>{result.text}</Banner>}
        <Button testID="demo-try" title="Send $1 directly" busy={busy} disabled={!valid || !creditAccount} style={{ marginTop: 16 }} onPress={tryIt} />
        <Button title="Close" kind="ghost" style={{ marginTop: 8 }} onPress={onClose} />
      </View>
    </Modal>
  )
}
