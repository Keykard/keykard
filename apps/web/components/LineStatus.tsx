'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, usd } from '@/lib/api'
import { explainChainError, renewMandateFlow } from '@/lib/wallet'

/** "in 4 min" / "2 h" / "overdue" */
export function useCountdown(to: string | null | undefined) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (!to) return null
  const ms = new Date(to).getTime() - now
  if (ms <= 0) return 'now'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`
}

/**
 * One clear banner per line state, with the action that fixes it:
 *   active  → next statement countdown + low-balance warning
 *   grace   → overdue amount, deadline, [Pay now]
 *   frozen  → why, and [Re-enable auto-debit] / [Pay now]
 *   defaulted → unpaid amount, [Pay to settle]
 *   settled → [Open a new line]
 */
export function LineStatus({ line, walletBal, onChange }: { line: any; walletBal: bigint | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const nextIn = useCountdown(line.nextDue)
  const graceIn = useCountdown(line.graceUntil)
  const owed = BigInt(line.owed ?? '0')
  const due = BigInt(line.amountDue ?? '0')
  const fees = BigInt(line.feesDue ?? '0')
  // the borrowed amount, plus any fees from a missed bill (paid in that order)
  const payable = (line.status === 'defaulted' ? due : owed > due ? owed : due) + fees
  const feeNote = fees > 0n && <> (includes <b>{usd(fees)}</b> in late fees)</>
  const short = walletBal !== null && payable > walletBal ? payable - walletBal : 0n

  const act = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      setMsg(done)
      onChange()
    } catch (e: any) {
      setErr(explainChainError(e))
    } finally {
      setBusy(null)
    }
  }
  const payNow = act('pay', () => api('/api/lines/pay-now', { method: 'POST' }), 'Payment collected.')
  const renew = act('renew', () => renewMandateFlow(), 'Auto-pay is back on.')

  const PayBtn = ({ label }: { label: string }) => (
    <button className="block" disabled={busy !== null || payable === 0n || !line.mandateActive} onClick={payNow}>
      {busy === 'pay' ? 'Collecting…' : label}
    </button>
  )
  const RenewBtn = () => (
    <button className="block" disabled={busy !== null} onClick={renew}>
      {busy === 'renew' ? 'Confirm in your wallet…' : 'Turn auto-pay back on'}
    </button>
  )
  const lowBalance = short > 0n && (
    <p className="small warn">Your wallet has {usd(walletBal)}. Add at least {usd(short)} (see “Add money” below).</p>
  )

  let body: React.ReactNode = null
  if (line.status === 'active') {
    body = owed > 0n ? (
      <div className="notice small">
        Next bill in <b>{nextIn ?? '—'}</b>: <b>{usd(owed + fees)}</b>{feeNote} will be paid automatically from your wallet.
        {lowBalance}
        {line.mandateActive && (
          <div style={{ marginTop: 8 }}>
            <button className="ghost block" disabled={busy !== null} onClick={payNow}>{busy === 'pay' ? 'Collecting…' : `Pay ${usd(owed + fees)} now`}</button>
          </div>
        )}
      </div>
    ) : fees > 0n ? (
      <div className="notice small">
        <b>{usd(fees)}</b> in late fees from a missed bill will be collected with your next bill in {nextIn ?? '—'}.
        {line.mandateActive && (
          <div style={{ marginTop: 8 }}>
            <button className="ghost block" disabled={busy !== null} onClick={payNow}>{busy === 'pay' ? 'Collecting…' : `Pay ${usd(fees)} now`}</button>
          </div>
        )}
      </div>
    ) : (
      <p className="small muted">Nothing owed. Next bill in {nextIn ?? '—'}.</p>
    )
  } else if (line.status === 'grace') {
    body = (
      <div className="error">
        <b>{usd(due)} is overdue.</b> Your card is paused until it’s paid. Deadline: <b>{graceIn}</b>
        {line.guarantorWallet ? ' — after that your guarantor is charged.' : Number(line.secured ?? 0) > 0 ? ' — after that your line defaults and your collateral covers it.' : ' — after that your line defaults.'}
        {fees > 0n && <> A late fee applies, and interest is added each period it stays overdue: you now owe <b>{usd(payable)}</b>{feeNote}.</>}
        {lowBalance}
        <div style={{ marginTop: 8 }}>{line.mandateActive ? <PayBtn label={`Pay ${usd(payable)} now`} /> : <RenewBtn />}</div>
      </div>
    )
  } else if (line.status === 'frozen') {
    const why =
      line.freezeReason === 'MandateRevoked'
        ? 'you turned off auto-pay'
        : line.freezeReason === 'MissedPayment'
          ? 'a missed payment was covered by your guarantor'
          : line.freezeReason === 'Manual'
            ? 'KEYKARD froze it'
            : 'it is frozen'
    body = (
      <div className="error">
        <b>Card frozen</b> because {why}. Tempo now refuses any payment from it.
        {due > 0n && (
          <>
            {' '}<b>{usd(due)}</b> is overdue{line.graceUntil ? <> (deadline {graceIn})</> : null}.
          </>
        )}
        {lowBalance}
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          {line.freezeReason === 'MandateRevoked' && !line.mandateActive && <RenewBtn />}
          {line.mandateActive && payable > 0n && <PayBtn label={`Pay ${usd(payable)} now`} />}
          {line.freezeReason === 'MissedPayment' && <span className="small">Settle with your guarantor, then contact KEYKARD to reopen.</span>}
        </div>

      </div>
    )
  } else if (line.status === 'defaulted') {
    body = (
      <div className="error">
        <b>Line defaulted.</b> You owe <b>{usd(payable)}</b>{feeNote}. It is recorded on your public credit file, and interest is added
        each period until it’s paid (capped). Pay it to settle your record and open a new line.
        {lowBalance}
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          {line.mandateActive ? <PayBtn label={`Pay ${usd(payable)} to settle`} /> : <RenewBtn />}
        </div>
      </div>
    )
  } else if (line.status === 'settled') {
    body = (
      <div className="notice">
        <b>Settled.</b> Your defaulted line was repaid in full. <Link href="/start">Open a new line →</Link>
      </div>
    )
  }
  return (
    <>
      {body}
      {err && <p className="error small">{err}</p>}
      {msg && <p className="notice small">{msg}</p>}
    </>
  )
}
