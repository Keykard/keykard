import { parseEventLogs, type Hex } from 'viem'
import { creditTermsAbi } from '@keycard/sdk'
import { net } from './config'
import { termsRead, termsWrite } from './chain'
import { audit, sql } from './db'
import { useShieldOnMiss } from './rewards'

/**
 * Pricing for missed payments. Paying on time costs nothing. A missed bill costs one late fee, then penalty
 * interest once per period on the overdue amount (never on fees), with all charges for a line capped. The
 * amounts are computed by the CreditTerms contract from its published terms, and only for lines the public
 * credit file shows as overdue or defaulted; this module just asks for them and books the result.
 *
 * Repayments always pay the borrowed amount first, then fees. Family backups only ever cover the borrowed
 * amount, never fees.
 */
const enabled = () => Boolean(net.creditTerms)
// viem keeps the decoded revert name (e.g. "NothingToCharge") in the full message, not the short one
const reason = (e: any) => `${e?.shortMessage ?? ''} ${e?.message ?? ''} ${e?.details ?? ''} ${e?.cause?.data?.errorName ?? ''}`.trim() || String(e)
const NOTHING = /NothingToCharge|TooSoon|NotOverdue/

export type Terms = { lateFee: string; penaltyBpsPerPeriod: number; capBps: number; address: string } | null
let cached: { at: number; terms: Terms } | null = null

export async function publishedTerms(): Promise<Terms> {
  if (!enabled()) return null
  if (cached && Date.now() - cached.at < 60_000) return cached.terms
  const [lateFee, penalty, cap] = await Promise.all([
    termsRead<bigint>('lateFee'),
    termsRead<number>('penaltyBpsPerPeriod'),
    termsRead<number>('capBps'),
  ])
  const terms = { lateFee: lateFee.toString(), penaltyBpsPerPeriod: Number(penalty), capBps: Number(cap), address: net.creditTerms! }
  cached = { at: Date.now(), terms }
  return terms
}

async function charge(row: any, kind: 'late_fee' | 'penalty', overdue: bigint): Promise<bigint> {
  if (!enabled() || !row.linebook_id || overdue <= 0n) return 0n
  let receipt
  try {
    receipt = await termsWrite(kind === 'late_fee' ? 'chargeLateFee' : 'chargePenalty', [BigInt(row.linebook_id), overdue])
  } catch (e) {
    if (NOTHING.test(reason(e))) return 0n // cap reached, already charged, or no longer overdue on the public file
    throw e
  }
  const [ev] = parseEventLogs({ abi: creditTermsAbi, logs: receipt.logs, eventName: 'Charged' }) as any[]
  const amount = BigInt(ev?.args?.amount ?? 0)
  if (amount === 0n) return 0n
  const tx = receipt.transactionHash
  await sql.begin(async (t) => {
    const [ins] = await t`INSERT INTO line_charges (line_id, kind, amount, overdue, tx_hash)
                          VALUES (${row.id}, ${kind}, ${amount.toString()}, ${overdue.toString()}, ${tx})
                          ON CONFLICT (tx_hash) DO NOTHING RETURNING id`
    if (ins) await t`UPDATE lines SET fees_due=fees_due+${amount.toString()}, fees_charged=fees_charged+${amount.toString()}, updated_at=now() WHERE id=${row.id}`
  })
  await audit({ lineId: row.id, actor: 'servicer', action: kind === 'late_fee' ? 'fee.late' : 'fee.penalty', detail: { amount, overdue }, txHash: tx })
  return amount
}

/** A bill was just missed: one late fee, and start the penalty clock (first penalty one period from now). */
export async function onMissed(row: any, overdue: bigint) {
  await sql`UPDATE lines SET last_penalty_at=COALESCE(last_penalty_at, now()) WHERE id=${row.id}`
  // a fee shield (3 on-time bills in a row) cancels this late fee; penalty interest still runs if it stays overdue
  if (await useShieldOnMiss(row.id)) return
  try {
    await charge(row, 'late_fee', overdue)
  } catch (e) {
    console.error('[charges] late fee failed', row.id, reason(e))
  }
}

/** Once per period while an amount stays overdue (grace, frozen with an overdue amount, or defaulted). */
export async function accruePenalties() {
  if (!enabled()) return
  const rows = await sql`
    SELECT * FROM lines
    WHERE amount_due > 0 AND linebook_id IS NOT NULL AND status IN ('grace','frozen','defaulted')
      AND last_penalty_at IS NOT NULL AND last_penalty_at + (period_seconds || ' seconds')::interval <= now()
    ORDER BY last_penalty_at LIMIT 50`
  for (const row of rows) {
    try {
      await charge(row, 'penalty', BigInt(row.amount_due))
      await sql`UPDATE lines SET last_penalty_at=now() WHERE id=${row.id}`
    } catch (e) {
      console.error('[charges] penalty failed', row.id, reason(e))
    }
  }
}

/** Overdue amount cleared: stop the penalty clock (fees already charged stay due until paid). */
export async function stopPenaltyClock(lineId: number | string) {
  await sql`UPDATE lines SET last_penalty_at=NULL WHERE id=${lineId}`
}

/** Splits a payment: the borrowed amount first, then fees, then whatever is left over. */
export function allocate(amount: bigint, principal: bigint, fees: bigint) {
  const p = amount < principal ? amount : principal
  const rest = amount - p
  const f = rest < fees ? rest : fees
  return { principal: p, fees: f, leftover: rest - f }
}

/** Book fees that were paid (the money already moved in `txHash`). */
export async function feesPaid(row: any, amount: bigint, txHash: Hex | string | null) {
  if (amount <= 0n) return
  await sql`UPDATE lines SET fees_due=GREATEST(fees_due-${amount.toString()}, 0), fees_paid=fees_paid+${amount.toString()}, updated_at=now() WHERE id=${row.id}`
  await audit({ lineId: row.id, actor: 'servicer', action: 'fee.paid', detail: { amount }, txHash: txHash ?? undefined })
  if (enabled() && row.linebook_id && txHash) {
    termsWrite('recordFeesRepaid', [BigInt(row.linebook_id), txHash, amount]).catch((e) => console.error('[charges] recordFeesRepaid failed', reason(e)))
  }
}
