'use client'
import { usd, type AppConfig } from '@/lib/api'
import { CopyText, Qr } from './Qr'

/**
 * Repay from anywhere: an exchange, another wallet, a family member. Whatever arrives at this line's own
 * repayment address is applied automatically (the borrowed amount first, then fees); anything extra comes
 * back to the borrower's KEYKARD wallet. Works even with auto-pay turned off.
 */
export function RepayAnywhere({ line, cfg }: { line: any; cfg: AppConfig }) {
  if (!line.repayAccount) return null
  const total = BigInt(line.status === 'defaulted' ? line.totalDue : BigInt(line.owed ?? 0) + BigInt(line.feesDue ?? 0))
  return (
    <section className="panel" id="repay-anywhere">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Repay from any wallet</h2>
        {total > 0n && <span className="small">Owed <b>{usd(total)}</b></span>}
      </div>
      <p className="small">
        Send <b>{cfg.tokenSymbol}</b> on the <b>Tempo</b> network to your repayment address, from an exchange, another wallet or a
        family member. It’s applied to your card within seconds, even if auto-pay is off.
      </p>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ padding: 8, background: '#fff', borderRadius: 14, lineHeight: 0 }}><Qr value={line.repayAccount} size={128} /></div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <CopyText text={line.repayAccount} />
          <ul className="small muted" style={{ paddingLeft: 18 }}>
            <li>Pays what you borrowed first, then any fees.</li>
            <li>Sent more than you owe? The rest goes to your KEYKARD wallet.</li>
            <li>This address only ever forwards to KEYKARD. Only send {cfg.tokenSymbol} on Tempo.</li>
          </ul>
        </div>
      </div>
    </section>
  )
}

/** Plain-words pricing, read from the CreditTerms contract. */
export function TermsNote({ cfg }: { cfg: AppConfig }) {
  const t = cfg.terms
  if (!t) return null
  return (
    <p className="small muted">
      On time costs nothing. A missed bill costs a <b>{usd(t.lateFee)}</b> late fee, then <b>{t.penaltyBpsPerPeriod / 100}%</b> of the
      overdue amount each billing period, never more than <b>{t.capBps / 100}%</b> of it in total. Family backups never pay fees.{' '}
      {cfg.creditTerms && (
        <a href={`${cfg.explorerUrl}/address/${cfg.creditTerms}`} target="_blank" rel="noreferrer">Terms on-chain ↗</a>
      )}
    </p>
  )
}
