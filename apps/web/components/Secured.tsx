'use client'
import { useState } from 'react'
import { toBase, usd, type AppConfig } from '@/lib/api'
import { addCollateral, explainChainError, withdrawCollateral } from '@/lib/wallet'

/**
 * Secured limit, 1:1: lock your own stablecoins in the KEYKARD vault and your limit grows by the same amount.
 * KEYKARD can only take collateral after a default recorded on the public credit file, and only what's owed.
 */
export function Secured({ line, collateral, cfg, walletBal, onChange }: { line: any; collateral: any; cfg: AppConfig; walletBal: bigint | null; onChange: () => void }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  if (!cfg.collateralVault || !collateral || !['active', 'grace', 'frozen'].includes(line.status)) return null
  const secured = BigInt(line.secured ?? 0)
  const max = BigInt(cfg.maxSecured ?? 0)
  const unlocked = BigInt(collateral.available ?? 0) // released earlier but not yet withdrawn
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
    <section className="panel" id="secured">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Need a bigger limit?</h2>
        <span className="small">Secured <b>{usd(secured)}</b></span>
      </div>
      <p className="small">
        Lock your own {cfg.tokenSymbol} as collateral and your limit grows <b>1:1</b>: lock $100, spend $100 more. Your on-time
        payments still grow the unsecured part on top.
      </p>
      <div className="chips">
        <div>Unsecured limit<b>{usd(line.unsecuredLimit)}</b></div>
        <div>Secured by collateral<b>{usd(secured)}</b></div>
      </div>
      <p className="small muted">
        The collateral sits in the KEYKARD vault contract, not with us. KEYKARD can take it only if your line defaults on the public
        credit file, and only what you owe; the rest comes back to you. Lower your secured limit any time to unlock it.{' '}
        <a href={`${cfg.explorerUrl}/address/${cfg.collateralVault}`} target="_blank" rel="noreferrer">Vault on-chain ↗</a>
      </p>
      <label htmlFor="sec">Amount (USD)</label>
      <input id="sec" inputMode="decimal" placeholder="$100" value={amount} onChange={(e) => setAmount(e.target.value)} />
      {walletBal !== null && base > walletBal && <p className="small warn">Your wallet has {usd(walletBal)}. Add money first.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
        <button
          disabled={!active || busy !== null || base <= 0n || secured + base > max || (walletBal !== null && base > walletBal)}
          onClick={run('add', () => addCollateral(base), `Locked ${usd(base)}. Your limit is ${usd(BigInt(line.limit) + base)}.`)}
        >
          {busy === 'add' ? 'Confirm in your wallet…' : `Lock ${base > 0n ? usd(base) : ''}`}
        </button>
        <button
          className="ghost"
          disabled={!active || busy !== null || base <= 0n || base > secured}
          onClick={run('out', () => withdrawCollateral(base), `Unlocked ${usd(base)} and sent it back to your wallet.`)}
        >
          {busy === 'out' ? 'Working…' : 'Unlock'}
        </button>
      </div>
      {secured + base > max && base > 0n && <p className="small warn">The most collateral per person is {usd(max)}.</p>}
      {!active && <p className="small muted">Collateral changes are paused while your card isn’t active.</p>}
      {unlocked > 0n && (
        <button className="ghost block" style={{ marginTop: 8 }} disabled={busy !== null} onClick={run('wd', () => withdrawCollateral(unlocked, true), `Withdrew ${usd(unlocked)} to your wallet.`)}>
          {busy === 'wd' ? 'Withdrawing…' : `Withdraw ${usd(unlocked)} unlocked collateral`}
        </button>
      )}
      {err && <p className="error small">{err}</p>}
      {msg && <p className="notice small">{msg}</p>}
    </section>
  )
}
