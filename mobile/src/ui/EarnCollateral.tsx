import { useState } from 'react'
import { Alert, View } from 'react-native'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import * as WebBrowser from 'expo-web-browser'
import type { AppConfig } from '@/lib/api'
import { toBase, usd } from '@/lib/format'
import { PasskeyCancelled } from '@/lib/passkey'
import { explainChainError, lockAndEarn, unlockEarn, withdrawEarn } from '@/lib/wallet'
import { Banner, Button, Chip, Field, Link, Panel, Row, Text } from './kit'
import { color, font } from './theme'

export type EarnPosition = {
  vault: string; share: string; collateralVault: string; ltvBps: number; simulated: boolean
  lockedShares: string; value: string; principal: string; earned: string; limitFromEarn: string; withdrawable: string
}
const micro = (v: string | bigint) => `$${(Number(v) / 1e6).toFixed(6)}`

/** Collateral that earns. Mirrors apps/web/components/EarnCollateral.tsx. */
export function EarnCollateral({ line, earn, cfg, bal, onChange }: { line: any; earn: EarnPosition | null | undefined; cfg: AppConfig; bal: bigint | null; onChange: () => Promise<unknown> | void }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  if (!cfg.earn || !earn) return null

  const locked = BigInt(earn.lockedShares) > 0n
  const active = line.status === 'active'
  const room = BigInt(cfg.maxSecured ?? '0') - BigInt(line.secured ?? '0')
  const ltv = BigInt(earn.ltvBps)
  let base = 0n
  try {
    base = amount ? toBase(amount) : 0n
  } catch {}
  const credit = (base * ltv) / 10_000n
  const withdrawable = BigInt(earn.withdrawable)

  const run = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      setMsg(done)
      setAmount('')
      await onChange()
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled) && !/cancelled/i.test(e?.message)) setErr(explainChainError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel>
      <Row between>
        <Text v="h2">Collateral that earns</Text>
        <Text style={{ fontFamily: font.monoMedium, fontSize: 10.5, letterSpacing: 1.2, color: color.ok }}>TEMPO EARN</Text>
      </Row>

      {locked ? (
        <>
          <Text v="small" style={{ marginTop: 14 }}>Your collateral is worth</Text>
          <Text testID="earn-value" style={{ fontFamily: font.mono, fontSize: 34, lineHeight: 42, color: color.text, letterSpacing: -1 }}>{micro(earn.value)}</Text>
          <Text v="small" style={{ color: color.ok }}>+{micro(earn.earned)} earned while backing your card</Text>
          <Row style={{ marginTop: 12 }}>
            <Chip label="Locked at" value={micro(earn.principal)} />
            <Chip label="Limit it adds" value={usd(earn.limitFromEarn)} />
          </Row>
          <Button
            testID="earn-unlock"
            title={busy === 'out' ? 'Working…' : 'Unlock all'}
            kind="ghost"
            busy={busy === 'out'}
            disabled={!active || !!busy}
            style={{ marginTop: 14 }}
            onPress={() => Alert.alert('Unlock everything?', `Your limit drops by ${usd(earn.limitFromEarn)} and ${micro(earn.value)} comes back to your wallet.`, [
              { text: 'Keep earning', style: 'cancel' },
              { text: 'Unlock', onPress: () => void run('out', unlockEarn, 'Unlocked. Your collateral and what it earned are back in your wallet.')() },
            ])}
          />
        </>
      ) : (
        <>
          <Text v="small" style={{ marginTop: 6 }}>
            Lock {cfg.tokenSymbol} in a Tempo Earn vault and your limit grows by {Number(ltv) / 100}% of it. It keeps earning while it backs your card, and you get all of it back, with what it earned, when you unlock.
          </Text>
          <Field testID="earn-amount" label="Amount (USD)" keyboardType="decimal-pad" placeholder="50" value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} />
          {bal !== null && base > bal && (
            <Text v="small" style={{ color: color.warn, marginTop: 8 }}>
              Your wallet has {usd(bal)}. <Text v="small" style={{ color: color.accentHi }} onPress={() => router.push('/add-money')}>Add money ›</Text>
            </Text>
          )}
          {base > 0n && credit > room && <Text v="small" style={{ color: color.warn, marginTop: 8 }}>That’s over the collateral limit: up to {usd(room > 0n ? room : 0n)} more limit.</Text>}
          <Button
            testID="earn-lock"
            title={busy === 'in' ? 'Confirm in your wallet…' : base > 0n ? `Lock ${usd(base)} · +${usd(credit)} limit` : 'Lock & earn'}
            busy={busy === 'in'}
            disabled={!active || !!busy || base < 1_000_000n || credit > room || (bal !== null && base > bal)}
            style={{ marginTop: 14 }}
            onPress={run('in', () => lockAndEarn(base), `Locked ${usd(base)} in Tempo Earn. Your limit grew by ${usd(credit)}.`)}
          />
        </>
      )}
      {withdrawable >= 10_000n && !busy && (
        <Button title={`Withdraw ${usd(withdrawable)} to your wallet`} kind="quiet" style={{ marginTop: 10 }} onPress={run('wd', withdrawEarn, 'Withdrawn to your wallet.')} />
      )}
      {!active && <Text v="small" style={{ marginTop: 10 }}>Collateral changes are paused while your card isn’t active.</Text>}
      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
      <Text v="small" style={{ marginTop: 12 }}>
        The shares sit in a vault contract, not with us. KEYKARD can take them only if your line defaults, and only enough to cover what you owe; the rest comes back to you.
      </Text>
      <Link title="Earn vault on the explorer ↗" style={{ marginTop: 8 }} onPress={() => WebBrowser.openBrowserAsync(`${cfg.explorerUrl}/address/${earn.vault}`)} />
      {earn.simulated && (
        <View style={{ marginTop: 12, borderLeftWidth: 2, borderLeftColor: color.warn, paddingLeft: 10 }}>
          <Text v="small">Testnet: this vault’s yield is simulated. KEYKARD tops it up, and every top-up is a public transaction. On mainnet it would be a real Tempo Earn vault.</Text>
        </View>
      )}
    </Panel>
  )
}
