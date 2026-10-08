import type { Address } from 'viem'
import { BORROWER_FLAGS } from '@keycard/sdk'
import { audit, sql } from './db'
import { UserError } from './lines'
import { normUsername } from './passwordlogin'

const lower = (a: string) => a.toLowerCase() as Address

/**
 * A borrower's credit file, shareable by link (/u/<username>) only when they turn it on. It shows repayment history
 * and whether Self verified them, never their name, documents, balance or spending. Every count is also recorded on
 * the LineBook contract, so anyone can check it on-chain.
 */
export async function publicProfile(username: string) {
  let u: string
  try {
    u = normUsername(username)
  } catch {
    throw new UserError('no credit file here', 404)
  }
  const [user] = await sql`SELECT wallet, username, role, public_profile, created_at FROM users WHERE username=${u}`
  if (!user || user.role !== 'borrower' || !user.public_profile) throw new UserError('no credit file here', 404)
  const [att] = await sql`SELECT flags, expires_at, tx_hash FROM attestations WHERE wallet=${user.wallet}`
  const lines = await sql`
    SELECT linebook_id, status, credit_limit, on_time_count, missed_count, opened_at, settled_at, credit_account
    FROM lines WHERE borrower_wallet=${user.wallet} AND status <> 'preparing' ORDER BY created_at`
  const live = [...lines].reverse().find((l) => ['active', 'grace', 'frozen'].includes(l.status))
  const sum = (k: string) => lines.reduce((n, l) => n + Number(l[k]), 0)
  return {
    username: user.username as string,
    wallet: user.wallet as Address,
    memberSince: user.created_at as Date,
    verified: Boolean(att && (att.flags & BORROWER_FLAGS) === BORROWER_FLAGS && new Date(att.expires_at) > new Date()),
    attestationTx: (att?.tx_hash as string | null) ?? null,
    firstLineAt: (lines[0]?.opened_at as Date | null) ?? null,
    onTime: sum('on_time_count'),
    missed: sum('missed_count'),
    defaults: lines.filter((l) => l.status === 'defaulted' || l.status === 'settled').length,
    defaultsRepaid: lines.filter((l) => l.status === 'settled').length,
    lines: lines.length,
    current: live ? { status: live.status as string, limit: String(live.credit_limit), creditAccount: live.credit_account as Address } : null,
    lineBookIds: lines.map((l) => l.linebook_id).filter(Boolean).map(Number),
  }
}

export async function setPublicProfile(wallet: Address, on: boolean) {
  const [user] = await sql`SELECT username, role FROM users WHERE wallet=${lower(wallet)}`
  if (!user) throw new UserError('unknown account', 404)
  if (user.role !== 'borrower') throw new UserError('only cardholders have a credit file', 403)
  if (on && !user.username) throw new UserError('pick a username first', 409)
  await sql`UPDATE users SET public_profile=${on} WHERE wallet=${lower(wallet)}`
  await audit({ actor: 'borrower', action: on ? 'profile.shared' : 'profile.hidden', detail: { wallet: lower(wallet) } })
  return { publicProfile: on, username: user.username as string | null }
}
