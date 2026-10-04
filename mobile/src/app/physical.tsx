import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import { api } from '@/lib/api'
import { short, usd } from '@/lib/format'
import { cancelCardRead, nfcState, openNfcSettings } from '@/lib/halo'
import { useReaderGuard } from '@/lib/useReaderGuard'
import { useSession } from '@/lib/session'
import { explainChainError, linkPhysicalCard } from '@/lib/wallet'
import { Banner, Button, Link, Panel, Screen, Text } from '@/ui/kit'
import { CardFlowSheet, type FlowState } from '@/ui/CardFlowSheet'
import { color } from '@/ui/theme'

export default function Physical() {
  const { me, refresh } = useSession()
  const [nfc, setNfc] = useState<'ok' | 'off' | 'none' | null>(null)
  const [busy, setBusy] = useState(false)
  const [flow, setFlow] = useState<{ state: FlowState; error?: string; card?: string; limit?: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const line = me?.line
  const card = line?.card
  const linked = card && (card.status === 'active' || card.status === 'frozen')
  const canLink = line?.status === 'active'
  useReaderGuard()

  useEffect(() => {
    nfcState().then(setNfc)
  }, [])

  const run = (fn: () => Promise<unknown>, done: string, withTap = false) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(true)
    try {
      await fn()
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      setMsg(done)
      await refresh()
    } catch (e: any) {
      if (!/Cancelled/i.test(e?.message)) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
        setErr(explainChainError(e))
      }
    } finally {
      setBusy(false)
    }
  }
  const link = async () => {
    setErr(null)
    setMsg(null)
    setFlow({ state: 'hold' })
    try {
      const r = await linkPhysicalCard((st) => setFlow((f) => (f ? { ...f, state: st } : f)))
      setFlow({ state: 'done', card: r.cardAddress, limit: r.cardLimit })
      await refresh()
    } catch (e: any) {
      if (/Cancelled/i.test(e?.message)) setFlow(null)
      else setFlow({ state: 'error', error: explainChainError(e) })
    }
  }
  const freeze = run(() => api('/api/card/freeze', { method: 'POST' }), 'Card frozen. Unfreeze it any time.')
  const unfreeze = run(() => api('/api/card/unfreeze', { method: 'POST' }), 'Card unfrozen.')
  const unlink = () =>
    Alert.alert(
      'Unlink this card for good?',
      'You won’t be able to link this same card to this KEYKARD again (a Tempo protocol rule). To pause it, freeze it instead.',
      [{ text: 'Keep it', style: 'cancel' }, { text: 'Unlink', style: 'destructive', onPress: run(() => api('/api/card/unlink', { method: 'POST' }), 'Card unlinked.') }],
    )

  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} />
      <Text v="h1" style={{ marginTop: 18 }}>Physical card</Text>
      <Text style={{ marginTop: 6 }}>Tap-to-pay with an NFC card (for example a Burner card). It gets its own small contactless limit.</Text>

      {nfc === 'none' && <Banner kind="warn">This phone doesn’t have NFC, so it can’t read a card. Your KEYKARD still works for paying by code or QR.</Banner>}
      {nfc === 'off' && (
        <Banner kind="warn">
          <Text v="small" style={{ color: color.text }}>NFC is turned off.</Text>
          <Button title="Turn on NFC" small kind="quiet" style={{ marginTop: 10, alignSelf: 'flex-start' }} onPress={async () => {
            await openNfcSettings()
            setTimeout(() => nfcState().then(setNfc), 1500)
          }} />
        </Banner>
      )}

      <Panel>
        {linked ? (
          <>
            <Text v="eyebrow" style={{ color: card!.status === 'active' ? color.ok : color.warn }}>{card!.status === 'active' ? '● Active' : '● Frozen'}</Text>
            <Text v="h2" style={{ marginTop: 8 }}>Card {short(card!.address)}</Text>
            <Text v="small" style={{ marginTop: 4 }}>Tap limit {usd(card!.limit)} per period. Lost it? Freeze it instantly.</Text>
            {card!.status === 'active' ? (
              <Button testID="card-freeze" title="Freeze card" kind="danger" busy={busy} disabled={busy} style={{ marginTop: 16 }} onPress={freeze} />
            ) : (
              <Button testID="card-unfreeze" title="Unfreeze card" busy={busy} disabled={busy || !canLink} style={{ marginTop: 16 }} onPress={unfreeze} />
            )}
            <Button title="Unlink card permanently" kind="ghost" disabled={busy} style={{ marginTop: 8 }} onPress={unlink} />
          </>
        ) : (
          <>
            <Text v="h3">Link a card</Text>
            <Text v="small" style={{ marginTop: 4 }}>
              KEYKARD uses the card’s free key slot. Your Burner wallet and PIN are never touched.
            </Text>
            {!canLink && <Banner kind="warn">Your line must be active to link a card.</Banner>}
            <Button testID="card-link" title="Link a physical card" busy={!!flow && flow.state !== 'done' && flow.state !== 'error'} disabled={busy || !!flow || !canLink || nfc !== 'ok'} style={{ marginTop: 16 }} onPress={link} />
          </>
        )}
      </Panel>
      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
      <CardFlowSheet
        visible={!!flow}
        mode="link"
        state={flow?.state ?? 'hold'}
        title="Link your card"
        error={flow?.error}
        done={flow?.state === 'done' ? {
          headline: 'Card linked',
          lines: [`KEYKARD •••• ${flow.card?.slice(-4) ?? ''} is ready.`, `Tap limit ${usd(flow.limit ?? '0')} per period.`, 'Tap it on any KEYKARD merchant’s phone to pay.'],
        } : undefined}
        onCancel={() => { void cancelCardRead(); setFlow(null) }}
        onClose={() => setFlow(null)}
        onRetry={link}
      />
    </Screen>
  )
}
