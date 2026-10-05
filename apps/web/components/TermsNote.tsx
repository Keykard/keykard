'use client'
import { usd, type AppConfig } from '@/lib/api'

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
