import type { Address } from 'viem'
import { encodeMemo } from '@keycard/sdk'
import { env } from './config'
import { findMemoTransfer, settlement, sponsoredTransfer, tokenBalance } from './chain'
import { audit, sql } from './db'
import { UserError, applyLimits } from './lines'
import { withLine } from './linelock'

/**
 * Rewards, paid for the way card networks pay for them, so KEYKARD never loses money on a reward:
 *   1. Merchant fee: each card payment pays the network a fee (1% standard; KEYKARD can set a different fee per
 *      merchant, e.g. 0% to welcome early shops). Out of it the cardholder gets 0.5% back (never more than the fee).
 *   2. Merchant offers: a shop runs "N% back, up to $X per payment, until <date>, budget $B" from its dashboard. The
 *      cashback comes out of that shop's own payout, and the budget is reserved atomically so it can't be overspent.
 *   3. Fee shield: 3 on-time bills in a row earn one shield that cancels the next late fee (charges.ts uses it).
 * Cashback pays down what the cardholder owes first (freeing card spending right away); the rest goes to their wallet.
 * All movements leave from the KEYKARD settlement address with unique memos, so retries never pay twice.
 */
const lower = (a: string) => a.toLowerCase() as Address
const bps = (amount: bigint, b: number) => (amount * BigInt(b)) / 10_000n

export const rewardTerms = () => ({ merchantFeeBps: env.MERCHANT_FEE_BPS, baseCashbackBps: env.BASE_CASHBACK_BPS, shieldEvery: env.SHIELD_EVERY })
export const feeBpsFor = (m: any) => (m?.fee_bps ?? env.MERCHANT_FEE_BPS) as number

/** The offer customers see right now (live, not ended, budget left). */
export async function liveOffer(code: string) {
  const [o] = await sql`SELECT * FROM merchant_offers WHERE merchant_code=${code} AND status='active'
                        AND (ends_at IS NULL OR ends_at > now()) AND spent < budget LIMIT 1`
  return o ?? null
}

export const offerView = (o: any) =>
  o ? { id: Number(o.id), pctBps: o.pct_bps as number, maxPerPayment: String(o.max_per_payment), budget: String(o.budget), spent: String(o.spent), endsAt: o.ends_at, status: o.status as string } : null

/**
 * Split a settled card payment: merchant fee, 0.5% base cashback (out of the fee), the shop's offer cashback (out of
 * the shop's payout, budget reserved atomically). Returns what the merchant receives.
 */
export async function splitPayment(paymentId: number | string, merchant: any, amount: bigint) {
  const [cur] = await sql`SELECT merchant_net FROM payments WHERE id=${paymentId}`
  if (cur?.merchant_net !== null && cur?.merchant_net !== undefined) return BigInt(cur.merchant_net) // already split
  const fee = bps(amount, feeBpsFor(merchant))
  const base = (() => {
    const b = bps(amount, env.BASE_CASHBACK_BPS)
    return b < fee ? b : fee // the network never pays out more than it earned on the payment
  })()
  let offerCb = 0n
  let offerId: number | null = null
  const o = await liveOffer(merchant.code)
  if (o) {
    let want = bps(amount, o.pct_bps)
    if (want > BigInt(o.max_per_payment)) want = BigInt(o.max_per_payment)
    const room = BigInt(o.budget) - BigInt(o.spent)
    if (want > room) want = room
    // the shop can't give back more than it receives
    if (want > amount - fee) want = amount - fee
    if (want > 0n) {
      const [r] = await sql`UPDATE merchant_offers SET spent=spent+${want.toString()}, updated_at=now()
                            WHERE id=${o.id} AND status='active' AND spent+${want.toString()} <= budget RETURNING id`
      if (r) {
        offerCb = want
        offerId = Number(o.id)
      }
    }
  }
  const net = amount - fee - offerCb
  const total = base + offerCb
  await sql`UPDATE payments SET fee=${fee.toString()}, merchant_net=${net.toString()}, base_cashback=${base.toString()},
            offer_cashback=${offerCb.toString()}, offer_id=${offerId}, cashback_status=${total > 0n ? 'pending' : 'none'}
            WHERE id=${paymentId}`
  return net
}

async function sendOnce(p: { to: Address; amount: bigint; memo: `0x${string}` }) {
  const landed = await findMemoTransfer({ from: settlement.address, to: p.to, memo: p.memo }).catch(() => null)
  if (landed) return landed.txHash
  return sponsoredTransfer({ account: settlement, to: p.to, amount: p.amount, memo: p.memo })
}

/**
 * Pay a payment's cashback: what the cardholder owes is paid down first (the card account is refilled and its
 * spending allowance restored), anything left goes to their KEYKARD wallet. Idempotent per payment.
 */
export async function payCashback(paymentId: number | string) {
  const [p] = await sql`SELECT * FROM payments WHERE id=${paymentId}`
  if (!p || !['pending', 'failed'].includes(p.cashback_status) || !p.line_id) return
  const total = BigInt(p.base_cashback) + BigInt(p.offer_cashback)
  if (total === 0n) return
  await withLine(p.line_id, async () => {
    const [line] = await sql`SELECT * FROM lines WHERE id=${p.line_id}`
    let toCard = BigInt(p.cashback_to_card)
    let toWallet = BigInt(p.cashback_to_wallet)
    if (toCard + toWallet === 0n) {
      // decide once: pay down an active line's balance, rest to the wallet
      if (line.status === 'active') {
        const limit = BigInt(line.credit_limit)
        const available = await tokenBalance(line.credit_account)
        const owed = limit > available ? limit - available : 0n
        toCard = total < owed ? total : owed
      }
      toWallet = total - toCard
      await sql`UPDATE payments SET cashback_to_card=${toCard.toString()}, cashback_to_wallet=${toWallet.toString()} WHERE id=${p.id}`
    }
    try {
      let tx: string | null = null
      if (toCard > 0n) tx = await sendOnce({ to: line.credit_account, amount: toCard, memo: encodeMemo('SETTLE', p.id, 1) })
      if (toWallet > 0n) tx = await sendOnce({ to: line.borrower_wallet, amount: toWallet, memo: encodeMemo('SETTLE', p.id, 2) })
      await sql`UPDATE payments SET cashback_status='paid', cashback_tx=${tx} WHERE id=${p.id}`
      if (toCard > 0n && line.status === 'active') {
        const [fresh] = await sql`SELECT * FROM lines WHERE id=${line.id}`
        await applyLimits(fresh, 'normal').catch((e) => console.error('[cashback] allowance refill failed', e?.message))
      }
      await audit({ lineId: line.id, actor: 'servicer', action: 'reward.cashback', detail: { payment: Number(p.id), base: p.base_cashback, offer: p.offer_cashback, toCard, toWallet }, txHash: tx })
    } catch (e: any) {
      await sql`UPDATE payments SET cashback_status='failed', error=${String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)} WHERE id=${p.id}`
      throw e
    }
  })
}

export async function retryCashback() {
  const rows = await sql`SELECT id FROM payments WHERE cashback_status IN ('pending','failed') AND settle_tx IS NOT NULL ORDER BY id LIMIT 20`
  for (const r of rows) await payCashback(r.id).catch((e) => console.error('[cashback] retry failed', r.id, e?.shortMessage ?? e?.message ?? e))
}

// ---------------- merchant offers (from the merchant's own dashboard) ----------------
async function myMerchant(owner: Address) {
  const [m] = await sql`SELECT * FROM merchants WHERE owner_wallet=${lower(owner)}`
  if (!m) throw new UserError('set up your shop first', 404)
  return m
}

export async function createOffer(owner: Address, p: { pctBps: number; maxPerPayment: bigint; budget: bigint; endsAt?: string | null }) {
  const m = await myMerchant(owner)
  if (p.pctBps < 1 || p.pctBps > 5000) throw new UserError('cashback must be between 0.01% and 50%')
  if (p.maxPerPayment < 10_000n) throw new UserError('the most per payment must be at least $0.01')
  if (p.budget < 10_000n) throw new UserError('the budget must be at least $0.01')
  const endsAt = p.endsAt ? new Date(p.endsAt) : null
  if (endsAt && endsAt.getTime() < Date.now() + 60_000) throw new UserError('pick an end date in the future')
  await sql`UPDATE merchant_offers SET status='ended', updated_at=now() WHERE merchant_code=${m.code} AND status IN ('active','paused')`
  const [o] = await sql`INSERT INTO merchant_offers (merchant_code, pct_bps, max_per_payment, budget, ends_at)
                        VALUES (${m.code}, ${p.pctBps}, ${p.maxPerPayment.toString()}, ${p.budget.toString()}, ${endsAt}) RETURNING *`
  await audit({ actor: 'merchant', action: 'offer.created', detail: { code: m.code, pctBps: p.pctBps, max: p.maxPerPayment, budget: p.budget, endsAt } })
  return offerView(o)
}

export async function setOfferStatus(owner: Address, id: number, status: 'active' | 'paused' | 'ended') {
  const m = await myMerchant(owner)
  const [o] = await sql`UPDATE merchant_offers SET status=${status}, updated_at=now()
                        WHERE id=${id} AND merchant_code=${m.code} AND status IN ('active','paused') RETURNING *`
  if (!o) throw new UserError('that offer has already ended', 404)
  await audit({ actor: 'merchant', action: `offer.${status}`, detail: { code: m.code, id } })
  return offerView(o)
}

/** For the merchant dashboard: the current offer and how it's doing. */
export async function offerDashboard(code: string) {
  const [o] = await sql`SELECT * FROM merchant_offers WHERE merchant_code=${code} ORDER BY id DESC LIMIT 1`
  if (!o) return { offer: null, stats: null }
  const [s] = await sql`SELECT count(*)::int AS payments, count(DISTINCT line_id)::int AS customers,
                               COALESCE(sum(offer_cashback),0) AS cashback, COALESCE(sum(amount),0) AS sales
                        FROM payments WHERE offer_id=${o.id}`
  const ended = o.status === 'ended' || (o.ends_at && new Date(o.ends_at) <= new Date()) || BigInt(o.spent) >= BigInt(o.budget)
  return {
    offer: { ...offerView(o)!, live: o.status === 'active' && !ended, ended: Boolean(ended) },
    stats: { payments: s.payments, customers: s.customers, cashback: String(s.cashback), sales: String(s.sales) },
  }
}

/** Admin: a merchant's own fee (null = the standard fee). */
export async function setMerchantFee(code: string, feeBps: number | null) {
  if (feeBps !== null && (feeBps < 0 || feeBps > 500)) throw new UserError('fee must be between 0% and 5%')
  const [m] = await sql`UPDATE merchants SET fee_bps=${feeBps} WHERE code=${code.toUpperCase()} RETURNING code, fee_bps`
  if (!m) throw new UserError('merchant not found', 404)
  await audit({ actor: 'admin', action: 'merchant.fee_set', detail: { code: m.code, feeBps } })
  return { code: m.code, feeBps: m.fee_bps }
}

// ---------------- fee shield ----------------
/** A bill was paid on time: grow the streak; every SHIELD_EVERY in a row earns one shield (hold at most one). */
export async function onTimeBill(lineId: number | string) {
  const [r] = await sql`UPDATE lines SET on_time_streak=on_time_streak+1 WHERE id=${lineId} RETURNING on_time_streak, fee_shields`
  if (r && r.on_time_streak % env.SHIELD_EVERY === 0 && r.fee_shields < 1) {
    await sql`UPDATE lines SET fee_shields=1 WHERE id=${lineId}`
    await audit({ lineId: Number(lineId), actor: 'servicer', action: 'reward.shield_earned', detail: { streak: r.on_time_streak } })
  }
}

/** A bill was missed: the streak restarts. Returns true if a shield was used to cancel this late fee. */
export async function useShieldOnMiss(lineId: number | string) {
  return sql.begin(async (t) => {
    const [r] = await t`SELECT fee_shields FROM lines WHERE id=${lineId} FOR UPDATE`
    const used = Number(r?.fee_shields ?? 0) > 0
    await t`UPDATE lines SET on_time_streak=0, fee_shields=${used ? Number(r.fee_shields) - 1 : 0} WHERE id=${lineId}`
    if (used) await t`INSERT INTO audit_log (line_id, actor, action, detail) VALUES (${String(lineId)}, 'servicer', 'reward.shield_used', ${t.json({ saved: 'late_fee' })})`
    return used
  })
}
