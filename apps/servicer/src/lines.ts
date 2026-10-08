import { parseEventLogs, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Abis, Account, Actions } from 'viem/tempo'
import { PublicKey } from 'ox'
import {
  BORROWER_FLAGS,
  FreezeReason,
  encodeMemo,
  lineBookAbi,
  mandateKeyPolicy,
  spendKeyPolicy,
} from '@keycard/sdk'
import { env, net, tiers } from './config'
import {
  clientFor,
  findMemoTransfer,
  getKey,
  lineBookRead,
  lineBookWrite,
  registryRead,
  remainingLimit,
  settlement,
  sponsoredTransfer,
  tokenBalance,
  treasury,
  verifyKeyPolicy,
} from './chain'
import { audit, sql } from './db'
import { open, seal } from './vault'

export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

const lower = (a: string) => a.toLowerCase() as Address
const isTransient = (e: any) => /HTTP request failed|rate limit|429|50[234]|timed? ?out|ECONNRESET|fetch failed/i.test(String(e?.details ?? e?.shortMessage ?? e?.message ?? e))

/** Run a write; on transient failure, check `done()` on-chain before retrying (never blind-resend). */
export async function resilient<T>(label: string, run: () => Promise<T>, done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (await done().catch(() => false)) return
    try {
      await run()
      return
    } catch (e) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt))
      if (await done().catch(() => false)) return
      if (!isTransient(e) || attempt >= 4) throw e
      console.warn(`[${label}] transient failure, retrying`, String((e as any)?.shortMessage ?? e))
    }
  }
}

/** keyId Tempo assigns to a WebAuthn public key acting as an access key on `parent`. */
export function webAuthnKeyId(publicKey: Hex, parent: Address): Address {
  return lower(
    (Account.from({ access: parent, keyType: 'webAuthn', publicKey: PublicKey.fromHex(publicKey), sign: async () => '0x' } as any) as any)
      .accessKeyAddress,
  )
}

/**
 * The card's allow-list is exactly ONE address: the KEYKARD settlement address. Merchants are
 * identified by the memo (KCP:<code>:<nonce>) and settled by the servicer, like a card network.
 * Any other destination is refused by the Tempo protocol.
 */
export async function activeMerchants(): Promise<Address[]> {
  return [settlement.address]
}

/** Maximum any line can ever reach (top unsecured tier + the most collateral); the auto-pay is authorised for it once. */
export const mandateCap = () => tiers[tiers.length - 1] + env.MAX_SECURED

// ---------------------------------------------------------------------------------------------
// 1. PREPARE: create the credit account + mandate key; return what the borrower must sign.
// ---------------------------------------------------------------------------------------------
export async function prepareLine(borrower: Address) {
  borrower = lower(borrower)
  const [user] = await sql`SELECT * FROM users WHERE wallet = ${borrower}`
  if (!user || user.role !== 'borrower') throw new UserError('register as a borrower first')

  const [unsettled] = await sql`SELECT id, amount_due FROM lines WHERE borrower_wallet=${borrower} AND status='defaulted' LIMIT 1`
  if (unsettled) throw new UserError('your previous line defaulted: settle it first (Pay now on your card page)', 403)
  const [existing] = await sql`
    SELECT * FROM lines WHERE borrower_wallet = ${borrower} AND status IN ('preparing','active','grace','frozen')`
  if (existing && existing.status !== 'preparing') throw new UserError('you already have a live line')
  const eligible = await registryRead<boolean>('isEligible', [borrower, BORROWER_FLAGS])
  if (!eligible) throw new UserError('identity not verified yet (Self)', 403)
  let row = existing
  if (!row) {
    const creditPk = generatePrivateKey()
    const repayPk = generatePrivateKey()
    const creditAccount = lower(Account.fromSecp256k1(creditPk).address)
    const repayKeyId = lower(Account.fromSecp256k1(repayPk, { access: borrower }).accessKeyAddress)
    const termEnd = new Date(Date.now() + env.TERM_DAYS * 86400_000)
    ;[row] = await sql`
      INSERT INTO lines (borrower_wallet, credit_account, credit_root_enc, repay_key_id, repay_key_enc,
                         mandate_cap, token, credit_limit, period_seconds, term_end)
      VALUES (${borrower}, ${creditAccount}, ${seal(creditPk)}, ${repayKeyId}, ${seal(repayPk)},
              ${mandateCap().toString()}, ${lower(net.token)}, ${tiers[0].toString()}, ${env.PERIOD_SECONDS}, ${termEnd})
      RETURNING *`
    await audit({ lineId: row.id, actor: 'servicer', action: 'line.prepared', detail: { creditAccount, repayKeyId } })
  }

  const expiry = Math.floor(new Date(row.term_end).getTime() / 1000)
  const policy = mandateKeyPolicy({
    token: net.token,
    instalment: BigInt(row.mandate_cap),
    period: row.period_seconds,
    repayTo: treasury.address,
    expiry,
  })
  return {
    lineId: Number(row.id),
    creditAccount: row.credit_account as Address,
    mandate: {
      keyId: row.repay_key_id as Address,
      keyType: 'secp256k1' as const,
      token: net.token,
      cap: row.mandate_cap.toString(),
      periodSeconds: row.period_seconds,
      recipient: treasury.address,
      expiry,
      policy: JSON.parse(JSON.stringify(policy, (_, v) => (typeof v === 'bigint' ? v.toString() : v))),
    },
    startingLimit: row.credit_limit.toString(),
    settlement: settlement.address,
  }
}

// ---------------------------------------------------------------------------------------------
// 2. OPEN: after the borrower's mandate is on-chain, verify it, fund the line, issue the card key.
// ---------------------------------------------------------------------------------------------
export async function openLine(borrower: Address, lineId: number) {
  borrower = lower(borrower)
  const [row] = await sql`SELECT * FROM lines WHERE id = ${lineId} AND borrower_wallet = ${borrower}`
  if (!row) throw new UserError('line not found', 404)
  if (row.status !== 'preparing') return lineView(row.id)
  const [user] = await sql`SELECT * FROM users WHERE wallet = ${borrower}`

  // (a) the mandate must be exactly what we asked for
  const v = await verifyKeyPolicy({ account: borrower, keyId: row.repay_key_id, recipients: [treasury.address] })
  if (!v.ok) throw new UserError(`mandate not valid on-chain: ${v.reason}`)
  const lim = await remainingLimit(borrower, row.repay_key_id)
  if (lim.remaining < BigInt(row.mandate_cap)) throw new UserError('mandate limit is lower than required')

  const creditRoot = Account.fromSecp256k1(open(row.credit_root_enc))
  const limit = BigInt(row.credit_limit)
  const expiry = Math.floor(new Date(row.term_end).getTime() / 1000)

  // (b) fund the credit account (idempotent by memo)
  const funded = await moveOnce({
    lineId: Number(row.id),
    kind: 'FUND',
    seq: 0,
    from: treasury,
    to: row.credit_account,
    amount: limit,
    memoKind: 'FUND',
  })
  if (funded.status !== 'confirmed') throw new UserError(`could not fund credit line: ${funded.error}`, 502)

  // (c) authorise the borrower's passkey as the spend key on the credit account
  const merchants = await activeMerchants()
  const pol = spendKeyPolicy({ token: net.token, limit, period: row.period_seconds, merchants, expiry })
  // the user's own sign-in keys become the card keys on the credit account: the first here, the rest via
  // syncSpendKeys below (password key first: it works on every device)
  const [first] = await sql`SELECT * FROM credentials WHERE wallet=${borrower} AND status='active' AND kind IN ('password','passkey')
                            ORDER BY (kind='password') DESC, is_root DESC, id LIMIT 1`
  const deviceKey = first ? first.kind === 'password' : user.key_type === 'secp256k1'
  const passkeyPub = (first?.public_key ?? user.passkey_public_key) as Hex
  const spendKeyId = deviceKey ? lower(first?.key_id ?? user.wallet) : webAuthnKeyId(passkeyPub, row.credit_account)
  const accessKey = deviceKey
    ? { address: spendKeyId, type: 'secp256k1' as const }
    : { publicKey: passkeyPub, type: 'webAuthn' as const }
  await resilient(
    'authorize-spend-key',
    () =>
      Actions.accessKey.authorizeSync(clientFor(creditRoot), {
        accessKey,
        ...pol,
        feePayer: treasury,
      } as any),
    async () => (await getKey(row.credit_account, spendKeyId)).exists,
  )

  // (d) public credit file
  let linebookId = (await lineBookRead<bigint>('activeLineOf', [borrower])) || 0n
  let openTx: Hex | null = null
  if (linebookId === 0n) {
    await resilient(
      'linebook-open',
      async () => {
        const receipt = await lineBookWrite('openLine', [
          borrower,
          row.credit_account,
          borrower,
          '0x0000000000000000000000000000000000000000',
          net.token,
          limit,
          BigInt(row.mandate_cap),
          0n,
          BigInt(row.period_seconds),
          BigInt(expiry),
        ])
        const [opened] = parseEventLogs({ abi: lineBookAbi, logs: receipt.logs, eventName: 'LineOpened' }) as any[]
        linebookId = opened.args.id as bigint
        openTx = receipt.transactionHash
      },
      async () => {
        const id = await lineBookRead<bigint>('activeLineOf', [borrower])
        if (id > 0n) linebookId = id
        return id > 0n
      },
    )
  }

  await sql`INSERT INTO line_spend_keys (line_id, key_id) VALUES (${row.id}, ${spendKeyId}) ON CONFLICT DO NOTHING`
  await sql`
    UPDATE lines SET status = 'active', linebook_id = ${linebookId.toString()}, spend_key_id = ${spendKeyId},
      opened_at = now(), next_due = now() + (${row.period_seconds} || ' seconds')::interval, updated_at = now()
    WHERE id = ${row.id}`
  await audit({ lineId: row.id, actor: 'servicer', action: 'line.opened', detail: { linebookId, spendKeyId, limit }, txHash: openTx })
  // the account's other sign-in keys (e.g. a passkey next to the password) become card keys too
  await syncSpendKeys(borrower).catch((e) => console.error('[open] card key sync failed', e?.shortMessage ?? e?.message ?? e))
  return lineView(row.id)
}

// ---------------------------------------------------------------------------------------------
// Money movements, idempotent by memo.
// ---------------------------------------------------------------------------------------------
export async function moveOnce(p: {
  lineId: number
  kind: 'FUND' | 'INST' | 'GUAR' | 'TOPUP' | 'EXT' | 'REFUND'
  seq: number
  from: any // viem account (root or access key)
  to: Address
  amount: bigint
  memoKind: 'FUND' | 'INST' | 'GUAR' | 'REFUND' | 'REPAY'
}): Promise<{ txHash: Hex | null; status: 'confirmed' | 'failed'; error?: string }> {
  const memoSeq = p.kind === 'TOPUP' ? 1_000_000 + p.seq : p.seq
  const memoHex = encodeMemo(p.memoKind, p.lineId, memoSeq)
  const fromAddr = lower(p.from.address)
  const [m] = await sql`
    INSERT INTO movements (line_id, kind, seq, memo, amount, from_addr, to_addr)
    VALUES (${p.lineId}, ${p.kind}, ${p.seq}, ${memoHex}, ${p.amount.toString()}, ${fromAddr}, ${lower(p.to)})
    ON CONFLICT (memo) DO UPDATE SET updated_at = now()
    RETURNING *`
  if (m.status === 'confirmed') return { txHash: m.tx_hash, status: 'confirmed' }
  // reconcile first: a previous attempt may have landed even though we recorded a failure
  if (m.status === 'failed' || m.status === 'pending') {
    const landed = await findMemoTransfer({ from: fromAddr, to: lower(p.to), memo: memoHex }).catch(() => null)
    if (landed) {
      await sql`UPDATE movements SET status='confirmed', tx_hash=${landed.txHash}, error=NULL, updated_at=now() WHERE id=${m.id}`
      return { txHash: landed.txHash, status: 'confirmed' }
    }
  }
  try {
    // transient RPC errors (rate limits) are rejected before broadcast, so retrying is safe;
    // a genuinely failed transfer (revert) is not retried here.
    let txHash: Hex | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        txHash = await sponsoredTransfer({ account: p.from, to: p.to, amount: p.amount, memo: memoHex })
        break
      } catch (e: any) {
        const msg = String(e?.details ?? e?.shortMessage ?? e?.message ?? e)
        if (attempt < 5 && /rate limit|429|timed? ?out|ECONNRESET|fetch failed/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
          const landed = await findMemoTransfer({ from: fromAddr, to: lower(p.to), memo: memoHex }).catch(() => null)
          if (landed) {
            txHash = landed.txHash
            break
          }
          continue
        }
        throw e
      }
    }
    await sql`UPDATE movements SET status='confirmed', tx_hash=${txHash}, error=NULL, updated_at=now() WHERE id=${m.id}`
    return { txHash, status: 'confirmed' }
  } catch (e: any) {
    // the send may have landed despite the error (timeout, dropped response): reconcile by memo
    const landed = await findMemoTransfer({ from: fromAddr, to: lower(p.to), memo: memoHex }).catch(() => null)
    if (landed) {
      await sql`UPDATE movements SET status='confirmed', tx_hash=${landed.txHash}, error=NULL, updated_at=now() WHERE id=${m.id}`
      return { txHash: landed.txHash, status: 'confirmed' }
    }
    const error = String(e?.details ?? e?.shortMessage ?? e?.message ?? e).slice(0, 500)
    await sql`UPDATE movements SET status='failed', error=${error}, updated_at=now() WHERE id=${m.id}`
    return { txHash: null, status: 'failed', error }
  }
}

// ---------------------------------------------------------------------------------------------
// Card controls used by the scheduler / watcher / admin.
// ---------------------------------------------------------------------------------------------
async function updateKeyLimit(row: any, keyId: string, newLimit: bigint) {
  const creditRoot = Account.fromSecp256k1(open(row.credit_root_enc))
  await resilient(
    `update-limit-${keyId.slice(0, 8)}`,
    () =>
      Actions.accessKey.updateLimitSync(clientFor(creditRoot), {
        accessKey: keyId,
        token: net.token,
        limit: newLimit,
        feePayer: treasury,
      } as any),
    async () => {
      const k = await getKey(row.credit_account, keyId as Address)
      if (!k.exists || k.revoked) return true // nothing to update
      return (await remainingLimit(row.credit_account, keyId as Address)).remaining === newLimit && newLimit === 0n
    },
  )
}

/** Every key the user can pay with on this line (password key, passkeys). Falls back to the original card key. */
async function spendKeys(row: any): Promise<string[]> {
  const keys = (await sql`SELECT key_id FROM line_spend_keys WHERE line_id=${row.id} AND status='active'`).map((r) => r.key_id as string)
  return keys.length > 0 ? keys : row.spend_key_id ? [row.spend_key_id] : []
}

/** Sets the card keys' per-period limit (used on tier upgrades). */
export async function setSpendLimit(row: any, newLimit: bigint) {
  const [f] = await sql`SELECT user_frozen FROM lines WHERE id=${row.id}`
  if (f?.user_frozen) newLimit = 0n
  for (const k of await spendKeys(row)) await updateKeyLimit(row, k, newLimit)
}

/**
 * Keep the credit account's card keys in step with the account's sign-in keys: every active password key and
 * passkey can pay (recovery keys never can). Added keys are authorised with the line's current limit (0 while the
 * line is paused); removed ones are revoked on-chain.
 */
export async function syncSpendKeys(wallet: Address) {
  wallet = lower(wallet)
  const [row] = await sql`SELECT * FROM lines WHERE borrower_wallet=${wallet} AND status IN ('active','grace','frozen') AND spend_key_id IS NOT NULL
                          ORDER BY created_at DESC LIMIT 1`
  if (!row) return
  const creds = await sql`SELECT * FROM credentials WHERE wallet=${wallet} AND status='active' AND kind IN ('password','passkey')`
  const desired = creds.map((c) =>
    c.kind === 'password'
      ? { keyId: lower(c.key_id), credId: c.id, accessKey: { address: lower(c.key_id), type: 'secp256k1' as const } }
      : { keyId: webAuthnKeyId(c.public_key as Hex, row.credit_account), credId: c.id, accessKey: { publicKey: c.public_key as Hex, type: 'webAuthn' as const } },
  )
  const existing = (await sql`SELECT key_id FROM line_spend_keys WHERE line_id=${row.id} AND status='active'`).map((r) => lower(r.key_id))
  const creditRoot = Account.fromSecp256k1(open(row.credit_root_enc))
  const limit = row.status === 'active' && !row.user_frozen ? BigInt(row.credit_limit) : 0n
  const pol = spendKeyPolicy({ token: net.token, limit, period: row.period_seconds, merchants: await activeMerchants(), expiry: Math.floor(new Date(row.term_end).getTime() / 1000) })
  for (const d of desired) {
    if (existing.includes(d.keyId)) continue
    const k = await getKey(row.credit_account, d.keyId)
    if (!k.exists || k.revoked) {
      await resilient(
        'authorize-card-key',
        () => Actions.accessKey.authorizeSync(clientFor(creditRoot), { accessKey: d.accessKey, ...pol, feePayer: treasury } as any),
        async () => (await getKey(row.credit_account, d.keyId)).exists,
      )
    }
    await sql`INSERT INTO line_spend_keys (line_id, key_id, credential_id) VALUES (${row.id}, ${d.keyId}, ${d.credId})
              ON CONFLICT (line_id, key_id) DO UPDATE SET status='active', credential_id=EXCLUDED.credential_id`
    await audit({ lineId: row.id, actor: 'servicer', action: 'card_key.added', detail: { keyId: d.keyId } })
  }
  const keep = new Set(desired.map((d) => d.keyId))
  for (const keyId of existing) {
    if (keep.has(keyId) || keyId === lower(row.card_key_id ?? '')) continue
    const k = await getKey(row.credit_account, keyId as Address)
    if (k.exists && !k.revoked) {
      await resilient(
        'revoke-card-key',
        () => Actions.accessKey.revokeSync(clientFor(creditRoot), { accessKey: keyId, feePayer: treasury } as any),
        async () => (await getKey(row.credit_account, keyId as Address)).revoked,
      )
    }
    await sql`UPDATE line_spend_keys SET status='revoked' WHERE line_id=${row.id} AND key_id=${keyId}`
    await audit({ lineId: row.id, actor: 'servicer', action: 'card_key.removed', detail: { keyId } })
  }
}

/**
 * Blocks or restores ALL spending keys on the credit account (phone card key AND physical NFC card key).
 * 'blocked' = on-chain limit 0 (grace, frozen, defaulted). 'normal' = line limit / card tap limit.
 */
export async function applyLimits(row: any, mode: 'normal' | 'blocked') {
  // a card the cardholder froze stays at 0 whatever else restores limits (repayments, cashback, upgrades)
  const [f] = await sql`SELECT user_frozen FROM lines WHERE id=${row.id}`
  if (f?.user_frozen) mode = 'blocked'
  const spend = mode === 'normal' ? BigInt(row.credit_limit) : 0n
  for (const k of await spendKeys(row)) await updateKeyLimit(row, k, spend)
  if (row.card_key_id && row.card_status === 'active') {
    const card = mode === 'normal' ? BigInt(row.card_limit ?? 0) : 0n
    await updateKeyLimit(row, row.card_key_id, card)
  }
}

export async function freezeLine(row: any, reason: keyof typeof FreezeReason) {
  if (row.status === 'frozen' || row.status === 'defaulted' || row.status === 'closed' || row.status === 'settled') return
  await applyLimits(row, 'blocked')
  await lineBookWrite('recordFreeze', [BigInt(row.linebook_id), FreezeReason[reason]])
  await sql`UPDATE lines SET status='frozen', freeze_reason=${reason}, updated_at=now() WHERE id=${row.id}`
  await audit({ lineId: row.id, actor: 'servicer', action: 'line.frozen', detail: { reason } })
}

/** Credit-line view for the app: on-chain balances + DB state. */
export async function lineView(id: number | bigint) {
  const [row] = await sql`SELECT * FROM lines WHERE id = ${String(id)}`
  if (!row) return null
  const limit = BigInt(row.credit_limit)
  let available: bigint | null = null
  let periodRemaining: bigint | null = null
  let periodEnd: bigint | null = null
  if (row.status !== 'preparing') {
    available = await tokenBalance(row.credit_account)
    if (row.spend_key_id) {
      const r = await remainingLimit(row.credit_account, row.spend_key_id)
      periodRemaining = r.remaining
      periodEnd = r.periodEnd
    }
  }
  // after a default the credit account is swept, so what's owed is the unpaid amount on record, not limit - balance
  const owed =
    row.status === 'defaulted' ? BigInt(row.amount_due)
    : row.status === 'settled' || row.status === 'closed' ? 0n
    : available === null ? 0n : limit > available ? limit - available : 0n
  let mandateActive = false
  if (row.status !== 'preparing') {
    const k = await getKey(row.borrower_wallet, row.repay_key_id).catch(() => null)
    mandateActive = Boolean(k && k.exists && !k.revoked)
  }
  const spendable =
    available === null ? 0n : periodRemaining === null ? available : available < periodRemaining ? available : periodRemaining
  const s = (v: bigint | null) => (v === null ? null : v.toString())
  return {
    id: Number(row.id),
    linebookId: row.linebook_id ? Number(row.linebook_id) : null,
    status: row.status as string,
    freezeReason: row.freeze_reason as string | null,
    creditAccount: row.credit_account as Address,
    spendKeyId: row.spend_key_id as Address | null,
    repayKeyId: row.repay_key_id as Address,
    mandateActive,
    settledAt: row.settled_at,
    card: row.card_key_id ? { address: row.card_key_id as Address, limit: String(row.card_limit), status: row.card_status } : null,
    userFrozen: Boolean(row.user_frozen),
    token: row.token as Address,
    limit: limit.toString(),
    available: s(available),
    owed: owed.toString(),
    spendable: spendable.toString(),
    periodRemaining: s(periodRemaining),
    periodEnd: s(periodEnd),
    nextDue: row.next_due,
    amountDue: row.amount_due.toString(),
    graceUntil: row.grace_until,
    onTimeCount: row.on_time_count,
    missedCount: row.missed_count,
    guarantorWallet: row.guarantor_wallet,
    guaranteed: row.guaranteed.toString(),
    mandateCap: row.mandate_cap.toString(),
    // pricing for missed payments + repay-from-anywhere + secured limit
    feesDue: String(row.fees_due ?? 0),
    feesCharged: String(row.fees_charged ?? 0),
    feesPaid: String(row.fees_paid ?? 0),
    totalDue: (BigInt(row.amount_due) + BigInt(row.fees_due ?? 0)).toString(),
    repayAccount: (row.repay_account as Address | null) ?? null,
    secured: String(row.secured ?? 0),
    unsecuredLimit: (limit - BigInt(row.secured ?? 0)).toString(),
    securedEarn: String(row.secured_earn ?? 0),
    // rewards: on-time streak toward the next fee shield, and shields held (0 or 1)
    onTimeStreak: Number(row.on_time_streak ?? 0),
    feeShields: Number(row.fee_shields ?? 0),
    periodSeconds: row.period_seconds,
    termEnd: row.term_end,
  }
}

/**
 * "Freeze my card": every key that can pay (phone keys and the physical card) drops to a 0 limit on-chain, so Tempo
 * itself refuses payments. Auto-pay, bills and the credit line are untouched. Unfreezing restores the limits if the
 * line is in good standing.
 */
export async function setUserFrozen(wallet: Address, frozen: boolean) {
  const [row] = await sql`SELECT * FROM lines WHERE borrower_wallet=${lower(wallet)} AND status IN ('active','grace','frozen')
                          ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new UserError('no active card', 404)
  await sql`UPDATE lines SET user_frozen=${frozen}, updated_at=now() WHERE id=${row.id}`
  const [fresh] = await sql`SELECT * FROM lines WHERE id=${row.id}`
  try {
    await applyLimits(fresh, frozen || fresh.status !== 'active' ? 'blocked' : 'normal')
  } catch (e) {
    if (!frozen) await sql`UPDATE lines SET user_frozen=true WHERE id=${row.id}` // couldn't restore: stay frozen, consistently
    throw e
  }
  await audit({ lineId: row.id, actor: 'borrower', action: frozen ? 'card.user_frozen' : 'card.user_unfrozen' })
  return lineView(row.id)
}
