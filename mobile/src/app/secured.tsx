import { useCallback, useEffect, useState } from 'react'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import * as WebBrowser from 'expo-web-browser'
import { toBase, usd } from '@/lib/format'
import { useSession } from '@/lib/session'
import { PasskeyCancelled } from '@/lib/passkey'
import { explainChainError, tokenBalance, withdrawCollateral } from '@/lib/wallet'
import { Banner, Button, Chip, Field, Link, Panel, Row, Screen, Text } from '@/ui/kit'
import { color } from '@/ui/theme'
import { EarnCollateral } from '@/ui/EarnCollateral'

/**
 * A bigger limit: lock stablecoins in a Tempo Earn vault (EarnCollateral) and the limit grows while they earn.
 * Collateral locked earlier in the plain 1:1 vault (which doesn't earn) can only be unlocked here.
 * KEYKARD can take collateral only after a default on the public credit file, and only what's owed.
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
        Lock your own {cfg.tokenSymbol} and your limit grows, while that money keeps earning in a Tempo Earn vault. On-time bills still grow the unsecured part on top.
      </Text>

      <Row style={{ marginTop: 14 }}>
        <Chip label="Unsecured limit" value={usd(line.unsecuredLimit ?? line.limit)} />
        <Chip label="Secured by collateral" value={usd(secured)} />
      </Row>
      <Row style={{ marginTop: 10 }}>
        <Chip label="Total limit" value={usd(line.limit)} />
        <Chip label="Your wallet holds" value={bal === null ? '—' : usd(bal)} />
      </Row>

      <EarnCollateral line={line} earn={me?.earn} cfg={cfg} bal={bal} onChange={async () => { await refresh(); loadBal() }} />

      {(plain > 0n || unlocked > 0n) && (
        <Panel>
          <Row between>
            <Text v="h2">Not earning yet</Text>
            <Text v="small">Locked {usd(plain)}</Text>
          </Row>
          <Text v="small" style={{ marginTop: 4 }}>
            You locked this before collateral could earn. Unlock it (your limit drops by the same amount), then lock it again above to keep the same limit while it earns.
          </Text>
          {plain > 0n && (
            <>
              <Field testID="secured-amount" label="Amount to unlock (USD)" keyboardType="decimal-pad" placeholder={usd(plain)} value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} />
              <Row style={{ marginTop: 12 }}>
                <Button
                  testID="secured-unlock"
                  title={busy === 'out' ? 'Working…' : base > 0n ? `Unlock ${usd(base)}` : 'Unlock'}
                  kind="ghost"
                  busy={busy === 'out'}
                  disabled={!active || !!busy || base <= 0n || base > plain}
                  style={{ flex: 1 }}
                  onPress={run('out', () => withdrawCollateral(base), `Unlocked ${usd(base)} and sent it back to your wallet.`)}
                />
                <Button title="All" kind="quiet" disabled={!!busy} style={{ flex: 1 }} onPress={() => setAmount((Number(plain) / 1e6).toString())} />
              </Row>
            </>
          )}
          {unlocked > 0n && (
            <Button title={busy === 'wd' ? 'Withdrawing…' : `Withdraw ${usd(unlocked)} unlocked`} kind="quiet" busy={busy === 'wd'} disabled={!!busy} style={{ marginTop: 10 }} onPress={run('wd', () => withdrawCollateral(unlocked, true), `Withdrew ${usd(unlocked)} to your wallet.`)} />
          )}
          {!active && <Text v="small" style={{ marginTop: 10 }}>Collateral changes are paused while your card isn’t active.</Text>}
        </Panel>
      )}

      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}

      <Panel>
        <Text v="h3">Who holds it</Text>
        <Text v="small" style={{ marginTop: 4 }}>
          Your collateral sits in vault contracts, not with us. KEYKARD can take it only if your line defaults on the public credit file, and only what you owe; the rest comes back to you. Unlock it any time while your card is in good standing.
        </Text>
        <Link title="Vault on the explorer ↗" style={{ marginTop: 10 }} onPress={() => WebBrowser.openBrowserAsync(`${cfg.explorerUrl}/address/${cfg.earn?.collateralVault ?? cfg.collateralVault}`)} />
      </Panel>
    </Screen>
  )
}
