'use client'
import { useState } from 'react'
import { toBase, usd, type AppConfig } from '@/lib/api'
import { explainChainError, withdrawCollateral } from '@/lib/wallet'

/**
 * Collateral locked before it could earn (the original 1:1 CollateralVault). New collateral always goes through
 * EarnCollateral, so this panel only lets people unlock and withdraw what they locked here, and appears only for
 * them. KEYKARD can take it only after a default recorded on the public credit file, and only what's owed.
 */
export function Secured({ line, collateral, cfg, onChange }: { line: any; collateral: any; cfg: AppConfig; walletBal?: bigint | null; onChange: () => void }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  if (!cfg.collateralVault || !collateral || !['active', 'grace', 'frozen'].includes(line.status)) return null
  const plain = BigInt(line.secured ?? 0) - BigInt(line.securedEarn ?? 0)
  const unlocked = BigInt(collateral.available ?? 0) // released earlier but not yet withdrawn
  if (plain <= 0n && unlocked <= 0n) return null
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
        <h2 style={{ margin: 0 }}>Collateral that isn’t earning</h2>
        <span className="small">Locked <b>{usd(plain)}</b></span>
      </div>
      <p className="small">
        You locked this before collateral could earn. Unlock it (your limit drops by the same amount), then lock it again in
        <b> Collateral that earns</b> below to keep the same limit while it earns.
      </p>
      {plain > 0n && (
        <>
          <label htmlFor="sec">Amount to unlock (USD)</label>
          <input id="sec" inputMode="decimal" placeholder={usd(plain)} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button
              className="ghost"
              style={{ flex: 1 }}
              disabled={!active || busy !== null || base <= 0n || base > plain}
              onClick={run('out', () => withdrawCollateral(base), `Unlocked ${usd(base)} and sent it back to your wallet.`)}
            >
              {busy === 'out' ? 'Working…' : base > 0n ? `Unlock ${usd(base)}` : 'Unlock'}
            </button>
            <button className="ghost" style={{ flex: 1 }} disabled={busy !== null} onClick={() => setAmount((Number(plain) / 1e6).toString())}>
              All
            </button>
          </div>
        </>
      )}
      {!active && <p className="small muted">Collateral changes are paused while your card isn’t active.</p>}
      {unlocked > 0n && (
        <button className="ghost block" style={{ marginTop: 8 }} disabled={busy !== null} onClick={run('wd', () => withdrawCollateral(unlocked, true), `Withdrew ${usd(unlocked)} to your wallet.`)}>
          {busy === 'wd' ? 'Withdrawing…' : `Withdraw ${usd(unlocked)} unlocked collateral`}
        </button>
      )}
      <p className="small muted">
        It sits in the KEYKARD vault contract, not with us.{' '}
        <a href={`${cfg.explorerUrl}/address/${cfg.collateralVault}`} target="_blank" rel="noreferrer">Vault on-chain ↗</a>
      </p>
      {err && <p className="error small">{err}</p>}
      {msg && <p className="notice small">{msg}</p>}
    </section>
  )
}
