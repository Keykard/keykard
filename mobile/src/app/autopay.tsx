import { useCallback, useEffect, useState } from 'react'
import { Alert, View } from 'react-native'
import { router } from 'expo-router'
import type { Address } from 'viem'
import { duration, short, usd } from '@/lib/format'
import { useSession } from '@/lib/session'
import { PasskeyCancelled } from '@/lib/passkey'
import { explainChainError, getSigner, revokeKey, tokenBalance } from '@/lib/wallet'
import { Banner, Button, Chip, Link, Panel, Row, Screen, Text } from '@/ui/kit'
import { LineStatus } from '@/ui/LineStatus'
import { Countdown } from '@/ui/Countdown'
import { color } from '@/ui/theme'

export default function Autopay() {
  const { me, cfg, refresh } = useSession()
  const [bal, setBal] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const line = me?.line

  const loadBal = useCallback(() => {
    if (me?.user?.wallet) tokenBalance(me.user.wallet).then(setBal).catch(() => {})
  }, [me?.user?.wallet])
  useEffect(() => {
    loadBal()
  }, [loadBal])

  if (!line || !cfg) return <Screen><Text>Loading…</Text></Screen>
  const tiers = cfg.tiers.map((t) => BigInt(t))
  const tierIdx = tiers.reduce((i, t, k) => (BigInt(line.unsecuredLimit ?? line.limit) >= t ? k : i), 0)

  const turnOff = () =>
    Alert.alert('Turn off auto-pay?', 'Your card freezes straight away. You can turn auto-pay back on later.', [
      { text: 'Keep it on', style: 'cancel' },
      {
        text: 'Turn off',
        style: 'destructive',
        onPress: async () => {
          setErr(null)
          setBusy(true)
          try {
            const keyId = line.repayKeyId as Address | undefined
            if (!keyId) throw new Error('Auto-pay permission not found.')
            await revokeKey(await getSigner(), keyId)
            setMsg('Auto-pay turned off. Your card freezes within a few seconds.')
            setTimeout(refresh, 3000)
          } catch (e: any) {
            if (!(e instanceof PasskeyCancelled) && !/cancelled/i.test(e?.message)) setErr(explainChainError(e))
          } finally {
            setBusy(false)
          }
        },
      },
    ])

  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} />
      <Row between style={{ marginTop: 18 }}>
        <Text v="h1">Auto-pay</Text>
        <Text style={{ color: line.mandateActive ? color.ok : color.warn, fontFamily: 'Geist_500Medium' }}>● {line.mandateActive ? 'On' : 'Off'}</Text>
      </Row>
      <Text style={{ marginTop: 6 }}>Bills are paid from your KEYKARD wallet {short(me?.user?.wallet)}. Keep at least what you owe there.</Text>

      <LineStatus line={line} walletBal={bal} onChange={() => { void refresh(); loadBal() }} />

      <Row style={{ marginTop: 14 }}>
        <Chip label="Owed now" value={usd(line.owed)} />
        <Chip label="Next bill" value={<Countdown to={line.nextDue} />} />
      </Row>
      <Row style={{ marginTop: 10 }}>
        <Chip label="Your wallet holds" value={bal === null ? '—' : usd(bal)} />
        <Chip label="Bills every" value={duration(cfg.periodSeconds)} />
      </Row>
      {bal !== null && BigInt(line.owed) > bal && (
        <Button title="Add money" kind="ghost" style={{ marginTop: 12 }} onPress={() => router.push('/add-money')} />
      )}

      <Panel>
        <Text v="eyebrow">Your limit ladder</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}>
          {tiers.map((t, i) => (
            <View key={i} style={{ flex: 1, gap: 8 }}>
              <View style={{ height: 4, borderRadius: 4, backgroundColor: i < tierIdx ? color.accentLo : i === tierIdx ? color.accent : 'rgba(255,255,255,0.1)' }} />
              <Text v="small" style={{ color: i === tierIdx ? color.text : color.text3 }}>{usd(t)}</Text>
            </View>
          ))}
        </View>
        <Text v="small" style={{ marginTop: 12 }}>On-time streak: {line.onTimeCount}. Two on-time bills in a row move you up a step.</Text>
        <Link title="Need more? Secure a bigger limit 1:1 ›" style={{ marginTop: 10 }} onPress={() => router.push('/secured')} />
      </Panel>

      {cfg.terms && (
        <Panel>
          <Text v="h3">What a missed bill costs</Text>
          <Text v="small" style={{ marginTop: 4 }}>
            On time costs nothing. A missed bill costs a {usd(cfg.terms.lateFee)} late fee, then {cfg.terms.penaltyBpsPerPeriod / 100}% of the overdue amount each
            billing period, never more than {cfg.terms.capBps / 100}% of it in total. Family backups never pay fees. These terms are published on-chain.
          </Text>
          {BigInt(line.feesPaid ?? '0') + BigInt(line.feesDue ?? '0') > 0n && (
            <Text v="small" style={{ marginTop: 8, color: color.text }}>Fees due now: {usd(line.feesDue)} · paid so far: {usd(line.feesPaid)}</Text>
          )}
        </Panel>
      )}

      <Panel>
        <Text v="h3">Repay from any wallet</Text>
        <Text v="small" style={{ marginTop: 4 }}>Pay from an exchange, another wallet or family, even with auto-pay off.</Text>
        <Button title="Show my repayment address" kind="ghost" small style={{ marginTop: 12 }} onPress={() => router.push('/repay')} />
      </Panel>

      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
      <Panel>
        <Text v="h3">Your control</Text>
        <Text v="small" style={{ marginTop: 4 }}>
          Auto-pay is a permission on your own wallet, capped by Tempo: at most one bill per period, only to KEYKARD. Turning it off freezes your card.
        </Text>
        <Button testID="autopay-off" title="Turn off auto-pay" kind="danger" busy={busy} disabled={busy || !line.mandateActive || ['defaulted', 'settled'].includes(line.status)} style={{ marginTop: 14 }} onPress={turnOff} />
      </Panel>
    </Screen>
  )
}
