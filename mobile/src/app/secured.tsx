import { useCallback, useEffect, useState } from 'react'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import * as WebBrowser from 'expo-web-browser'
import { toBase, usd } from '@/lib/format'
import { useSession } from '@/lib/session'
import { PasskeyCancelled } from '@/lib/passkey'
import { addCollateral, explainChainError, tokenBalance, withdrawCollateral } from '@/lib/wallet'
import { Banner, Button, Chip, Field, Link, Panel, Row, Screen, Text } from '@/ui/kit'
import { color } from '@/ui/theme'
import { EarnCollateral } from '@/ui/EarnCollateral'

/**
 * A bigger limit, secured 1:1: lock your own stablecoins in the KEYKARD vault and the limit grows by the same
 * amount. KEYKARD can take collateral only after a default on the public credit file, and only what's owed.
 */
export default function Secured() {
  const { me, cfg, refresh } = useSession()
  const [amount, setAmount] = useState('')
  const [bal, setBal] = useState<bigint | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const line = me?.line
  const col = me?.collateral

  const loadBal = useCallback(() => {
    if (me?.user?.wallet) tokenBalance(me.user.wallet).then(setBal).catch(() => {})
  }, [me?.user?.wallet])
  useEffect(() => {
    loadBal()
  }, [loadBal])

  if (!line || !cfg) return <Screen><Text>Loading…</Text></Screen>
  if (!cfg.collateralVault || !col) return <Screen><Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} /><Text style={{ marginTop: 18 }}>Secured limits aren’t available yet.</Text></Screen>

  const secured = BigInt(line.secured ?? '0')
  const plain = secured - BigInt(line.securedEarn ?? '0') // the Earn part unlocks in its own panel
  const max = BigInt(cfg.maxSecured ?? '0')
  const unlocked = BigInt(col.available ?? '0')
  const active = line.status === 'active'
  let base = 0n
  try {
    base = amount ? toBase(amount) : 0n
  } catch {}

  const run = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      setMsg(done)
      setAmount('')
      await refresh()
      loadBal()
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled) && !/cancelled/i.test(e?.message)) setErr(explainChainError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} />
      <Text v="h1" style={{ marginTop: 18 }}>A bigger limit</Text>
      <Text style={{ marginTop: 6 }}>
        Lock your own {cfg.tokenSymbol} as collateral and your limit grows 1:1: lock $100, spend $100 more. On-time bills still grow the unsecured part on top.
      </Text>

      <Row style={{ marginTop: 14 }}>
        <Chip label="Unsecured limit" value={usd(line.unsecuredLimit ?? line.limit)} />
        <Chip label="Secured by collateral" value={usd(secured)} />
      </Row>
      <Row style={{ marginTop: 10 }}>
        <Chip label="Total limit" value={usd(line.limit)} />
        <Chip label="Your wallet holds" value={bal === null ? '—' : usd(bal)} />
      </Row>

      <Panel>
        <Field testID="secured-amount" label="Amount (USD)" keyboardType="decimal-pad" placeholder="100" value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} />
        {bal !== null && base > bal && (
          <Text v="small" style={{ color: color.warn, marginTop: 8 }}>
            Your wallet has {usd(bal)}. <Text v="small" style={{ color: color.accentHi }} onPress={() => router.push('/add-money')}>Add money ›</Text>
          </Text>
        )}
        {base > 0n && secured + base > max && <Text v="small" style={{ color: color.warn, marginTop: 8 }}>The most collateral per person is {usd(max)}.</Text>}
        <Button
          testID="secured-lock"
          title={busy === 'add' ? 'Confirm in your wallet…' : base > 0n ? `Lock ${usd(base)}` : 'Lock collateral'}
          busy={busy === 'add'}
          disabled={!active || !!busy || base <= 0n || secured + base > max || (bal !== null && base > bal)}
          style={{ marginTop: 16 }}
          onPress={run('add', () => addCollateral(base), `Locked ${usd(base)}. Your limit is now ${usd(BigInt(line.limit) + base)}.`)}
        />
        <Button
          testID="secured-unlock"
          title={busy === 'out' ? 'Working…' : 'Unlock and withdraw'}
          kind="ghost"
          busy={busy === 'out'}
          disabled={!active || !!busy || base <= 0n || base > plain}
          style={{ marginTop: 10 }}
          onPress={run('out', () => withdrawCollateral(base), `Unlocked ${usd(base)} and sent it back to your wallet.`)}
        />
        {unlocked > 0n && (
          <Button title={busy === 'wd' ? 'Withdrawing…' : `Withdraw ${usd(unlocked)} unlocked`} kind="quiet" busy={busy === 'wd'} disabled={!!busy} style={{ marginTop: 10 }} onPress={run('wd', () => withdrawCollateral(unlocked, true), `Withdrew ${usd(unlocked)} to your wallet.`)} />
        )}
        {!active && <Text v="small" style={{ marginTop: 10 }}>Collateral changes are paused while your card isn’t active.</Text>}
      </Panel>

      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}

      <EarnCollateral line={line} earn={me?.earn} cfg={cfg} bal={bal} onChange={async () => { await refresh(); loadBal() }} />

      <Panel>
        <Text v="h3">Who holds it</Text>
        <Text v="small" style={{ marginTop: 4 }}>
          Your collateral sits in the KEYKARD vault contract, not with us. KEYKARD can take it only if your line defaults on the public credit file, and only what you owe; the rest comes back to you. Lower your secured limit any time to unlock it.
        </Text>
        <Link title="Vault on the explorer ↗" style={{ marginTop: 10 }} onPress={() => WebBrowser.openBrowserAsync(`${cfg.explorerUrl}/address/${cfg.collateralVault}`)} />
      </Panel>
    </Screen>
  )
}
