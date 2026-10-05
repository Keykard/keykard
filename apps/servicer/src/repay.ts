import { parseAbiItem, type Address } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { getLogs } from 'viem/actions'
import { Account } from 'viem/tempo'
import { net } from './config'
import { lineBookWrite, publicClient, settlement, tokenBalance, treasury } from './chain'
import { audit, sql } from './db'
import { moveOnce } from './lines'
import { allocate, feesPaid, stopPenaltyClock } from './charges'
import { maybeSettle, maybeUnfreeze } from './lifecycle'
import { cureOverdue, topUp } from './scheduler'
import { open, seal } from './vault'
import { withLine } from './linelock'

/**
 * Repay from anywhere. Every line has its own repayment address: an exchange withdrawal, another wallet, a
 * family member: anything sent there in the line's stablecoin is applied to the line automatically, even with
 * auto-pay turned off. The borrowed amount is paid first, then fees; anything above what's owed goes back to
 * the borrower's KEYKARD wallet. The address only ever forwards to the KEYKARD treasury.
 */
const lower = (a: string) => a.toLowerCase() as Address
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)')

/** Lazily give a line its repayment address (lines opened before this existed get one on first view). */
export async function ensureRepayAccount(lineId: number | string): Promise<Address | null> {
  const [row] = await sql`SELECT repay_account, status FROM lines WHERE id=${lineId}`
  if (!row) return null
  if (row.repay_account) return row.repay_account as Address
  if (row.status === 'preparing') return null
  const pk = generatePrivateKey()
  const addr = lower(Account.fromSecp256k1(pk).address)
  const [u] = await sql`UPDATE lines SET repay_account=${addr}, repay_account_enc=${seal(pk)}, updated_at=now()
                        WHERE id=${lineId} AND repay_account IS NULL RETURNING repay_account`
  if (u) return addr
  const [again] = await sql`SELECT repay_account FROM lines WHERE id=${lineId}`
  return again.repay_account as Address
}

/** Watcher: record every incoming transfer to a repayment address (idempotent by tx + log index). */
export async function indexExternalRepayments(from: bigint, to: bigint) {
  const rows = await sql`SELECT id, repay_account FROM lines WHERE repay_account IS NOT NULL`
  if (rows.length === 0) return
  const byAccount = new Map(rows.map((r) => [lower(r.repay_account), r.id]))
  const logs = (await getLogs(publicClient, {
    address: net.token,
    event: transferEvent,
    args: { to: [...byAccount.keys()] },
    fromBlock: from,
    toBlock: to,
  } as any)) as any[]
  for (const l of logs) {
    const sender = lower(l.args.from)
    // our own sweeps never land here; a zero transfer is noise
    if (sender === lower(treasury.address) || sender === lower(settlement.address) || BigInt(l.args.amount) === 0n) continue
    const lineId = byAccount.get(lower(l.args.to))
    if (!lineId) continue
    await sql`INSERT INTO external_repayments (tx_hash, log_index, line_id, from_addr, amount, block_number)
              VALUES (${l.transactionHash}, ${l.logIndex}, ${lineId}, ${sender}, ${l.args.amount.toString()}, ${l.blockNumber.toString()})
              ON CONFLICT DO NOTHING`
  }
}

/** Scheduler: apply received repayments in order. Each step is idempotent, so a crash mid-way is safe to resume. */
export async function applyExternalRepayments() {
  const rows = await sql`SELECT * FROM external_repayments WHERE status='received' ORDER BY block_number, log_index LIMIT 20`
  for (const r of rows) {
    try {
      await withLine(r.line_id, async () => {
        const [cur] = await sql`SELECT * FROM external_repayments WHERE tx_hash=${r.tx_hash} AND log_index=${r.log_index}`
        if (cur.status === 'received') await applyOne(cur)
      })
    } catch (e: any) {
      const error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 500)
      console.error('[repay] apply failed', r.tx_hash, error)
      await sql`UPDATE external_repayments SET error=${error}, updated_at=now() WHERE tx_hash=${r.tx_hash} AND log_index=${r.log_index}`
    }
  }
}

async function applyOne(r: any) {
  const [row] = await sql`SELECT * FROM lines WHERE id=${r.line_id}`
  const amount = BigInt(r.amount)
  const seq = 100_000_000 + Number(r.id) // unique per incoming transfer; clear of every other memo range for this line
  const lineId = Number(row.id)

  // 1. plan once: how this payment splits (borrowed amount, fees, leftover), from the line as it was when it arrived
  let plan = r.applied as { principal: string; fees: string; leftover: string; defaulted: boolean } | null
  if (plan && plan.defaulted !== (row.status === 'defaulted')) {
    // the line defaulted (or settled) since this was planned: re-plan, unless money already moved for it
    const [moved] = await sql`SELECT 1 FROM movements WHERE line_id=${row.id} AND kind IN ('TOPUP','REFUND') AND seq=${seq} AND status='confirmed'`
    if (!moved) plan = null
  }
  if (!plan) {
    const defaulted = row.status === 'defaulted'
    let principal = 0n
    if (defaulted) principal = BigInt(row.amount_due)
    else if (['active', 'grace', 'frozen'].includes(row.status)) {
      const limit = BigInt(row.credit_limit)
      const available = await tokenBalance(row.credit_account)
      principal = limit > available ? limit - available : 0n // the whole balance, not just what's due: repay early any time
    }
    const fees = ['settled', 'closed'].includes(row.status) ? 0n : BigInt(row.fees_due)
    const a = allocate(amount, principal, fees)
    plan = { principal: a.principal.toString(), fees: a.fees.toString(), leftover: a.leftover.toString(), defaulted }
    await sql`UPDATE external_repayments SET applied=${sql.json(plan)}, updated_at=now() WHERE tx_hash=${r.tx_hash} AND log_index=${r.log_index}`
  }
  const principal = BigInt(plan.principal)
  const fees = BigInt(plan.fees)
  const leftover = BigInt(plan.leftover)

  // 2. forward everything from the repayment address to the treasury
  const repayAccount = Account.fromSecp256k1(open(row.repay_account_enc))
  const swept = await moveOnce({ lineId, kind: 'EXT', seq, from: repayAccount, to: treasury.address, amount, memoKind: 'REPAY' })
  if (swept.status !== 'confirmed') throw new Error(`sweep failed: ${swept.error}`)

  // 3. restore the credit that was repaid (not after a default: that line is closed to spending)
  if (principal > 0n && !plan.defaulted) await topUp(row, principal, seq)
  // 4. anything above what was owed goes back to the borrower's own KEYKARD wallet
  if (leftover > 0n) {
    const back = await moveOnce({ lineId, kind: 'REFUND', seq, from: treasury, to: row.borrower_wallet, amount: leftover, memoKind: 'REFUND' })
    if (back.status !== 'confirmed') throw new Error(`refund of the extra failed: ${back.error}`)
  }

  // 5. book it (single place that changes the line's numbers, then the status follow-ups)
  const done = await sql.begin(async (t) => {
    const [cur] = await t`SELECT status FROM external_repayments WHERE tx_hash=${r.tx_hash} AND log_index=${r.log_index} FOR UPDATE`
    if (cur.status !== 'received') return false
    if (principal > 0n) await t`UPDATE lines SET amount_due=GREATEST(amount_due-${principal.toString()}, 0), updated_at=now() WHERE id=${row.id}`
    await t`UPDATE external_repayments SET status='applied', error=NULL, updated_at=now() WHERE tx_hash=${r.tx_hash} AND log_index=${r.log_index}`
    return true
  })
  if (!done) return
  if (fees > 0n) await feesPaid(row, fees, swept.txHash)
  if (row.linebook_id && principal + fees > 0n) {
    await lineBookWrite('recordRepayment', [BigInt(row.linebook_id), swept.txHash!, principal + fees, false]).catch((e) =>
      console.error('[repay] LineBook record failed', e?.shortMessage ?? e),
    )
  }
  await audit({ lineId, actor: 'borrower', action: 'repaid.external', detail: { from: r.from_addr, amount, principal, fees, leftover }, txHash: swept.txHash })

  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  if (BigInt(fresh.amount_due) === 0n) {
    if (fresh.status === 'grace' || fresh.status === 'frozen') await cureOverdue(fresh)
    else await stopPenaltyClock(fresh.id)
  }
  if (fresh.status === 'frozen') await maybeUnfreeze(fresh.borrower_wallet)
  if (fresh.status === 'defaulted') await maybeSettle(fresh.id)
}
