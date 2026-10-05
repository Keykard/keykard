'use client'
import { useState } from 'react'
import type { Address } from 'viem'
import { api, usd, type AppConfig } from '@/lib/api'
import { CopyText, Qr } from './Qr'

/**
 * The user's own KEYKARD wallet: the ONE address for money in. Bills are paid from it by auto-pay, so sending money
 * here (from an exchange, another wallet or a family member) is how you repay. Overdue amounts are collected as soon
 * as the money arrives.
 * Tempo supports USDC.e / USDT0 deposits from Coins.ph and exchanges (Coins.ph added Tempo on 2026-08-09).
 */
export function AddMoney({ wallet, balance, cfg, onFunded }: { wallet: Address; balance: bigint | null; cfg: AppConfig; onFunded?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const testnet = cfg.network === 'testnet'
  const faucet = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api('/api/faucet', { method: 'POST' })
      setMsg('Test dollars sent. Your balance updates in a few seconds.')
      setTimeout(() => onFunded?.(), 4000)
    } catch (e: any) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Add money</h2>
        <span className="small">Balance <b>{balance === null ? '—' : usd(balance)}</b></span>
      </div>
      <p className="small">
        This is your KEYKARD wallet: your money, and where your bills are paid from. To add money or pay your bill, send{' '}
        <b>{cfg.tokenSymbol}</b> on the <b>Tempo</b> network here, from an exchange, another wallet or a family member.
      </p>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ padding: 8, background: '#fff', borderRadius: 14, lineHeight: 0 }}><Qr value={wallet} size={128} /></div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <CopyText text={wallet} />
          <ol className="small muted" style={{ paddingLeft: 18 }}>
            <li>In Coins.ph or your exchange, choose <b>Send / Withdraw</b> → <b>{cfg.tokenSymbol}</b>.</li>
            <li>Select the <b>Tempo</b> network. Other networks will not arrive.</li>
            <li>Paste this address and send.</li>
          </ol>
          <p className="small muted">Behind on a bill? It’s paid automatically as soon as the money arrives (auto-pay must be on).</p>
        </div>
      </div>
      {testnet && (
        <>
          <button className="ghost block" style={{ marginTop: 12 }} disabled={busy} onClick={faucet}>
            {busy ? 'Requesting…' : 'Get test dollars (testnet)'}
          </button>
          {msg && <p className="small notice">{msg}</p>}
        </>
      )}
    </div>
  )
}
