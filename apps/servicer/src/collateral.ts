import type { Address, Hex } from 'viem'
import { Account } from 'viem/tempo'
import { env, net, tiers } from './config'
import { lineBookWrite, tokenBalance, treasury, vaultRead, vaultWrite } from './chain'
import { audit, sql } from './db'
import { UserError, applyLimits, lineView, moveOnce } from './lines'
import { allocate, feesPaid, stopPenaltyClock } from './charges'
import { activatePendingMandate, maybeSettle, pendingMandate } from './lifecycle'
import { topUp } from './scheduler'
import { open } from './vault'
import { withLine } from './linelock'

/**
 * Secured lines, 1:1. The borrower deposits stablecoins into the CollateralVault (their own transaction:
 * approve + deposit, batched), and KEYKARD raises the limit by the same amount and locks that deposit.
 *   - Locked collateral can't be withdrawn while it backs the line; the rest can, any time.
 *   - Lowering the secured limit (after paying down) releases the same amount, which the borrower withdraws.
 *   - KEYKARD can take collateral ONLY after the line is Defaulted on LineBook (the vault checks), and never
 *     more than is locked. Whatever it doesn't need is released straight back to the borrower.
 * The unsecured tiers ($20 → $50 → $100) keep growing on top with on-time payments.
 */
const lower = (a: string) => a.toLowerCase() as Address
/** LineBook is the public record; a failed record write must not undo a money movement that already happened. */
const record = (fn: string, args: readonly unknown[]) =>
  lineBookWrite(fn, args).catch((e) => console.error(`[collateral] LineBook.${fn} failed`, e?.shortMessage ?? e?.message ?? e))
const enabled = () => Boolean(net.collateralVault)
/** Largest auto-pay cap a line ever needs: the top unsecured tier plus the most collateral one borrower can lock. */
export const fullMandateCap = () => tiers[tiers.length - 1] + env.MAX_SECURED

async function liveLine(wallet: Address) {
  const [row] = await sql`SELECT * FROM lines WHERE borrower_wallet=${lower(wallet)} AND status IN ('active','grace','frozen')
                          ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new UserError('open your KEYKARD line first', 404)
  return row
}

export async function collateralView(wallet: Address) {
  if (!enabled()) return null
  const [deposited, locked] = await Promise.all([vaultRead<bigint>('deposited', [lower(wallet)]), vaultRead<bigint>('locked', [lower(wallet)])])
  return { vault: net.collateralVault!, deposited: deposited.toString(), locked: locked.toString(), available: (deposited - locked).toString(), max: env.MAX_SECURED.toString() }
}

/** Step 1: what to deposit, and (only if the line's auto-pay cap is too small for the new limit) a bigger auto-pay to sign. */
export async function prepareCollateral(wallet: Address, amount: bigint) {
  if (!enabled()) throw new UserError('secured lines are not available yet', 503)
  const row = await liveLine(wallet)
  if (row.status !== 'active') throw new UserError('your card must be active to add collateral')
  if (amount < 1_000_000n) throw new UserError('add at least $1')
  const secured = BigInt(row.secured)
  if (secured + amount > env.MAX_SECURED) throw new UserError(`the most collateral per person is ${Number(env.MAX_SECURED) / 1e6} USD`)
  const newLimit = BigInt(row.credit_limit) + amount
  const mandate = newLimit > BigInt(row.mandate_cap) ? await pendingMandate(row, wallet, fullMandateCap()) : null
  return { vault: net.collateralVault!, token: net.token, amount: amount.toString(), newLimit: newLimit.toString(), mandate }
}

/** Step 2: after the deposit landed (and the bigger auto-pay was signed, if asked): lock it and raise the limit. */
export async function confirmCollateral(wallet: Address, amount: bigint, keyAuthorization?: Hex) {
  if (!enabled()) throw new UserError('secured lines are not available yet', 503)
  const { id } = await liveLine(wallet)
  return withLine(id, () => confirmLocked(wallet, amount, keyAuthorization))
}

async function confirmLocked(wallet: Address, amount: bigint, keyAuthorization?: Hex) {
  let row = await liveLine(wallet)
  if (row.status !== 'active') throw new UserError('your card must be active to add collateral')
  const newLimit = BigInt(row.credit_limit) + amount
  if (newLimit > BigInt(row.mandate_cap)) {
    if (!row.pending_repay_key_id) throw new UserError('sign the new auto-pay limit first')
    await activatePendingMandate(row, wallet, keyAuthorization) // or already self-submitted by an admin key
    ;[row] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  }
  if (BigInt(row.secured) + amount > env.MAX_SECURED) throw new UserError('over the collateral limit')
  // a previous attempt may have locked on-chain but not finished: don't lock twice
  const [locked, available] = await Promise.all([vaultRead<bigint>('locked', [lower(wallet)]), vaultRead<bigint>('available', [lower(wallet)])])
  let lockTx: Hex | null = null
  if (locked - BigInt(row.secured) < amount) {
    if (available < amount) throw new UserError('we can’t see your deposit in the vault yet: try again in a few seconds')
    lockTx = (await vaultWrite('lock', [lower(wallet), amount])).transactionHash
  }
  await sql`UPDATE lines SET credit_limit=credit_limit+${amount.toString()}, secured=secured+${amount.toString()}, updated_at=now() WHERE id=${row.id}`
  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  await topUp(fresh, amount, 40_000_000 + (Math.floor(Date.now() / 1000) % 10_000_000)) // fund the extra limit + refill the card key
  await record('recordLimitChange', [BigInt(row.linebook_id), BigInt(fresh.credit_limit)])
  await audit({ lineId: row.id, actor: 'borrower', action: 'collateral.locked', detail: { amount, limit: fresh.credit_limit }, txHash: lockTx })
  return lineView(row.id)
}

/** Lower the secured part of the limit; the released collateral can then be withdrawn from the vault by the borrower. */
export async function releaseCollateral(wallet: Address, amount: bigint) {
  if (!enabled()) throw new UserError('secured lines are not available yet', 503)
  const { id } = await liveLine(wallet)
  return withLine(id, () => releaseLocked(wallet, amount))
}

async function releaseLocked(wallet: Address, amount: bigint) {
  const row = await liveLine(wallet)
  if (row.status !== 'active') throw new UserError('pay what’s overdue first; collateral stays locked while a bill is late')
  // the Earn-backed part of the secured limit is unlocked separately (earncollateral.ts)
  const plain = BigInt(row.secured) - BigInt(row.secured_earn ?? 0)
  if (amount <= 0n || amount > plain) throw new UserError('that’s more than your collateral')
  const limit = BigInt(row.credit_limit)
  const available = await tokenBalance(row.credit_account)
  const owed = limit > available ? limit - available : 0n
  const newLimit = limit - amount
  if (owed > newLimit) throw new UserError(`repay ${Number(owed - newLimit) / 1e6} USD first, so your balance fits the lower limit`)

  const creditRoot = Account.fromSecp256k1(open(row.credit_root_enc))
  const seq = 700_000 + (Math.floor(Date.now() / 1000) % 100_000)
  const swept = await moveOnce({ lineId: Number(row.id), kind: 'REFUND', seq, from: creditRoot, to: treasury.address, amount, memoKind: 'REFUND' })
  if (swept.status !== 'confirmed') throw new UserError(`could not lower the limit: ${swept.error}`, 502)
  await sql`UPDATE lines SET credit_limit=${newLimit.toString()}, secured=secured-${amount.toString()}, updated_at=now() WHERE id=${row.id}`
  await applyLimits({ ...row, credit_limit: newLimit.toString() }, 'normal')
  const tx = (await vaultWrite('release', [lower(wallet), amount])).transactionHash
  await record('recordLimitChange', [BigInt(row.linebook_id), newLimit])
  await audit({ lineId: row.id, actor: 'borrower', action: 'collateral.released', detail: { amount, limit: newLimit }, txHash: tx })
  return lineView(row.id)
}

/** Called right after a line is recorded as Defaulted: cover what's owed from locked collateral, release the rest. */
export async function seizeCollateralOnDefault(lineId: number | string) {
  if (!enabled()) return
  const [row] = await sql`SELECT * FROM lines WHERE id=${lineId}`
  if (!row || row.status !== 'defaulted') return
  const borrower = lower(row.borrower_wallet)
  const locked = await vaultRead<bigint>('locked', [borrower])
  if (locked === 0n) return
  const principal = BigInt(row.amount_due)
  const fees = BigInt(row.fees_due)
  const owed = principal + fees
  const take = owed < locked ? owed : locked
  if (take > 0n) {
    const receipt = await vaultWrite('seize', [BigInt(row.linebook_id), take, treasury.address])
    const tx = receipt.transactionHash
    await sql`INSERT INTO movements (line_id, kind, seq, memo, amount, from_addr, to_addr, tx_hash, status)
              VALUES (${row.id}, 'SEIZE', 0, ${'SEIZE:' + tx}, ${take.toString()}, ${lower(net.collateralVault!)}, ${lower(treasury.address)}, ${tx}, 'confirmed')
              ON CONFLICT (memo) DO NOTHING`
    const paid = allocate(take, principal, fees)
    await sql`UPDATE lines SET amount_due=${(principal - paid.principal).toString()}, updated_at=now() WHERE id=${row.id}`
    if (paid.fees > 0n) await feesPaid(row, paid.fees, tx)
    await record('recordRepayment', [BigInt(row.linebook_id), tx, take, false])
    if (principal - paid.principal === 0n) await stopPenaltyClock(row.id)
    await audit({ lineId: row.id, actor: 'servicer', action: 'collateral.seized', detail: { amount: take, owed }, txHash: tx })
  }
  const rest = locked - take
  if (rest > 0n) {
    const r = await vaultWrite('release', [borrower, rest])
    await audit({ lineId: row.id, actor: 'servicer', action: 'collateral.released', detail: { amount: rest, reason: 'not needed after default' }, txHash: r.transactionHash })
  }
  // the Earn part is settled by seizeEarnOnDefault, which runs right after this
  await sql`UPDATE lines SET secured=secured_earn, updated_at=now() WHERE id=${row.id}`
  await maybeSettle(row.id)
}
