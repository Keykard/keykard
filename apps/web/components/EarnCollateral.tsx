'use client'
import { useEffect, useState } from 'react'
import { api, toBase, usd, type AppConfig } from '@/lib/api'
import { explainChainError, lockAndEarn, unlockEarn, withdrawEarn } from '@/lib/wallet'

export type EarnPosition = {
  vault: string; share: string; collateralVault: string; ltvBps: number; simulated: boolean
  lockedShares: string; value: string; principal: string; earned: string; limitFromEarn: string; withdrawable: string
}
const micro = (v: string | bigint) => `$${(Number(v) / 1e6).toFixed(6)}`

/**
 * Collateral that earns: lock stablecoins in a Tempo Earn vault; the limit grows by 95% of their value and the
 * shares keep earning while they back the card. Unlock any time to get everything back, yield included.
 */
export function EarnCollateral({ line, earn, cfg, walletBal, onChange }: { line: any; earn: EarnPosition | null | undefined; cfg: AppConfig; walletBal: bigint | null; onChange: () => void }) {
  const [amount, setAmount] = useState('')
  const [pos, setPos] = useState(earn ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => setPos(earn ?? null), [earn])
  const locked = BigInt(pos?.lockedShares ?? 0) > 0n
  // the value grows between page loads: refresh just this panel while something is locked
  useEffect(() => {
    if (!locked) return
    const t = setInterval(() => api<{ earn: EarnPosition | null }>('/api/me').then((m) => m.earn && setPos(m.earn)).catch(() => {}), 20_000)
    return () => clearInterval(t)
  }, [locked])
  if (!cfg.earn || !pos || !['active', 'grace', 'frozen'].includes(line.status)) return null

  const active = line.status === 'active'
  const room = BigInt(cfg.maxSecured ?? 0) - BigInt(line.secured ?? 0)
  const ltv = BigInt(pos.ltvBps)
  let base = 0n
  try {
    base = amount ? toBase(amount) : 0n
  } catch {}
  const credit = (base * ltv) / 10_000n
  const withdrawable = BigInt(pos.withdrawable)

  const run = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      setMsg(done)
      setAmount('')
      onChange()
    } catch (e: any) {
      setErr(explainChainError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel earn" id="earn">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Collateral that earns</h2>
        <span className="earn-tag">Tempo Earn</span>
      </div>

      {locked ? (
        <>
          <div className="earn-value">
            <span className="small muted">Your collateral is worth</span>
            <b>{micro(pos.value)}</b>
            <span className="ok small">+{micro(pos.earned)} earned while backing your card</span>
          </div>
          <div className="chips">
            <div>Locked at<b>{micro(pos.principal)}</b></div>
            <div>Limit it adds<b>{usd(pos.limitFromEarn)}</b></div>
          </div>
          <button className="ghost block" disabled={!active || busy !== null} onClick={() => {
            if (!confirm(`Unlock everything? Your limit drops by ${usd(pos.limitFromEarn)} and ${micro(pos.value)} comes back to your wallet.`)) return
            void run('out', unlockEarn, 'Unlocked. Your collateral and what it earned are back in your wallet.')()
          }}>
            {busy === 'out' ? 'Working…' : 'Unlock all'}
          </button>
        </>
      ) : (
        <>
          <p className="small">
            Need a bigger limit? Lock {cfg.tokenSymbol} in a Tempo Earn vault and your limit grows{' '}
            <b>{ltv === 10_000n ? '1:1' : `by ${Number(ltv) / 100}% of it`}</b>{ltv === 10_000n ? ': lock $100, spend $100 more' : ''}. It keeps
            earning while it backs your card, and you get all of it back, with what it earned, when you unlock.
          </p>
          <label htmlFor="earn-amt">Amount (USD)</label>
          <input id="earn-amt" inputMode="decimal" placeholder="$50" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {walletBal !== null && base > walletBal && <p className="small warn">Your wallet has {usd(walletBal)}. Add money first.</p>}
          {base > 0n && credit > room && <p className="small warn">That’s over the collateral limit: you can add up to {usd(room > 0n ? room : 0n)} more limit.</p>}
          <button
            className="block"
            style={{ marginTop: 12 }}
            disabled={!active || busy !== null || base < 1_000_000n || credit > room || (walletBal !== null && base > walletBal)}
            onClick={run('in', () => lockAndEarn(base), `Locked ${usd(base)} in Tempo Earn. Your limit grew by ${usd(credit)}.`)}
          >
            {busy === 'in' ? 'Confirm in your wallet…' : base > 0n ? `Lock ${usd(base)} · +${usd(credit)} limit` : 'Lock & earn'}
          </button>
        </>
      )}

      {withdrawable >= 10_000n && !busy && (
        <button className="ghost block" style={{ marginTop: 8 }} onClick={run('wd', withdrawEarn, 'Withdrawn to your wallet.')}>
          Withdraw {usd(withdrawable)} back to your wallet
        </button>
      )}
      {!active && <p className="small muted">Collateral changes are paused while your card isn’t active.</p>}
      <p className="small muted">
        The shares sit in a vault contract, not with us. KEYKARD can take them only if your line defaults on the public credit file, and only enough to
        cover what you owe; the rest comes back to you.{' '}
        <a href={`${cfg.explorerUrl}/address/${pos.collateralVault}`} target="_blank" rel="noreferrer">Lock vault ↗</a>{' · '}
        <a href={`${cfg.explorerUrl}/address/${pos.vault}`} target="_blank" rel="noreferrer">Earn vault ↗</a>
      </p>
      {pos.simulated && (
        <p className="small earn-sim">
          Testnet: this vault’s yield is simulated. KEYKARD tops it up, and every top-up is a public transaction. On mainnet it would be a real
          Tempo Earn vault (for example the US Treasury-bill vault that takes USDC.e).
        </p>
      )}
      {err && <p className="error small">{err}</p>}
      {msg && <p className="notice small">{msg}</p>}
    </section>
  )
}
