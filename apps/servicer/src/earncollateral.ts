import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { Abis, Account } from 'viem/tempo'
import { collateralVaultAbi } from '@keycard/sdk'
import { earn, env, net } from './config'
import {
  earnCollateralRead, earnCollateralWrite, earnShareBalance, earnValue, lineBookWrite, publicClient, tokenBalance, treasury, treasuryCalls,
} from './chain'
import { readContract } from 'viem/actions'
import { audit, sql } from './db'
import { UserError, applyLimits, lineView, moveOnce } from './lines'
import { allocate, feesPaid, stopPenaltyClock } from './charges'
import { activatePendingMandate, maybeSettle, pendingMandate } from './lifecycle'
import { fullMandateCap } from './collateral'
import { topUp } from './scheduler'
import { open } from './vault'
import { withLine } from './linelock'

/**
 * Collateral that earns. Same promise as the 1:1 secured line (collateral.ts), but the stablecoins go into a Tempo
 * Earn vault first and the Earn shares are what's locked, in a second CollateralVault:
 *   - one transaction from the borrower: approve → Earn deposit → approve shares → lock-vault deposit;
 *   - the limit grows by EARN_LTV_BPS of the shares' value: 1:1 on testnet, 95% on mainnet as a buffer against value moves;
 *   - the shares keep earning while locked, and the borrower keeps all of it when they unlock;
 *   - KEYKARD can take shares only after a default recorded on LineBook (the vault checks), only enough to cover
 *     what's owed, redeems them, and releases the rest.
 * On testnet the vault's venue is DemoYieldVenue and its yield is simulated (simulateEarnYield below).
 */
const lower = (a: string) => a.toLowerCase() as Address
const record = (fn: string, args: readonly unknown[]) =>
  lineBookWrite(fn, args).catch((e) => console.error(`[earn] LineBook.${fn} failed`, e?.shortMessage ?? e?.message ?? e))
const ltv = () => BigInt(env.EARN_LTV_BPS)
/** Slippage allowed between our quote and the vault's fill: 0.1% on redeem, 0.01% on deposit (the shares minted
 *  above the minimum stay in the borrower's wallet and are swept up by the next redeem). */
const SLIP = 10n
const DEPOSIT_SLIP = 1n
type Call = { to: Address; data: Hex }

function need() {
  if (!earn) throw new UserError('collateral that earns is not available yet', 503)
  return earn
}

async function liveLine(wallet: Address) {
  const [row] = await sql`SELECT * FROM lines WHERE borrower_wallet=${lower(wallet)} AND status IN ('active','grace','frozen')
                          ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new UserError('open your KEYKARD line first', 404)
  return row
}

/** Earn shares a deposit of `assets` should mint, from the vault's current share price. */
async function sharesFor(assets: bigint) {
  const ref = 1_000_000_000n
  const value = await earnValue(ref)
  return value === 0n ? assets : (assets * ref) / value
}

export function earnTerms() {
  if (!earn) return null
  return { vault: earn.vault, share: earn.share, collateralVault: earn.collateral, ltvBps: env.EARN_LTV_BPS, simulated: Boolean(earn.simVenue) }
}

export async function earnView(wallet: Address) {
  if (!earn) return null
  const w = lower(wallet)
  const [deposited, locked, inWallet] = await Promise.all([
    earnCollateralRead<bigint>('deposited', [w]),
    earnCollateralRead<bigint>('locked', [w]),
    earnShareBalance(w),
  ])
  const [row] = await sql`SELECT earn_principal, secured_earn FROM lines WHERE borrower_wallet=${w} ORDER BY created_at DESC LIMIT 1`
  const value = await earnValue(locked)
  const principal = BigInt(row?.earn_principal ?? 0)
  const unlocked = deposited - locked
  return {
    ...earnTerms()!,
    lockedShares: locked.toString(),
    value: value.toString(),
    principal: principal.toString(),
    earned: (value > principal ? value - principal : 0n).toString(),
    limitFromEarn: String(row?.secured_earn ?? 0),
    // released (or never locked) shares still in the lock vault, plus any in the wallet: the borrower can redeem them
    withdrawable: (await earnValue(unlocked + inWallet)).toString(),
  }
}

/** Step 1: the one transaction to sign, and (only if the auto-pay cap is too small) a bigger auto-pay to sign. */
export async function prepareEarn(wallet: Address, amount: bigint) {
  const e = need()
  const row = await liveLine(wallet)
  if (row.status !== 'active') throw new UserError('your card must be active to add collateral')
  if (amount < 1_000_000n) throw new UserError('add at least $1')
  const credit = (amount * ltv()) / 10_000n
  if (BigInt(row.secured) + credit > env.MAX_SECURED) throw new UserError(`the most collateral per person is ${Number(env.MAX_SECURED) / 1e6} USD`)
  const newLimit = BigInt(row.credit_limit) + credit
  const mandate = newLimit > BigInt(row.mandate_cap) ? await pendingMandate(row, wallet, fullMandateCap()) : null
  const minShares = ((await sharesFor(amount)) * (10_000n - DEPOSIT_SLIP)) / 10_000n
  const calls: Call[] = [
    { to: net.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [e.vault, amount] }) },
    { to: e.vault, data: encodeFunctionData({ abi: Abis.earnVault, functionName: 'deposit', args: [amount, lower(wallet), minShares] }) },
    { to: e.share, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [e.collateral, minShares] }) },
    { to: e.collateral, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [minShares] }) },
  ]
  return { amount: amount.toString(), credit: credit.toString(), newLimit: newLimit.toString(), ltvBps: env.EARN_LTV_BPS, mandate, calls }
}

/** Step 2: after the deposit landed: lock every share the borrower put in the lock vault and raise the limit. */
export async function confirmEarn(wallet: Address, keyAuthorization?: Hex) {
  need()
  const { id } = await liveLine(wallet)
  return withLine(id, () => confirmLocked(wallet, keyAuthorization))
}

async function confirmLocked(wallet: Address, keyAuthorization?: Hex) {
  let row = await liveLine(wallet)
  if (row.status !== 'active') throw new UserError('your card must be active to add collateral')
  const w = lower(wallet)
  const [locked, available] = await Promise.all([earnCollateralRead<bigint>('locked', [w]), earnCollateralRead<bigint>('available', [w])])
  // shares a previous attempt locked on-chain but never credited, plus the new deposit
  const uncredited = locked > BigInt(row.earn_shares) ? locked - BigInt(row.earn_shares) : 0n
  const shares = uncredited + available
  if (shares === 0n) throw new UserError('we can’t see your deposit in the vault yet: try again in a few seconds')
  const value = await earnValue(shares)
  let credit = (value * ltv()) / 10_000n
  const room = env.MAX_SECURED - BigInt(row.secured)
  if (credit > room) credit = room > 0n ? room : 0n
  const newLimit = BigInt(row.credit_limit) + credit
  if (newLimit > BigInt(row.mandate_cap)) {
    if (!row.pending_repay_key_id) throw new UserError('sign the new auto-pay limit first')
    await activatePendingMandate(row, wallet, keyAuthorization)
    ;[row] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  }
  const lockTx = available > 0n ? (await earnCollateralWrite('lock', [w, available])).transactionHash : null
  await sql`UPDATE lines SET credit_limit=credit_limit+${credit.toString()}, secured=secured+${credit.toString()}, secured_earn=secured_earn+${credit.toString()},
                             earn_shares=earn_shares+${shares.toString()}, earn_principal=earn_principal+${value.toString()}, updated_at=now()
            WHERE id=${row.id}`
  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  if (credit > 0n) {
    await topUp(fresh, credit, 45_000_000 + (Math.floor(Date.now() / 1000) % 5_000_000))
    await record('recordLimitChange', [BigInt(row.linebook_id), BigInt(fresh.credit_limit)])
  }
  await audit({ lineId: row.id, actor: 'borrower', action: 'earn.locked', detail: { shares, value, credit, limit: fresh.credit_limit }, txHash: lockTx })
  return lineView(row.id)
}

/** Calls that move every unlocked share (lock vault + wallet) back to stablecoins in the borrower's wallet. */
async function redeemCalls(wallet: Address): Promise<Call[]> {
  const e = need()
  const w = lower(wallet)
  const [unlocked, inWallet] = await Promise.all([earnCollateralRead<bigint>('available', [w]), earnShareBalance(w)])
  const total = unlocked + inWallet
  if (total === 0n) return []
  const minAssets = ((await earnValue(total)) * (10_000n - SLIP)) / 10_000n
  return [
    ...(unlocked > 0n ? [{ to: e.collateral, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [unlocked] }) }] : []),
    { to: e.share, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [e.vault, total] }) },
    { to: e.vault, data: encodeFunctionData({ abi: Abis.earnVault, functionName: 'redeem', args: [total, w, minAssets] }) },
  ]
}

export async function earnWithdrawCalls(wallet: Address) {
  return { calls: await redeemCalls(wallet) }
}

/** Unlock all Earn collateral: the limit drops by what it added; then the borrower signs `calls` to get it back. */
export async function releaseEarn(wallet: Address) {
  need()
  const { id } = await liveLine(wallet)
  const line = await withLine(id, () => releaseLocked(wallet))
  return { line, calls: await redeemCalls(wallet) }
}

async function releaseLocked(wallet: Address) {
  const row = await liveLine(wallet)
  if (row.status !== 'active') throw new UserError('pay what’s overdue first; collateral stays locked while a bill is late')
  const credit = BigInt(row.secured_earn)
  const shares = BigInt(row.earn_shares)
  if (shares === 0n) throw new UserError('nothing is locked')
  const limit = BigInt(row.credit_limit)
  const available = await tokenBalance(row.credit_account)
  const owed = limit > available ? limit - available : 0n
  const newLimit = limit - credit
  if (owed > newLimit) throw new UserError(`repay ${Number(owed - newLimit) / 1e6} USD first, so your balance fits the lower limit`)

  if (credit > 0n) {
    const creditRoot = Account.fromSecp256k1(open(row.credit_root_enc))
    const seq = 750_000 + (Math.floor(Date.now() / 1000) % 100_000)
    const swept = await moveOnce({ lineId: Number(row.id), kind: 'REFUND', seq, from: creditRoot, to: treasury.address, amount: credit, memoKind: 'REFUND' })
    if (swept.status !== 'confirmed') throw new UserError(`could not lower the limit: ${swept.error}`, 502)
  }
  await sql`UPDATE lines SET credit_limit=${newLimit.toString()}, secured=secured-${credit.toString()}, secured_earn=0, earn_shares=0, earn_principal=0, updated_at=now()
            WHERE id=${row.id}`
  await applyLimits({ ...row, credit_limit: newLimit.toString() }, 'normal')
  const locked = await earnCollateralRead<bigint>('locked', [lower(wallet)])
  const tx = locked > 0n ? (await earnCollateralWrite('release', [lower(wallet), locked])).transactionHash : null
  if (credit > 0n) await record('recordLimitChange', [BigInt(row.linebook_id), newLimit])
  await audit({ lineId: row.id, actor: 'borrower', action: 'earn.released', detail: { shares: locked, credit, limit: newLimit }, txHash: tx })
  return lineView(row.id)
}

/** Right after a default (and after plain collateral): take just enough Earn shares to cover what's owed, redeem them. */
export async function seizeEarnOnDefault(lineId: number | string) {
  if (!earn) return
  const [row] = await sql`SELECT * FROM lines WHERE id=${lineId}`
  // 'settled': plain collateral (or a payment) already covered everything, so every share goes back
  if (!row || !['defaulted', 'settled'].includes(row.status)) return
  const borrower = lower(row.borrower_wallet)
  const locked = await earnCollateralRead<bigint>('locked', [borrower])
  if (locked === 0n) return
  const principal = BigInt(row.amount_due)
  const fees = BigInt(row.fees_due)
  const owed = row.status === 'settled' ? 0n : principal + fees
  const value = await earnValue(locked)
  let take = 0n
  if (owed > 0n && value > 0n) {
    take = value <= owed ? locked : (owed * locked + value - 1n) / value // round up: cover the debt fully
    if (take > locked) take = locked
  }
  if (take > 0n) {
    const seize = await earnCollateralWrite('seize', [BigInt(row.linebook_id), take, treasury.address])
    const quote = await earnValue(take)
    const red = await treasuryCalls([
      { to: earn.share, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [earn.vault, take] }) },
      { to: earn.vault, data: encodeFunctionData({ abi: Abis.earnVault, functionName: 'redeem', args: [take, treasury.address, (quote * (10_000n - SLIP)) / 10_000n] }) },
    ])
    const got = quote < owed ? quote : owed
    const tx = red.transactionHash
    await sql`INSERT INTO movements (line_id, kind, seq, memo, amount, from_addr, to_addr, tx_hash, status)
              VALUES (${row.id}, 'SEIZE', 0, ${'SEIZE-EARN:' + tx}, ${got.toString()}, ${lower(earn.collateral)}, ${lower(treasury.address)}, ${tx}, 'confirmed')
              ON CONFLICT (memo) DO NOTHING`
    const paid = allocate(got, principal, fees)
    await sql`UPDATE lines SET amount_due=${(principal - paid.principal).toString()}, updated_at=now() WHERE id=${row.id}`
    if (paid.fees > 0n) await feesPaid(row, paid.fees, tx)
    await record('recordRepayment', [BigInt(row.linebook_id), tx, got, false])
    if (principal - paid.principal === 0n) await stopPenaltyClock(row.id)
    await audit({ lineId: row.id, actor: 'servicer', action: 'earn.seized', detail: { shares: take, value: quote, owed }, txHash: seize.transactionHash })
  }
  const rest = locked - take
  if (rest > 0n) {
    const r = await earnCollateralWrite('release', [borrower, rest])
    await audit({ lineId: row.id, actor: 'servicer', action: 'earn.released', detail: { shares: rest, reason: 'not needed after default' }, txHash: r.transactionHash })
  }
  await sql`UPDATE lines SET secured=0, secured_earn=0, earn_shares=0, earn_principal=0, updated_at=now() WHERE id=${row.id}`
  await maybeSettle(row.id)
}

const venueAbi = [
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'donate', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [] },
] as const
const YEAR = 365n * 24n * 3600n

/**
 * TESTNET ONLY: the demo venue has no real strategy, so KEYKARD tops it up at EARN_SIM_APR_BPS a year, at most once
 * per EARN_SIM_EVERY_SECONDS. Every top-up is a public transaction and the app labels this yield as simulated.
 */
export async function simulateEarnYield() {
  const venue = earn?.simVenue
  if (!venue || env.EARN_SIM_APR_BPS === 0 || net.name === 'mainnet') return
  const now = BigInt(Math.floor(Date.now() / 1000))
  const [c] = await sql`SELECT last_block FROM cursors WHERE name='earn_sim_yield'`
  const setCursor = () => sql`INSERT INTO cursors (name,last_block) VALUES ('earn_sim_yield',${now.toString()})
                              ON CONFLICT (name) DO UPDATE SET last_block=EXCLUDED.last_block`
  if (!c) return void (await setCursor())
  const elapsed = now - BigInt(c.last_block)
  if (elapsed < BigInt(env.EARN_SIM_EVERY_SECONDS)) return
  const assets = (await readContract(publicClient, { address: venue, abi: venueAbi, functionName: 'totalAssets' })) as bigint
  const amount = (assets * BigInt(env.EARN_SIM_APR_BPS) * elapsed) / (10_000n * YEAR)
  if (assets === 0n) return void (await setCursor())
  if (amount === 0n) return // let it accumulate
  const r = await treasuryCalls([
    { to: net.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [venue, amount] }) },
    { to: venue, data: encodeFunctionData({ abi: venueAbi, functionName: 'donate', args: [amount] }) },
  ])
  await setCursor()
  await audit({ actor: 'servicer', action: 'earn.yield_simulated', detail: { amount, venueAssets: assets, seconds: elapsed }, txHash: r.transactionHash })
}
