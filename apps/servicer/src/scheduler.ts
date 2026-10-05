import type { Address } from 'viem'
import { Account } from 'viem/tempo'
import { env, tiers } from './config'
import { lineBookWrite, registryWrite, remainingLimit, tokenBalance, treasury, getKey } from './chain'
import { audit, sql } from './db'
import { applyLimits, freezeLine, moveOnce, setSpendLimit } from './lines'
import { open } from './vault'
import { accruePenalties, allocate, feesPaid, onMissed, stopPenaltyClock } from './charges'
import { seizeCollateralOnDefault } from './collateral'
import { applyExternalRepayments } from './repay'
import { withLine } from './linelock'
import { completeRecoveries } from './recovery'

/**
 * Line economics (0% if you pay on time; a missed bill is priced by CreditTerms, see charges.ts):
 *   - The credit account is funded to `credit_limit`. Its balance IS the available credit, so exposure
 *     can never exceed the limit regardless of the spend key's periodic allowance.
 *   - owed = credit_limit - balance(creditAccount)
 *   - Each period a statement is cut: amount_due = owed. The mandate pulls min(due, mandate remaining,
 *     income balance) to the treasury, and the treasury tops the credit account back up by the same amount.
 *   - Short -> grace: ALL spending keys are blocked on-chain (phone + physical card).
 *   - Grace expired -> guarantor pull (capped by the guarantee key) -> otherwise default.
 *   - A line frozen because the borrower revoked the mandate still owes: it follows the same
 *     due -> grace -> guarantor -> default path (status stays 'frozen' until default).
 *   - Recovery: pay now (lifecycle.ts), renew the mandate (lifecycle.ts), settle after default (lifecycle.ts).
 */

const now = () => new Date()

export async function repayFromBorrower(row: any, amount: bigint, seq: number) {
  const borrower = row.borrower_wallet as Address
  const k = await getKey(borrower, row.repay_key_id)
  if (!k.exists || k.revoked) return { pulled: 0n, reason: 'auto-debit is not active' }
  const [bal, lim] = await Promise.all([tokenBalance(borrower), remainingLimit(borrower, row.repay_key_id)])
  let pull = amount
  if (lim.remaining < pull) pull = lim.remaining
  if (bal < pull) pull = bal
  if (pull <= 0n) return { pulled: 0n, reason: bal === 0n ? 'wallet is empty' : 'auto-debit limit used this period' }
  const repayKey = Account.fromSecp256k1(open(row.repay_key_enc), { access: borrower })
  const r = await moveOnce({ lineId: Number(row.id), kind: 'INST', seq, from: repayKey, to: treasury.address, amount: pull, memoKind: 'INST' })
  if (r.status !== 'confirmed') return { pulled: 0n, reason: r.error ?? 'pull failed' }
  return { pulled: pull, txHash: r.txHash! }
}

export async function topUp(row: any, amount: bigint, seq: number) {
  if (amount <= 0n) return
  const r = await moveOnce({ lineId: Number(row.id), kind: 'TOPUP', seq, from: treasury, to: row.credit_account, amount, memoKind: 'FUND' })
  if (r.status !== 'confirmed') throw new Error(`top-up failed: ${r.error}`)
  // Repaid credit must be spendable again now, not when the card key's period rolls over: re-applying the
  // limit refills the key's per-period allowance on-chain (verified on testnet: 17.50 → 20.00 remaining).
  if (row.status === 'active') {
    await applyLimits(row, 'normal').catch((e) => console.error('[topup] allowance refill failed (repayment still counted):', e?.message))
  }
}

/** Tiers apply to the unsecured part of the line; collateral-backed limit sits on top of it. */
async function maybeUpgrade(row: any, onTimeCount: number) {
  if (onTimeCount === 0 || onTimeCount % env.ON_TIME_TO_UPGRADE !== 0) return
  const secured = BigInt(row.secured ?? 0)
  const current = BigInt(row.credit_limit) - secured
  const next = tiers.find((t) => t > current)
  if (!next || next + secured > BigInt(row.mandate_cap)) return
  const newLimit = next + secured
  await sql`UPDATE lines SET credit_limit=${newLimit.toString()}, updated_at=now() WHERE id=${row.id}`
  await topUp({ ...row, credit_limit: newLimit.toString() }, next - current, 500_000 + onTimeCount)
  await setSpendLimit(row, newLimit)
  await lineBookWrite('recordLimitChange', [BigInt(row.linebook_id), newLimit])
  await audit({ lineId: row.id, actor: 'servicer', action: 'line.limit_raised', detail: { from: current + secured, to: newLimit } })
}

const owedOf = async (row: any) => {
  const limit = BigInt(row.credit_limit)
  const available = await tokenBalance(row.credit_account)
  return limit > available ? limit - available : 0n
}

/** Statement date reached for an ACTIVE line. */
async function runStatement(row: any) {
  const owed = await owedOf(row)
  const seq = row.statement_seq + 1
  const nextDue = new Date(new Date(row.next_due).getTime() + row.period_seconds * 1000)

  const fees = BigInt(row.fees_due ?? 0)
  if (owed === 0n && fees === 0n) {
    await sql`UPDATE lines SET statement_seq=${seq}, amount_due=0, next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
    return
  }
  const r = await repayFromBorrower(row, owed + fees, seq)
  const paid = allocate(r.pulled, owed, fees)
  if (paid.principal > 0n) await topUp(row, paid.principal, seq)
  if (paid.fees > 0n) await feesPaid(row, paid.fees, r.txHash ?? null)
  const remaining = owed - paid.principal

  if (owed === 0n) {
    // only earlier fees were outstanding: collected what we could, nothing new was missed
    await sql`UPDATE lines SET statement_seq=${seq}, amount_due=0, next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
    return
  }
  if (remaining === 0n) {
    const onTime = row.on_time_count + 1
    await lineBookWrite('recordRepayment', [BigInt(row.linebook_id), r.txHash!, r.pulled, true])
    await sql`UPDATE lines SET statement_seq=${seq}, amount_due=0, on_time_count=${onTime}, next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
    await audit({ lineId: row.id, actor: 'servicer', action: 'repaid.on_time', detail: { amount: r.pulled, seq }, txHash: r.txHash })
    const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
    await maybeUpgrade(fresh, onTime)
    return
  }
  if (r.pulled > 0n) await lineBookWrite('recordRepayment', [BigInt(row.linebook_id), r.txHash!, r.pulled, false])
  await lineBookWrite('recordMissed', [BigInt(row.linebook_id)])
  const graceUntil = new Date(Date.now() + env.GRACE_SECONDS * 1000)
  await sql`
    UPDATE lines SET status='grace', statement_seq=${seq}, amount_due=${remaining.toString()}, grace_until=${graceUntil},
      missed_count=missed_count+1, next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  await applyLimits(fresh, 'blocked') // no new spending while overdue (phone AND physical card)
  await audit({ lineId: row.id, actor: 'servicer', action: 'repayment.short', detail: { owed, pulled: r.pulled, remaining, reason: r.reason } })
  await onMissed(fresh, remaining)
}

/** Statement date reached for a FROZEN line: a frozen line still owes what it spent. */
async function runFrozenStatement(row: any) {
  const nextDue = new Date(new Date(row.next_due).getTime() + row.period_seconds * 1000)
  const owed = await owedOf(row)
  if (owed === 0n || row.grace_until) {
    await sql`UPDATE lines SET next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
    return
  }
  const seq = row.statement_seq + 1
  const fees = BigInt(row.fees_due ?? 0)
  const r = await repayFromBorrower(row, owed + fees, seq) // works if the mandate was renewed while frozen
  const paid = allocate(r.pulled, owed, fees)
  if (r.pulled > 0n) {
    if (paid.principal > 0n) await topUp(row, paid.principal, seq)
    if (paid.fees > 0n) await feesPaid(row, paid.fees, r.txHash ?? null)
    await lineBookWrite('recordRepayment', [BigInt(row.linebook_id), r.txHash!, r.pulled, false])
  }
  const remaining = owed - paid.principal
  if (remaining === 0n) {
    await sql`UPDATE lines SET statement_seq=${seq}, amount_due=0, next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
    return
  }
  await lineBookWrite('recordMissed', [BigInt(row.linebook_id)])
  const graceUntil = new Date(Date.now() + env.GRACE_SECONDS * 1000)
  await sql`
    UPDATE lines SET statement_seq=${seq}, amount_due=${remaining.toString()}, grace_until=${graceUntil},
      missed_count=missed_count+1, next_due=${nextDue}, updated_at=now() WHERE id=${row.id}`
  await audit({ lineId: row.id, actor: 'servicer', action: 'repayment.short', detail: { owed, pulled: r.pulled, remaining, reason: r.reason, frozen: true } })
  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  await onMissed(fresh, remaining)
}

/** Default: record it, block every key, revoke the identity attestation (chain AND db), sweep unused credit. */
export async function defaultLine(fresh: any, unpaid: bigint) {
  await applyLimits(fresh, 'blocked')
  await lineBookWrite('recordDefault', [BigInt(fresh.linebook_id)])
  try {
    await registryWrite('revokeAttestation', [fresh.borrower_wallet])
  } catch (e) {
    console.error('revokeAttestation failed', e)
  }
  await sql`UPDATE attestations SET expires_at=now() WHERE wallet=${fresh.borrower_wallet}`
  const left = await tokenBalance(fresh.credit_account)
  if (left > 0n) {
    const creditRoot = Account.fromSecp256k1(open(fresh.credit_root_enc))
    await moveOnce({ lineId: Number(fresh.id), kind: 'TOPUP', seq: 900_000, from: creditRoot, to: treasury.address, amount: left, memoKind: 'REFUND' })
  }
  await sql`UPDATE lines SET status='defaulted', amount_due=${unpaid.toString()}, grace_until=NULL, updated_at=now() WHERE id=${fresh.id}`
  await audit({ lineId: fresh.id, actor: 'servicer', action: 'line.defaulted', detail: { unpaid } })
  // a secured line: the vault releases locked collateral to cover what's owed (only possible once LineBook says Defaulted)
  await seizeCollateralOnDefault(fresh.id).catch((e) => console.error('[default] collateral seize failed', fresh.id, e?.shortMessage ?? e?.message ?? e))
}

/** Line overdue (status 'grace', or 'frozen' with an amount due): retry borrower; after grace, guarantor; else default. */
async function runGrace(row: any) {
  let due = BigInt(row.amount_due)
  const fees = BigInt(row.fees_due ?? 0)
  const seq = 10_000 + row.statement_seq * 100 + Math.floor((Date.now() / 1000) % 100) // unique retry memos
  const r = await repayFromBorrower(row, due + fees, seq)
  if (r.pulled > 0n) {
    const paid = allocate(r.pulled, due, fees)
    if (paid.principal > 0n) await topUp(row, paid.principal, seq)
    if (paid.fees > 0n) await feesPaid(row, paid.fees, r.txHash ?? null)
    await lineBookWrite('recordRepayment', [BigInt(row.linebook_id), r.txHash!, r.pulled, false])
    due -= paid.principal
    await sql`UPDATE lines SET amount_due=${due.toString()}, updated_at=now() WHERE id=${row.id}`
  }
  if (due === 0n) {
    await cureOverdue(row)
    return
  }
  if (new Date(row.grace_until) > now()) return

  // grace over: guarantor (covers the borrowed amount only, never fees)
  if (row.guarantor_wallet && row.guar_key_id && BigInt(row.guaranteed) > 0n) {
    const g = row.guarantor_wallet as Address
    const [bal, lim] = await Promise.all([tokenBalance(g), remainingLimit(g, row.guar_key_id)])
    let pull = due
    for (const cap of [BigInt(row.guaranteed), lim.remaining, bal]) if (cap < pull) pull = cap
    if (pull > 0n) {
      const guarKey = Account.fromSecp256k1(open(row.guar_key_enc), { access: g })
      const m = await moveOnce({ lineId: Number(row.id), kind: 'GUAR', seq: row.statement_seq, from: guarKey, to: treasury.address, amount: pull, memoKind: 'GUAR' })
      if (m.status === 'confirmed') {
        await lineBookWrite('recordGuarantorPull', [BigInt(row.linebook_id), m.txHash!, pull])
        due -= pull
        await sql`UPDATE lines SET amount_due=${due.toString()}, guaranteed=guaranteed-${pull.toString()}, updated_at=now() WHERE id=${row.id}`
        await audit({ lineId: row.id, actor: 'servicer', action: 'guarantor.pulled', detail: { amount: pull }, txHash: m.txHash })
      }
    }
  }

  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  if (due === 0n) {
    // covered by family: the borrower's card stays frozen (they now owe their guarantor, not KEYKARD)
    await sql`UPDATE lines SET grace_until=NULL WHERE id=${row.id}`
    if (fresh.status !== 'frozen') await freezeLine(fresh, 'MissedPayment')
    return
  }
  await defaultLine(fresh, due)
}

/** Overdue amount fully repaid: grace -> active (spending restored); frozen -> stays frozen, overdue cleared. */
export async function cureOverdue(row: any) {
  await stopPenaltyClock(row.id)
  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  if (fresh.status === 'grace') {
    await sql`UPDATE lines SET status='active', amount_due=0, grace_until=NULL, updated_at=now() WHERE id=${row.id}`
    await applyLimits({ ...fresh, status: 'active' }, 'normal')
    await audit({ lineId: row.id, actor: 'servicer', action: 'grace.cured' })
  } else if (fresh.status === 'frozen') {
    await sql`UPDATE lines SET amount_due=0, grace_until=NULL, updated_at=now() WHERE id=${row.id}`
    await audit({ lineId: row.id, actor: 'servicer', action: 'overdue.cured', detail: { frozen: true } })
  }
}

let running = false
export async function tick() {
  if (running) return
  running = true
  try {
    const due = await sql`SELECT id FROM lines WHERE status='active' AND next_due <= now() ORDER BY next_due LIMIT 50`
    for (const { id } of due) {
      const row = { id }
      try {
        await withLine(id, async () => {
          const [fresh] = await sql`SELECT * FROM lines WHERE id=${id}`
          if (fresh?.status === 'active' && new Date(fresh.next_due) <= new Date()) await runStatement(fresh)
        })
      } catch (e) {
        console.error('statement failed', row.id, e)
        await audit({ lineId: row.id, actor: 'servicer', action: 'statement.error', detail: { error: String(e) } })
      }
    }
    const frozenDue = await sql`SELECT id FROM lines WHERE status='frozen' AND next_due <= now() ORDER BY next_due LIMIT 50`
    for (const { id } of frozenDue) {
      try {
        await withLine(id, async () => {
          const [fresh] = await sql`SELECT * FROM lines WHERE id=${id}`
          if (fresh?.status === 'frozen' && new Date(fresh.next_due) <= new Date()) await runFrozenStatement(fresh)
        })
      } catch (e) {
        console.error('frozen statement failed', id, e)
      }
    }
    await applyExternalRepayments().catch((e) => console.error('external repayments failed', e))
    await accruePenalties().catch((e) => console.error('penalties failed', e))
    await completeRecoveries().catch((e) => console.error('recoveries failed', e))
    const overdue = await sql`
      SELECT id FROM lines WHERE status='grace' OR (status='frozen' AND grace_until IS NOT NULL AND amount_due > 0)
      ORDER BY grace_until LIMIT 50`
    for (const { id } of overdue) {
      const row = { id }
      try {
        await withLine(id, async () => {
          const [fresh] = await sql`SELECT * FROM lines WHERE id=${id}`
          const stillOverdue = fresh && (fresh.status === 'grace' || (fresh.status === 'frozen' && fresh.grace_until && BigInt(fresh.amount_due) > 0n))
          if (stillOverdue) await runGrace(fresh)
        })
      } catch (e) {
        console.error('grace failed', row.id, e)
        await audit({ lineId: row.id, actor: 'servicer', action: 'grace.error', detail: { error: String(e) } })
      }
    }
  } finally {
    running = false
  }
}

export function startScheduler(intervalMs = 20_000) {
  const t = setInterval(() => void tick(), intervalMs)
  void tick()
  return () => clearInterval(t)
}
