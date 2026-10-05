import { parseAbiItem, type Address } from 'viem'
import { getBlockNumber, getLogs } from 'viem/actions'
import { Abis } from 'viem/tempo'
import { ACCOUNT_KEYCHAIN } from '@keycard/sdk'
import { net, tiers } from './config'
import { lineBookWrite, publicClient, settlement, tokenBalance, treasury } from './chain'
import { processPayments, indexSettlements } from './merchants'
import { audit, sql } from './db'
import { freezeLine, moveOnce, setSpendLimit } from './lines'
import { Account } from 'viem/tempo'
import { open } from './vault'
import { indexExternalRepayments } from './repay'

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)')
const keyRevoked = (Abis.accountKeychain as readonly any[]).find((x) => x.type === 'event' && x.name === 'KeyRevoked')
const lower = (a: string) => a.toLowerCase() as Address
const STEP = 2_000n

async function cursor(name: string): Promise<bigint> {
  const [c] = await sql`SELECT last_block FROM cursors WHERE name=${name}`
  if (c) return BigInt(c.last_block)
  // fresh database: nothing historical belongs to it, so start from the current block
  const head = await getBlockNumber(publicClient)
  await setCursor(name, head)
  return head
}
async function setCursor(name: string, b: bigint) {
  await sql`INSERT INTO cursors (name,last_block) VALUES (${name},${b.toString()})
            ON CONFLICT (name) DO UPDATE SET last_block=${b.toString()}`
}

/** A borrower revoking the mandate freezes their card; a guarantor revoking shrinks the line. */
async function handleRevocations(from: bigint, to: bigint) {
  const logs = (await getLogs(publicClient, { address: ACCOUNT_KEYCHAIN, event: keyRevoked, fromBlock: from, toBlock: to } as any)) as any[]
  for (const l of logs) {
    const account = lower(l.args.account)
    const keyId = lower(l.args.publicKey)
    const [mandateLine] = await sql`
      SELECT * FROM lines WHERE borrower_wallet=${account} AND repay_key_id=${keyId} AND status IN ('active','grace')`
    if (mandateLine) {
      await audit({ lineId: mandateLine.id, actor: 'chain', action: 'mandate.revoked', txHash: l.transactionHash })
      await freezeLine(mandateLine, 'MandateRevoked')
      continue
    }
    const [guarLine] = await sql`
      SELECT * FROM lines WHERE guarantor_wallet=${account} AND guar_key_id=${keyId} AND status IN ('active','grace','frozen')`
    if (guarLine) {
      await audit({ lineId: guarLine.id, actor: 'chain', action: 'guarantee.revoked', txHash: l.transactionHash })
      await onGuaranteeWithdrawn(guarLine)
    }
  }
}

async function onGuaranteeWithdrawn(row: any) {
  await lineBookWrite('recordGuarantorChange', [BigInt(row.linebook_id), '0x0000000000000000000000000000000000000000', 0n])
  await sql`UPDATE guarantee_invites SET status='withdrawn' WHERE line_id=${row.id} AND status='active'`
  const base = tiers[0] + BigInt(row.secured ?? 0) // collateral-backed limit is not the guarantor's to take away
  const limit = BigInt(row.credit_limit)
  if (limit > base && row.status !== 'frozen') {
    // shrink: new available must be base - owed; sweep the excess back to treasury
    const available = await tokenBalance(row.credit_account)
    const owed = limit > available ? limit - available : 0n
    const targetAvailable = base > owed ? base - owed : 0n
    if (available > targetAvailable) {
      const creditRoot = Account.fromSecp256k1(open(row.credit_root_enc))
      await moveOnce({ lineId: Number(row.id), kind: 'TOPUP', seq: 800_000 + row.statement_seq, from: creditRoot, to: treasury.address, amount: available - targetAvailable, memoKind: 'REFUND' })
    }
    await setSpendLimit(row, base)
    await lineBookWrite('recordLimitChange', [BigInt(row.linebook_id), base])
  }
  await sql`UPDATE lines SET guarantor_wallet=NULL, guar_key_id=NULL, guar_key_enc=NULL, guaranteed=0,
            credit_limit=LEAST(credit_limit, ${base.toString()}), updated_at=now() WHERE id=${row.id}`
}

/** Index borrower spends (credit account -> merchant) for the public stats page. */
async function indexSpends(from: bigint, to: bigint) {
  const accounts = (await sql`SELECT id, credit_account FROM lines WHERE linebook_id IS NOT NULL`).map((r) => ({ id: r.id, a: lower(r.credit_account) }))
  if (accounts.length === 0) return
  const byAccount = new Map(accounts.map((x) => [x.a, x.id]))
  const logs = (await getLogs(publicClient, {
    address: net.token,
    event: transferEvent,
    args: { from: accounts.map((x) => x.a) },
    fromBlock: from,
    toBlock: to,
  } as any)) as any[]
  for (const l of logs) {
    const merchant = lower(l.args.to)
    if (merchant === lower(treasury.address)) continue // sweeps/refunds are not spends
    if (merchant === lower(settlement.address)) continue // card payments are tracked in `payments`
    const lineId = byAccount.get(lower(l.args.from))
    if (!lineId) continue
    await sql`
      INSERT INTO spends (tx_hash, log_index, line_id, merchant, amount, block_number)
      VALUES (${l.transactionHash}, ${l.logIndex}, ${lineId}, ${merchant}, ${l.args.amount.toString()}, ${l.blockNumber.toString()})
      ON CONFLICT DO NOTHING`
  }
}

let running = false
export async function watchTick() {
  if (running) return
  running = true
  try {
    const head = await getBlockNumber(publicClient)
    // on-chain settlement index: backfills from the deployment block once, then follows the head
    const [sc] = await sql`SELECT last_block FROM cursors WHERE name='settlements'`
    let sFrom = (sc ? BigInt(sc.last_block) : (net.deployBlock ?? head) - 1n) + 1n
    while (sFrom <= head) {
      const sTo = sFrom + 20_000n - 1n > head ? head : sFrom + 20_000n - 1n
      await indexSettlements(sFrom, sTo)
      await setCursor('settlements', sTo)
      sFrom = sTo + 1n
    }
    let from = (await cursor('watcher')) + 1n
    while (from <= head) {
      const to = from + STEP - 1n > head ? head : from + STEP - 1n
      await handleRevocations(from, to)
      await indexSpends(from, to)
      await processPayments(from, to)
      await indexExternalRepayments(from, to)
      await setCursor('watcher', to)
      from = to + 1n
    }
  } catch (e) {
    console.error('watcher error', e)
  } finally {
    running = false
  }
}

export function startWatcher(intervalMs = 4_000) {
  const t = setInterval(() => void watchTick(), intervalMs)
  void watchTick()
  return () => clearInterval(t)
}
