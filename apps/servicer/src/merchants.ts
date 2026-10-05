import { randomInt } from 'node:crypto'
import { parseAbiItem, type Address } from 'viem'
import { getBlock, getBlockNumber, getLogs } from 'viem/actions'
import { BORROWER_FLAGS, decodePayMemo, encodeMemo } from '@keycard/sdk'
import { net } from './config'
import { findMemoTransfer, publicClient, registryRead, registryWrite, settlement, sponsoredTransfer } from './chain'
import { audit, sql } from './db'
import { UserError } from './lines'
import { feeBpsFor, offerDashboard, payCashback, retryCashback, splitPayment } from './rewards'

/**
 * KEYKARD merchant network.
 *  - Anyone who is a verified, unique human (Self) can become a merchant in seconds.
 *  - Cards pay the settlement address with memo KCP:<code>:<nonce>.
 *  - This worker settles each payment to the merchant's wallet in USDC.
 *    Phase 2 (card-network partner): the same authorization settles the merchant in FIAT at any
 *    POS; only this settlement leg changes (settlement='fiat').
 *  - Self-dealing guard: a borrower (or their guarantor) paying a merchant they own is refunded.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const newCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
const lower = (a: string) => a.toLowerCase() as Address
const transferWithMemo = parseAbiItem(
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
)

export async function registerMerchant(owner: Address, label: string) {
  owner = lower(owner)
  const [u] = await sql`SELECT role FROM users WHERE wallet=${owner}`
  if (!u || u.role !== 'merchant') throw new UserError('register as a merchant first')
  if (!(await registryRead<boolean>('isEligible', [owner, BORROWER_FLAGS]))) throw new UserError('verify your identity with Self first', 403)
  const [existing] = await sql`SELECT * FROM merchants WHERE owner_wallet=${owner}`
  if (existing) return merchantView(existing)
  let row: any
  for (let i = 0; i < 5 && !row; i++) {
    ;[row] = await sql`
      INSERT INTO merchants (address, label, kind, code, owner_wallet, settle_to)
      VALUES (${owner}, ${label.slice(0, 60)}, 'merchant', ${newCode()}, ${owner}, ${owner})
      ON CONFLICT DO NOTHING RETURNING *`
  }
  if (!row) throw new UserError('could not allocate a merchant code, try again', 503)
  try {
    await registryWrite('setMerchant', [owner, true, `${row.code} ${row.label}`], 'owner')
  } catch (e) {
    console.error('registry setMerchant failed (non-fatal)', e)
  }
  await audit({ actor: 'servicer', action: 'merchant.registered', detail: { owner, code: row.code, label } })
  return merchantView(row)
}

export function merchantView(r: any) {
  return {
    code: r.code as string,
    label: r.label as string,
    owner: r.owner_wallet as Address,
    settleTo: r.settle_to as Address,
    settlement: r.settlement as string,
    feeBps: (r.fee_bps ?? null) as number | null,
  }
}

export async function getMerchant(code: string) {
  const [r] = await sql`SELECT * FROM merchants WHERE code=${code.toUpperCase()} AND active`
  if (!r) throw new UserError('merchant not found', 404)
  return merchantView(r)
}

async function settleOne(p: any) {
  const memo = encodeMemo('SETTLE', p.id, 0)
  // idempotency: a SETTLE memo is unique per payment; never settle a payment twice
  const [already] = await sql`SELECT settle_tx FROM payments WHERE id=${p.id} AND settle_tx IS NOT NULL`
  if (already) return
  const reconcile = async () => {
    const landed = await findMemoTransfer({ from: settlement.address, to: p.to, memo }).catch(() => null)
    if (landed) {
      await sql`UPDATE payments SET status=${p.status}, settle_tx=${landed.txHash}, error=NULL, settled_at=now() WHERE id=${p.id}`
      return true
    }
    return false
  }
  if (await reconcile()) return
  try {
    const tx = await sponsoredTransfer({ account: settlement, to: p.to, amount: BigInt(p.amount), memo })
    await sql`UPDATE payments SET status=${p.status}, settle_tx=${tx}, settled_at=now() WHERE id=${p.id}`
    await audit({ lineId: p.line_id, actor: 'servicer', action: p.status === 'settled' ? 'payment.settled' : `payment.${p.status}`, detail: { code: p.code, amount: p.amount }, txHash: tx })
  } catch (e: any) {
    if (await reconcile()) return
    await sql`UPDATE payments SET status='failed', error=${String(e?.details ?? e?.message ?? e).slice(0, 400)} WHERE id=${p.id}`
  }
}

/** Index card payments into the settlement address and settle them. Called by the watcher loop. */
export async function processPayments(from: bigint, to: bigint) {
  const logs = (await getLogs(publicClient, {
    address: net.token,
    event: transferWithMemo,
    args: { to: settlement.address },
    fromBlock: from,
    toBlock: to,
  } as any)) as any[]
  for (const l of logs) {
    const payer = lower(l.args.from)
    const amount = BigInt(l.args.amount)
    const decoded = decodePayMemo(l.args.memo)
    const [line] = await sql`SELECT id, borrower_wallet, guarantor_wallet FROM lines WHERE credit_account=${payer}`
    const [merchant] = decoded ? await sql`SELECT * FROM merchants WHERE code=${decoded.merchantCode} AND active` : []

    let status = 'settled'
    let dest: Address | null = merchant ? (merchant.settle_to as Address) : null
    if (!line) {
      // not one of THIS servicer's credit accounts (another deployment sharing the network address, or a
      // stray transfer): record it, never move money for it
      await sql`
        INSERT INTO payments (pay_tx, log_index, line_id, merchant_code, payer, amount, memo, status, block_number)
        VALUES (${l.transactionHash}, ${l.logIndex}, NULL, NULL, ${payer}, ${amount.toString()}, ${l.args.memo},
                'unknown_payer', ${l.blockNumber.toString()})
        ON CONFLICT (pay_tx, log_index) DO NOTHING`
      continue
    }
    if (!merchant) {
      status = 'unmatched'
      dest = payer // our card paid an unknown merchant code: refund the credit
    } else if (
      lower(merchant.owner_wallet) === lower(line.borrower_wallet) ||
      (line.guarantor_wallet && lower(merchant.owner_wallet) === lower(line.guarantor_wallet))
    ) {
      status = 'refunded_self_dealing'
      dest = payer
    }
    const [p] = await sql`
      INSERT INTO payments (pay_tx, log_index, line_id, merchant_code, payer, amount, memo, status, block_number)
      VALUES (${l.transactionHash}, ${l.logIndex}, ${line?.id ?? null}, ${merchant?.code ?? null}, ${payer}, ${amount.toString()},
              ${l.args.memo}, 'received', ${l.blockNumber.toString()})
      ON CONFLICT (pay_tx, log_index) DO NOTHING RETURNING *`
    if (!p) continue // already processed
    // a real sale: split it (merchant fee, cashback, the shop's offer) and settle the shop's share
    const payout = status === 'settled' ? await splitPayment(p.id, merchant, amount) : amount
    await settleOne({ id: p.id, line_id: line?.id ?? null, to: dest!, amount: payout, status, code: merchant?.code ?? null })
    if (status === 'settled') await payCashback(p.id).catch((e) => console.error('[cashback] failed (will retry)', p.id, e?.shortMessage ?? e?.message ?? e))
  }
  // retry failed settlements
  const failed = await sql`SELECT p.*, m.settle_to FROM payments p LEFT JOIN merchants m ON m.code=p.merchant_code WHERE p.status='failed' AND p.settle_tx IS NULL LIMIT 20`
  for (const f of failed) {
    const dest = (f.settle_to ?? f.payer) as Address
    const amount = f.settle_to && f.merchant_net !== null ? BigInt(f.merchant_net) : BigInt(f.amount)
    await settleOne({ id: f.id, line_id: f.line_id, to: dest, amount, status: f.settle_to ? 'settled' : 'unmatched', code: f.merchant_code })
  }
  await retryCashback()
}

export async function merchantDashboard(owner: Address) {
  const [m] = await sql`SELECT * FROM merchants WHERE owner_wallet=${lower(owner)}`
  if (!m) return null
  // history = on-chain settlements to this merchant's wallet (source of truth), enriched with app records when present
  const payments = await sql`
    SELECT s.amount, s.tx_hash AS settle_tx, p.pay_tx, 'settled' AS status, COALESCE(s.block_time, p.settled_at) AS created_at,
           s.block_number::text AS block_number, p.amount AS gross, p.fee, p.offer_cashback
    FROM settlements s LEFT JOIN payments p ON p.settle_tx = s.tx_hash
    WHERE s.to_addr = ${lower(m.settle_to)} ORDER BY s.block_number DESC LIMIT 200`
  const [tot] = await sql`SELECT COALESCE(sum(amount),0) AS total, count(*) AS n FROM settlements WHERE to_addr=${lower(m.settle_to)}`
  // settlements still in flight (received, not yet on-chain out)
  const pending = await sql`SELECT amount, pay_tx, status, created_at FROM payments
                            WHERE merchant_code=${m.code} AND status IN ('received','failed') ORDER BY id DESC LIMIT 20`
  const fees = await sql`SELECT COALESCE(sum(fee),0) AS fees, COALESCE(sum(offer_cashback),0) AS given FROM payments WHERE merchant_code=${m.code}`
  return {
    merchant: merchantView(m),
    payments,
    pending,
    settledTotal: tot.total.toString(),
    settledCount: Number(tot.n),
    source: 'tempo-chain',
    feeBps: feeBpsFor(m),
    feesPaid: String(fees[0].fees),
    offerCashbackGiven: String(fees[0].given),
    ...(await offerDashboard(m.code)),
  }
}

export const _head = () => getBlockNumber(publicClient)

/** Index every transfer OUT of the settlement address (chain truth), with block timestamps. */
export async function indexSettlements(from: bigint, to: bigint) {
  const logs = (await getLogs(publicClient, {
    address: net.token,
    event: transferWithMemo,
    args: { from: settlement.address },
    fromBlock: from,
    toBlock: to,
  } as any)) as any[]
  const times = new Map<bigint, Date>()
  for (const l of logs) {
    if (!times.has(l.blockNumber)) {
      const b = await getBlock(publicClient, { blockNumber: l.blockNumber }).catch(() => null)
      if (b) times.set(l.blockNumber, new Date(Number(b.timestamp) * 1000))
    }
    await sql`
      INSERT INTO settlements (tx_hash, log_index, to_addr, amount, memo, block_number, block_time)
      VALUES (${l.transactionHash}, ${l.logIndex}, ${lower(l.args.to)}, ${l.args.amount.toString()}, ${l.args.memo},
              ${l.blockNumber.toString()}, ${times.get(l.blockNumber) ?? null})
      ON CONFLICT DO NOTHING`
  }
}
