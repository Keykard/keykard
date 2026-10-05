import { useState } from 'react'
import { Alert, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { api } from '@/lib/api'
import { toBase, usd } from '@/lib/format'
import { Banner, Button, Chip, Field, Panel, Row, Text } from './kit'
import { color, font } from './theme'

export type Offer = { id: number; pctBps: number; maxPerPayment: string; budget: string; spent: string; endsAt: string | null; status: string; live: boolean; ended: boolean }
export type OfferStats = { payments: number; customers: number; cashback: string; sales: string }

const safeBase = (v: string) => {
  try {
    return toBase(v || '0')
  } catch {
    return 0n
  }
}

/**
 * A shop's own promotion: "N% back, up to $X per payment, until <date>, budget $B". The cashback comes out of the
 * shop's payout automatically and can never exceed the budget. Mirrors apps/web/components/MerchantOffer.tsx.
 */
export function MerchantOffer({ offer, stats, feeBps, onChange }: { offer: Offer | null; stats: OfferStats | null; feeBps: number; onChange: () => void }) {
  const [pct, setPct] = useState('10')
  const [max, setMax] = useState('2')
  const [budget, setBudget] = useState('50')
  const [days, setDays] = useState('30')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const current = offer && !offer.ended ? offer : null

  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      setCreating(false)
      onChange()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }
  const create = run('create', async () => {
    const p = Math.round(Number(pct) * 100)
    if (!(p >= 1 && p <= 5000)) throw new Error('Cashback must be between 0.01% and 50%.')
    const d = Number(days)
    await api('/api/merchant/offers', {
      body: { pctBps: p, maxPerPayment: toBase(max).toString(), budget: toBase(budget).toString(), endsAt: d > 0 ? new Date(Date.now() + d * 86400_000).toISOString() : null },
    })
  })
  const act = (id: number, a: 'pause' | 'resume' | 'end') => run(a, () => api(`/api/merchant/offers/${id}/${a}`, { method: 'POST' }))
  const example = (() => {
    const o = (safeBase('10') * BigInt(Math.round(Number(pct || 0) * 100))) / 10_000n
    return o > safeBase(max) ? safeBase(max) : o
  })()

  return (
    <Panel>
      <Row between>
        <Text v="h2">Offers</Text>
        <Text v="small">KEYKARD fee {feeBps / 100}%</Text>
      </Row>
      <Text v="small" style={{ marginTop: 4 }}>Bring customers in with cashback. It’s taken from your payout automatically and never goes over your budget.</Text>

      {current && (
        <View style={{ marginTop: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(61,220,151,0.35)', backgroundColor: 'rgba(61,220,151,0.06)' }}>
          <Row between>
            <Text style={{ color: color.text, fontFamily: font.medium, flex: 1 }}>{current.pctBps / 100}% back, up to {usd(current.maxPerPayment)}</Text>
            <Text v="small" style={{ color: current.live ? color.ok : color.warn }}>● {current.live ? 'Live' : 'Paused'}</Text>
          </Row>
          <Text v="small" style={{ marginTop: 6 }}>
            Budget {usd(current.spent)} of {usd(current.budget)} used{current.endsAt ? ` · ends ${new Date(current.endsAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}
          </Text>
          <View style={{ height: 4, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: 10, overflow: 'hidden' }}>
            <View style={{ height: 4, width: `${Math.min(100, (Number(current.spent) / Number(current.budget)) * 100)}%`, backgroundColor: color.ok }} />
          </View>
          {stats && (
            <Row style={{ marginTop: 12 }}>
              <Chip label="Customers" value={String(stats.customers)} />
              <Chip label="Sales with offer" value={usd(stats.sales)} />
            </Row>
          )}
          <Row style={{ marginTop: 12 }}>
            {current.status === 'active'
              ? <Button testID="offer-pause" title={busy === 'pause' ? 'Pausing…' : 'Pause'} kind="ghost" small busy={busy === 'pause'} style={{ flex: 1 }} onPress={act(current.id, 'pause')} />
              : <Button testID="offer-resume" title={busy === 'resume' ? 'Resuming…' : 'Resume'} small busy={busy === 'resume'} style={{ flex: 1 }} onPress={act(current.id, 'resume')} />}
            <Button
              testID="offer-end"
              title={busy === 'end' ? 'Ending…' : 'End offer'}
              kind="danger"
              small
              busy={busy === 'end'}
              style={{ flex: 1 }}
              onPress={() => Alert.alert('End this offer?', 'Customers stop getting the cashback.', [{ text: 'Keep it', style: 'cancel' }, { text: 'End', style: 'destructive', onPress: () => void act(current.id, 'end')() }])}
            />
          </Row>
        </View>
      )}

      {!current && offer?.ended && stats && (
        <Text v="small" style={{ marginTop: 10, color: color.text }}>
          Your last offer ended: {stats.customers} customers, {usd(stats.sales)} in sales, {usd(stats.cashback)} given back.
        </Text>
      )}

      {!current && !creating && <Button testID="offer-create" title="Create an offer" style={{ marginTop: 14 }} onPress={() => setCreating(true)} />}
      {!current && creating && (
        <>
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><Field testID="offer-pct" label="Cashback (%)" keyboardType="decimal-pad" value={pct} onChangeText={setPct} /></View>
            <View style={{ flex: 1 }}><Field testID="offer-max" label="Most per payment ($)" keyboardType="decimal-pad" value={max} onChangeText={setMax} /></View>
          </Row>
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><Field testID="offer-budget" label="Total budget ($)" keyboardType="decimal-pad" value={budget} onChangeText={setBudget} /></View>
            <View style={{ flex: 1 }}><Field testID="offer-days" label="Runs for (days)" keyboardType="number-pad" value={days} onChangeText={setDays} /></View>
          </Row>
          <Text v="small" style={{ marginTop: 10 }}>Example: a $10 sale gives your customer {usd(example)} back.</Text>
          <Row style={{ marginTop: 12 }}>
            <Button title="Cancel" kind="ghost" small style={{ flex: 1 }} onPress={() => setCreating(false)} />
            <Button testID="offer-start" title={busy === 'create' ? 'Starting…' : 'Start offer'} small busy={busy === 'create'} style={{ flex: 1 }} onPress={create} />
          </Row>
        </>
      )}
      {err && <Banner kind="error">{err}</Banner>}
    </Panel>
  )
}
