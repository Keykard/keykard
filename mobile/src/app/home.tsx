import { useCallback, useEffect, useState } from 'react'
import { Go } from '@/ui/Go'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as WebBrowser from 'expo-web-browser'
import { api } from '@/lib/api'
import { usd } from '@/lib/format'
import { homeFor, useSession } from '@/lib/session'
import { tokenBalance } from '@/lib/wallet'
import { Banner, Button, Chip, Field, ListRow, Panel, Row, Text } from '@/ui/kit'
import { KeykardCard } from '@/ui/KeykardCard'
import { LineStatus } from '@/ui/LineStatus'
import { Countdown } from '@/ui/Countdown'
import { SecureNudge } from '@/ui/Security'
import { color, font, skins, type Skin } from '@/ui/theme'

type Activity = {
  spends: { tx_hash: string; label: string | null; merchant_code: string | null; amount: string; status: string; created_at?: string; base_cashback?: string; offer_cashback?: string; cashback_status?: string; cashback_tx?: string | null }[]
  events?: { action: string; created_at?: string }[]
  movements: { tx_hash: string; kind: string; amount: string; status: string; created_at?: string }[]
  charges?: { tx_hash: string; kind: 'late_fee' | 'penalty'; amount: string; overdue: string; created_at?: string }[]
}

const REPAID: Record<string, [string, string]> = {
  INST: ['Auto-pay', 'Bill paid'],
  GUAR: ['Paid by your family backup', 'Covered a missed bill'],
  EXT: ['Repaid from another wallet', 'Applied to your bill'],
  SEIZE: ['Covered by your collateral', 'After the default, from the vault'],
}

function Action({ icon, label, onPress, primary, disabled, testID }: { icon: string; label: string; onPress: () => void; primary?: boolean; disabled?: boolean; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ alignItems: 'center', gap: 8, flex: 1, opacity: disabled ? 0.35 : pressed ? 0.7 : 1 })}>
      <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? color.accent : color.surface2, borderWidth: primary ? 0 : 1, borderColor: color.hairline }}>
        <Text style={{ fontSize: 21, color: primary ? color.accentInk : color.text, fontFamily: font.medium }}>{icon}</Text>
      </View>
      <Text v="small" style={{ fontSize: 12.5 }}>{label}</Text>
    </Pressable>
  )
}

export default function Home() {
  const { me, cfg, refresh, loading } = useSession()
  const [bal, setBal] = useState<bigint | null>(null)
  const [act, setAct] = useState<Activity | null>(null)
  const [pulling, setPulling] = useState(false)

  const load = useCallback(async () => {
    await refresh()
    api<Activity>('/api/me/activity').then(setAct).catch(() => setAct((a) => a ?? { spends: [], movements: [] }))
  }, [refresh])
  const loadBal = useCallback(() => {
    if (me?.user?.wallet) tokenBalance(me.user.wallet).then(setBal).catch(() => {})
  }, [me?.user?.wallet])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))
  useEffect(() => {
    loadBal()
    const t = setInterval(loadBal, 20_000)
    return () => clearInterval(t)
  }, [loadBal])
  useEffect(() => {
    const t = setInterval(() => api<Activity>('/api/me/activity').then(setAct).catch(() => {}), 15_000)
    return () => clearInterval(t)
  }, [])

  if (!loading && (!me?.user || me.user.role !== 'borrower' || !me.line || me.line.status === 'preparing')) return <Go href={homeFor(me) as any} />
  if (!me?.line || !cfg) return <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} />

  const line = me.line
  const skin: Skin = (line.status in skins ? line.status : 'active') as Skin
  const frozen = line.status !== 'active'
  const receipt = (tx: string) => WebBrowser.openBrowserAsync(`${cfg.explorerUrl}/tx/${tx}`, { toolbarColor: color.bg })
  const spends = act?.spends ?? []
  const repaid = (act?.movements ?? []).filter((m) => m.status === 'confirmed' && m.kind in REPAID)
  const rows = [
    ...spends.map((s) => ({ key: s.tx_hash, at: s.created_at ?? '', icon: '↗', title: s.label ?? s.merchant_code ?? 'Payment', sub: s.status === 'settled' ? 'Paid to merchant' : s.status === 'received' ? 'Settling to merchant…' : s.status.replace(/_/g, ' '), right: `−${usd(s.amount)}`, positive: false, tx: s.tx_hash })),
    ...repaid.map((m) => ({ key: m.tx_hash, at: m.created_at ?? '', icon: '↺', title: REPAID[m.kind][0], sub: REPAID[m.kind][1], right: `+${usd(m.amount)}`, positive: true, tx: m.tx_hash })),
    ...spends
      .filter((s) => s.cashback_status === 'paid' && BigInt(s.base_cashback ?? '0') + BigInt(s.offer_cashback ?? '0') > 0n)
      .map((s) => ({ key: `${s.tx_hash}-cb`, at: s.created_at ?? '', icon: '★', title: `Cashback · ${s.label ?? s.merchant_code ?? 'shop'}`, sub: BigInt(s.offer_cashback ?? '0') > 0n ? (BigInt(s.base_cashback ?? '0') > 0n ? 'Shop offer + 0.5% back' : 'Shop offer') : '0.5% back on every payment', right: `+${usd(BigInt(s.base_cashback ?? '0') + BigInt(s.offer_cashback ?? '0'))}`, positive: true, tx: s.cashback_tx ?? s.tx_hash })),
    ...(act?.events ?? [])
      .filter((e) => e.action === 'reward.shield_earned' || e.action === 'reward.shield_used')
      .map((e, i) => ({ key: `shield-${i}-${e.created_at}`, at: e.created_at ?? '', icon: '◆', title: e.action === 'reward.shield_earned' ? 'Fee shield earned' : 'Fee shield used', sub: e.action === 'reward.shield_earned' ? '3 on-time bills in a row' : 'Your late fee was cancelled', right: '', positive: true, tx: '' })),
    ...(act?.charges ?? []).map((c) => ({ key: c.tx_hash, at: c.created_at ?? '', icon: '!', title: c.kind === 'late_fee' ? 'Late fee' : 'Overdue interest', sub: c.kind === 'late_fee' ? 'A bill was missed' : `On ${usd(c.overdue)} overdue`, right: usd(c.amount), positive: false, tx: c.tx_hash })),
  ].sort((a, b) => (b.at > a.at ? 1 : -1))

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={pulling} tintColor={color.accent} colors={[color.accent]} progressBackgroundColor={color.surface1} onRefresh={async () => {
          setPulling(true)
          await load()
          loadBal()
          setPulling(false)
        }} />}
      >
        <Row between style={{ marginBottom: 16 }}>
          <Text style={{ fontSize: 16 }}>Hi, <Text style={{ color: color.text, fontFamily: font.semibold, fontSize: 16 }}>{me.user?.username ? `@${me.user.username}` : 'there'}</Text></Text>
          <Pressable testID="home-settings" accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={12} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.surface1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.hairline }}>
            <Text style={{ fontSize: 18, color: color.text }}>⚙︎</Text>
          </Pressable>
        </Row>
        {!me.user?.username && <UsernameSetter onSet={load} />}
        <SecureNudge username={me.user?.username} sec={me.security} onChange={() => void load()} />

        <KeykardCard
          testID="home-card"
          amount={usd(line.spendable)}
          sub={`Limit ${usd(line.limit)} · owed ${usd(line.owed)}${BigInt(line.feesDue ?? '0') > 0n ? ` + ${usd(line.feesDue)} fees` : ''}`}
          skin={skin}
          badge={skins[skin].label}
          last4={line.creditAccount.slice(-4)}
        />

        <Row style={{ marginTop: 22, marginBottom: 4, gap: 0 }}>
          <Action testID="home-pay" icon="↗" label="Pay" primary disabled={frozen} onPress={() => router.push('/pay')} />
          <Action testID="home-repay" icon="↺" label="Auto-pay" onPress={() => router.push('/autopay')} />
          <Action testID="home-add" icon="+" label="Add money" onPress={() => router.push('/add-money')} />
          <Action testID="home-physical" icon="◈" label="Card" onPress={() => router.push('/physical')} />
        </Row>

        <LineStatus line={line} walletBal={bal} onChange={() => { void load(); loadBal() }} />

        <Row style={{ marginTop: 14 }}>
          <Chip label="Next bill" value={<Countdown to={line.nextDue} />} />
          <Chip label="Your wallet holds" value={bal === null ? '—' : usd(bal)} />
        </Row>

        <Panel>
          <Row between>
            <Text v="h2">Activity</Text>
            <Text v="small" style={{ color: color.text3 }}>Receipts are on-chain</Text>
          </Row>
          {!act ? (
            <Text v="small" style={{ textAlign: 'center', paddingVertical: 18 }}>Loading…</Text>
          ) : rows.length === 0 ? (
            <Text v="small" style={{ textAlign: 'center', paddingVertical: 18, color: color.text3 }}>No payments yet. Your first one shows up here.</Text>
          ) : (
            rows.slice(0, 20).map((r) => <ListRow key={r.key} icon={r.icon} title={r.title} sub={r.sub} right={r.right} rightSub={r.tx ? 'Receipt ↗' : undefined} positive={r.positive} onPress={r.tx ? () => receipt(r.tx) : undefined} />)
          )}
        </Panel>

        <Panel>
          {['active', 'grace', 'frozen'].includes(line.status) && <ListRow icon="▣" title="A bigger limit" sub={BigInt(line.secured ?? '0') > 0n ? `${usd(line.secured)} secured by your collateral` : 'Lock collateral 1:1, spend more'} onPress={() => router.push('/secured')} />}
        </Panel>

        <Pressable onPress={() => router.push('/family')} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <Panel>
            <Row between>
              <View style={{ flex: 1 }}>
                <Text v="h3">Family backup</Text>
                <Text v="small" style={{ marginTop: 2 }}>
                  {line.guarantorWallet ? `Backed for up to ${usd(line.guaranteed ?? '0')}` : 'A relative can back your line and raise your limit a level.'}
                </Text>
              </View>
              <Text style={{ color: color.accentHi, fontSize: 18 }}>›</Text>
            </Row>
          </Panel>
        </Pressable>

        {cfg.network === 'testnet' && <Text v="small" style={{ textAlign: 'center', marginTop: 20, color: color.text3 }}>Tempo testnet · test dollars only</Text>}
      </ScrollView>
    </SafeAreaView>
  )
}

function UsernameSetter({ onSet }: { onSet: () => void }) {
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Banner kind="info" style={{ marginTop: 0, marginBottom: 14 }}>
      <Text v="small" style={{ color: color.text }}>Choose a username. It’s shown on your KEYKARD.</Text>
      <Field autoCapitalize="none" placeholder="e.g. maria.santos" value={v} onChangeText={(t) => setV(t.replace(/\s/g, ''))} error={err} />
      <Button title="Save" small busy={busy} disabled={v.trim().length < 3} style={{ marginTop: 10 }} onPress={async () => {
        setErr(null)
        setBusy(true)
        try {
          await api('/api/me/username', { body: { username: v.trim().toLowerCase() } })
          onSet()
        } catch (e: any) {
          setErr(e.message)
        } finally {
          setBusy(false)
        }
      }} />
    </Banner>
  )
}
