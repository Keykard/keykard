import type { Address, Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account } from 'viem/tempo'
import { BORROWER_FLAGS, mandateKeyPolicy } from '@keycard/sdk'
import { net } from './config'
import { lineBookWrite, registryWrite, tokenBalance, treasury } from './chain'
import { audit, sql } from './db'
import { UserError, applyLimits, lineView } from './lines'
import { acceptGrant } from './keyauth'
import { cureOverdue, repayFromBorrower, topUp } from './scheduler'
import { seal } from './vault'
import { allocate, feesPaid, stopPenaltyClock } from './charges'
import { withLine } from './linelock'

/**
 * Recovery paths a real borrower needs:
 *   payNow         — repay what is owed right now (still capped by the on-chain mandate). Cures grace; settles a default.
 *   renewMandate   — re-grant the auto-debit after revoking it (a revoked keyId can never be reused, so a new key).
 *   settle         — a defaulted line repaid in full becomes 'settled': identity re-attested, a new line may be opened.
 */
const lower = (a: string) => a.toLowerCase() as Address

async function latestLine(wallet: Address) {
  const [row] = await sql`SELECT * FROM lines WHERE borrower_wallet=${lower(wallet)} AND status <> 'preparing'
                          ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new UserError('no credit line', 404)
  return row
}

async function owedNow(row: any) {
  if (row.status === 'defaulted') return BigInt(row.amount_due)
  const limit = BigInt(row.credit_limit)
  const available = await tokenBalance(row.credit_account)
  const owed = limit > available ? limit - available : 0n
  return owed > BigInt(row.amount_due) ? owed : BigInt(row.amount_due)
}

export async function payNow(wallet: Address) {
  const { id } = await latestLine(wallet)
  return withLine(id, () => payNowLocked(wallet))
}

async function payNowLocked(wallet: Address) {
  const row = await latestLine(wallet) // re-read inside the lock: the scheduler may have just collected
  if (row.status === 'settled' || row.status === 'closed') throw new UserError('nothing to pay')
  const owed = await owedNow(row)
  const fees = BigInt(row.fees_due ?? 0)
  if (owed === 0n && fees === 0n) throw new UserError('you owe nothing right now')
  const seq = 20_000_000 + Math.floor(Date.now() / 1000) % 10_000_000
  const r = await repayFromBorrower(row, owed + fees, seq)
  if (r.pulled === 0n) {
    const why = r.reason === 'auto-debit is not active' ? 're-enable your auto-debit first, then pay' : r.reason === 'wallet is empty' ? 'add money to your KEYKARD wallet first' : r.reason
    throw new UserError(`could not collect: ${why}`)
  }
  await lineBookWrite('recordRepayment', [BigInt(row.linebook_id), r.txHash!, r.pulled, false])
  await audit({ lineId: row.id, actor: 'borrower', action: 'repaid.manual', detail: { amount: r.pulled, owed, fees }, txHash: r.txHash })
  const paid = allocate(r.pulled, owed, fees) // the borrowed amount first, then fees
  if (paid.fees > 0n) await feesPaid(row, paid.fees, r.txHash!)

  if (row.status === 'defaulted') {
    const left = BigInt(row.amount_due) - paid.principal
    await sql`UPDATE lines SET amount_due=${left.toString()}, updated_at=now() WHERE id=${row.id}`
    if (left === 0n) await stopPenaltyClock(row.id)
    await maybeSettle(row.id)
    return lineView(row.id)
  }
  // restore the credit that was repaid
  if (paid.principal > 0n) await topUp(row, paid.principal, seq)
  const due = BigInt(row.amount_due)
  if (due > 0n) {
    const leftDue = due > paid.principal ? due - paid.principal : 0n
    await sql`UPDATE lines SET amount_due=${leftDue.toString()}, updated_at=now() WHERE id=${row.id}`
    if (leftDue === 0n) await cureOverdue(row)
  }
  return lineView(row.id)
}

/** A defaulted line settles once both the borrowed amount and the fees are paid. */
export async function maybeSettle(lineId: number | string) {
  const [row] = await sql`SELECT * FROM lines WHERE id=${lineId}`
  if (row?.status === 'defaulted' && BigInt(row.amount_due) === 0n && BigInt(row.fees_due) === 0n) await settle(row)
}

/** A defaulted line repaid in full: record it, re-attest the identity (same nullifier), allow a new line. */
async function settle(row: any) {
  const [att] = await sql`SELECT * FROM attestations WHERE wallet=${row.borrower_wallet}`
  const expiresAt = new Date(Date.now() + 365 * 86400_000)
  if (att) {
    try {
      await registryWrite('attest', [row.borrower_wallet, att.nullifier_hash, att.flags || BORROWER_FLAGS, BigInt(Math.floor(expiresAt.getTime() / 1000))])
      await sql`UPDATE attestations SET expires_at=${expiresAt} WHERE wallet=${row.borrower_wallet}`
    } catch (e) {
      console.error('re-attest after settlement failed', e)
    }
  }
  await sql`UPDATE lines SET status='settled', amount_due=0, settled_at=now(), updated_at=now() WHERE id=${row.id}`
  await audit({ lineId: row.id, actor: 'servicer', action: 'line.settled_after_default' })
}

/** Step 1 of re-enabling the auto-debit: a fresh mandate key (revoked keyIds can never be re-authorised). */
export async function renewMandate(wallet: Address) {
  const row = await latestLine(wallet)
  if (!['active', 'grace', 'frozen', 'defaulted'].includes(row.status)) throw new UserError('no line to re-enable')
  return { lineId: Number(row.id), mandate: await pendingMandate(row, wallet, BigInt(row.mandate_cap)) }
}

/** What the borrower signs for a (new) auto-pay key: capped per period, payable only to KEYKARD. */
export function mandateTerms(row: any, keyId: Address, cap: bigint) {
  const expiry = Math.floor(new Date(row.term_end).getTime() / 1000)
  const policy = mandateKeyPolicy({ token: net.token, instalment: cap, period: row.period_seconds, repayTo: treasury.address, expiry })
  return {
    keyId,
    keyType: 'secp256k1' as const,
    token: net.token,
    cap: cap.toString(),
    periodSeconds: row.period_seconds,
    recipient: treasury.address,
    expiry,
    policy: JSON.parse(JSON.stringify(policy, (_, v) => (typeof v === 'bigint' ? v.toString() : v))),
  }
}

/** A fresh auto-pay key waiting for the borrower's signature (a revoked keyId can never be re-authorised). */
export async function pendingMandate(row: any, wallet: Address, cap: bigint) {
  const pk = generatePrivateKey()
  const keyId = lower(Account.fromSecp256k1(pk, { access: lower(wallet) }).accessKeyAddress)
  await sql`UPDATE lines SET pending_repay_key_id=${keyId}, pending_repay_key_enc=${seal(pk)},
            pending_mandate_cap=${cap.toString()}, updated_at=now() WHERE id=${row.id}`
  return mandateTerms(row, keyId, cap)
}

/** Verify the signed permission matches the pending terms exactly, activate it, and make it the line's auto-pay. */
export async function activatePendingMandate(row: any, wallet: Address, keyAuthorization?: Hex) {
  if (!row.pending_repay_key_id) throw new UserError('start re-enabling first')
  const cap = BigInt(row.pending_mandate_cap ?? row.mandate_cap)
  const tx = await acceptGrant({
    owner: lower(wallet),
    keyId: row.pending_repay_key_id,
    sealedKey: row.pending_repay_key_enc,
    keyAuthorization,
    expect: { expiry: Math.floor(new Date(row.term_end).getTime() / 1000), limit: cap, period: row.period_seconds, recipients: [treasury.address] },
  })
  await sql`UPDATE lines SET repay_key_id=pending_repay_key_id, repay_key_enc=pending_repay_key_enc, mandate_cap=${cap.toString()},
            pending_repay_key_id=NULL, pending_repay_key_enc=NULL, pending_mandate_cap=NULL, updated_at=now() WHERE id=${row.id}`
  await audit({ lineId: row.id, actor: 'borrower', action: 'mandate.renewed', detail: { cap }, txHash: tx })
  return tx
}

/** Step 2: verify the signed permission, activate it, and unfreeze the card if the only problem was the mandate. */
export async function confirmRenewMandate(wallet: Address, keyAuthorization?: Hex) {
  const row = await latestLine(wallet)
  await activatePendingMandate(row, wallet, keyAuthorization)

  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  if (fresh.status === 'frozen' && fresh.freeze_reason === 'MandateRevoked' && BigInt(fresh.amount_due) === 0n) {
    await lineBookWrite('recordUnfreeze', [BigInt(fresh.linebook_id)])
    await sql`UPDATE lines SET status='active', freeze_reason=NULL, updated_at=now() WHERE id=${row.id}`
    await applyLimits({ ...fresh, status: 'active' }, 'normal')
    await audit({ lineId: row.id, actor: 'servicer', action: 'line.unfrozen', detail: { reason: 'mandate renewed' } })
  }
  return lineView(row.id)
}

/** Frozen by a revoked mandate but debt now cleared and mandate renewed: unfreeze. Called after payNow. */
export async function maybeUnfreeze(wallet: Address) {
  const row = await latestLine(wallet)
  if (row.status !== 'frozen' || row.freeze_reason !== 'MandateRevoked' || BigInt(row.amount_due) !== 0n) return
  const v = await lineView(row.id)
  if (!v?.mandateActive) return
  await lineBookWrite('recordUnfreeze', [BigInt(row.linebook_id)])
  await sql`UPDATE lines SET status='active', freeze_reason=NULL, grace_until=NULL, updated_at=now() WHERE id=${row.id}`
  await applyLimits({ ...row, status: 'active' }, 'normal')
  await audit({ lineId: row.id, actor: 'servicer', action: 'line.unfrozen', detail: { reason: 'debt cleared' } })
}
