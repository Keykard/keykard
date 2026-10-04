import { useReaderGuard } from '@/lib/useReaderGuard'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Share, View } from 'react-native'
import { Redirect, router, useFocusEffect } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import * as WebBrowser from 'expo-web-browser'
import QRCode from 'react-native-qrcode-svg'
import { api } from '@/lib/api'
import { short, toBase, usd, when } from '@/lib/format'
import { cancelCardRead, nfcState, openNfcSettings } from '@/lib/halo'
import { homeFor, useSession } from '@/lib/session'
import { chargePhysicalCard, explainChainError } from '@/lib/wallet'
import { Banner, Button, Chip, Field, ListRow, Panel, Row, Text } from '@/ui/kit'
import { KeyMark } from '@/ui/KeykardCard'
import { CardFlowSheet, type FlowState } from '@/ui/CardFlowSheet'
import { color, font } from '@/ui/theme'

type Dash = {
  merchant: { code: string; label: string; owner: string; settleTo: string; settlement: string }
  payments: { amount: string; pay_tx: string | null; settle_tx: string; status: string; created_at: string | null }[]
  pending?: { amount: string; pay_tx: string; status: string; created_at: string }[]
  settledTotal: string
  settledCount: number
}

export default function Merchant() {
  const { me, cfg, loading } = useSession()
  const [dash, setDash] = useState<Dash | null | undefined>(undefined)
  const [err, setErr] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)

  const load = useCallback(async () => {
    try {
      setDash(await api<Dash | null>('/api/merchant/me'))
      setErr(null)
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])
  useFocusEffect(useCallback(() => {
    void load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [load]))

  if (!loading && (!me?.user || me.user.role !== 'merchant' || !me.identity.verified)) return <Redirect href={homeFor(me) as any} />

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={pulling} tintColor={color.accent} colors={[color.accent]} progressBackgroundColor={color.surface1} onRefresh={async () => { setPulling(true); await load(); setPulling(false) }} />}>
        <Row between>
          <Row><KeyMark /><Text v="h3" style={{ letterSpacing: 3, fontSize: 13 }}>KEYKARD</Text></Row>
          <Pressable accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={12} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.surface1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.hairline }}>
            <Text style={{ fontSize: 18, color: color.text }}>⚙︎</Text>
          </Pressable>
        </Row>
        {err && <Banner kind="error">{err}</Banner>}
        {dash === undefined ? (
          <Text style={{ marginTop: 30 }}>Loading your shop…</Text>
        ) : dash === null ? (
          <Register onDone={load} />
        ) : (
          <Till dash={dash} explorer={cfg?.explorerUrl} web={cfg?.publicWebOrigin ?? 'https://www.keykard.xyz'} onPaid={() => setTimeout(load, 2500)} />
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function Register({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <>
      <Text v="h1" style={{ marginTop: 24 }}>Your shop</Text>
      <Text style={{ marginTop: 6 }}>Pick the name customers see when they pay you. You’ll get a code and a QR right away.</Text>
      <Panel>
        <Field testID="merchant-label" label="Name customers will see" placeholder="e.g. Tita Rosa’s Sari-Sari Store" value={label} onChangeText={setLabel} maxLength={60} />
        {err && <Banner kind="error">{err}</Banner>}
        <Button testID="merchant-register" title="Get my merchant code" busy={busy} disabled={label.trim().length < 2} style={{ marginTop: 16 }} onPress={async () => {
          setErr(null)
          setBusy(true)
          try {
            await api('/api/merchants', { body: { label: label.trim() } })
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
            onDone()
          } catch (e: any) {
            setErr(e.message)
          } finally {
            setBusy(false)
          }
        }} />
      </Panel>
    </>
  )
}

function Till({ dash, explorer, web, onPaid }: { dash: Dash; explorer?: string; web: string; onPaid: () => void }) {
  const payLink = `${web}/card?pay=${dash.merchant.code}`
  useReaderGuard()
  const [amount, setAmount] = useState('')
  const [nfc, setNfc] = useState<'ok' | 'off' | 'none' | null>(null)
  const [flow, setFlow] = useState<{ state: FlowState; amount: bigint; error?: string; hash?: string; card?: string } | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    nfcState().then(setNfc)
  }, [])

  const charge = async (base?: bigint) => {
    setResult(null)
    let value = base
    if (value === undefined) {
      try {
        value = toBase(amount)
        if (value <= 0n) throw new Error('Enter an amount above $0.')
      } catch (e: any) {
        return setResult({ kind: 'error', text: e.message })
      }
    }
    const v = value
    setFlow({ state: 'hold', amount: v })
    try {
      const r = await chargePhysicalCard({ merchantCode: dash.merchant.code, amount: v, onStep: (st) => setFlow((f) => (f ? { ...f, state: st } : f)) })
      setFlow({ state: 'done', amount: v, hash: r.hash, card: r.card })
      setAmount('')
      onPaid()
    } catch (e: any) {
      if (/Cancelled/i.test(e?.message)) setFlow(null)
      else setFlow({ state: 'error', amount: v, error: explainChainError(e) })
    }
  }

  return (
    <>
      <Text v="h1" style={{ marginTop: 22 }}>{dash.merchant.label}</Text>
      <Row style={{ marginTop: 14 }}>
        <Chip label="Received" value={usd(dash.settledTotal)} />
        <Chip label="Payments" value={String(dash.settledCount)} />
      </Row>

      <Panel style={{ alignItems: 'center' }}>
        <Text v="eyebrow">Your merchant code</Text>
        <Text testID="merchant-code" style={{ fontFamily: font.monoMedium, fontSize: 40, lineHeight: 52, letterSpacing: 8, color: color.text, marginTop: 8, paddingTop: 2 }}>{dash.merchant.code}</Text>
        <View style={{ padding: 14, backgroundColor: '#fff', borderRadius: 20, marginTop: 14 }}>
          <QRCode value={payLink} size={200} backgroundColor="#fff" color="#0A0A0B" />
        </View>
        <Text v="small" style={{ marginTop: 12 }}>Customers scan this with the KEYKARD app or their camera.</Text>
        <Button title="Share pay link" small kind="quiet" style={{ marginTop: 12 }} onPress={() => Share.share({ message: `Pay ${dash.merchant.label} with KEYKARD: ${payLink}` })} />
      </Panel>

      <Panel>
        <Text v="h2">Tap to charge</Text>
        <Text v="small" style={{ marginTop: 4 }}>The customer taps their physical KEYKARD on this phone.</Text>
        {nfc === 'none' && <Banner kind="warn">This phone has no NFC. Customers can still scan your QR.</Banner>}
        {nfc === 'off' && <Banner kind="warn"><Text v="small" style={{ color: color.text }}>NFC is off. <Text v="small" style={{ color: color.accentHi }} onPress={openNfcSettings}>Turn it on ›</Text></Text></Banner>}
        <Field testID="charge-amount" label="Amount (USD)" big keyboardType="decimal-pad" placeholder="$0.00" value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} />
        <Button testID="charge-go" title="Charge · tap card" disabled={!amount || nfc !== 'ok'} style={{ marginTop: 14 }} onPress={() => charge()} />
        {result && <Banner kind={result.kind}>{result.text}</Banner>}
      </Panel>

      <Panel>
        <Row between>
          <Text v="h2">Payments</Text>
          <Text v="small" style={{ color: color.ok }}>● Live</Text>
        </Row>
        {dash.pending && dash.pending.length > 0 && (
          <Banner kind="info">{`${dash.pending.length} payment${dash.pending.length > 1 ? 's' : ''} settling now: ${dash.pending.map((p) => usd(p.amount)).join(', ')}`}</Banner>
        )}
        {dash.payments.length === 0 ? (
          <Text v="small" style={{ textAlign: 'center', paddingVertical: 18, color: color.text3 }}>No payments yet. Share your code to get paid.</Text>
        ) : (
          dash.payments.slice(0, 50).map((p) => (
            <ListRow key={p.settle_tx} icon="↙" positive title="Payment received" sub={p.created_at ? when(p.created_at) : 'Settled'} right={`+${usd(p.amount)}`} rightSub="Receipt ↗"
              onPress={() => explorer && WebBrowser.openBrowserAsync(`${explorer}/tx/${p.settle_tx}`)} />
          ))
        )}
        <Text v="small" style={{ marginTop: 10 }}>Read from the Tempo blockchain. Settled to your wallet {short(dash.merchant.settleTo)}.</Text>
      </Panel>
      <CardFlowSheet
        visible={!!flow}
        mode="charge"
        state={flow?.state ?? 'hold'}
        title={`Charging ${usd(flow?.amount ?? 0n)}`}
        error={flow?.error}
        done={flow?.state === 'done' ? {
          headline: 'Payment received',
          amount: usd(flow.amount),
          lines: [`From KEYKARD •••• ${flow.card?.slice(-4) ?? ''}`, 'Settling to your wallet in a few seconds.'],
          receiptUrl: explorer && flow.hash ? `${explorer}/tx/${flow.hash}` : undefined,
        } : undefined}
        onCancel={() => { void cancelCardRead(); setFlow(null) }}
        onClose={() => setFlow(null)}
        onRetry={() => flow && charge(flow.amount)}
        onReceipt={(u) => WebBrowser.openBrowserAsync(u)}
      />
    </>
  )
}
