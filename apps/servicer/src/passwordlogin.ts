import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Address } from 'viem'
import { sql } from './db'
import { UserError } from './lines'
import { mintSession } from './auth'

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/
const hash = (proof: string, salt: string) => scryptSync(proof, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')

export function normUsername(u: string) {
  const n = u.trim().toLowerCase()
  if (!USERNAME_RE.test(n)) throw new UserError('username must be 3-30 characters: letters, numbers, . _ -')
  return n
}

export async function usernameAvailable(u: string) {
  const n = normUsername(u)
  const [r] = await sql`SELECT 1 FROM users WHERE username=${n} UNION SELECT 1 FROM password_logins WHERE username=${n} LIMIT 1`
  return !r
}

/** Called at sign-up (after the wallet key signed the registration challenge). */
export async function storeBackup(p: { username: string; wallet: Address; authProof: string; vault: unknown }) {
  const username = normUsername(p.username)
  if (!/^[0-9a-f]{64}$/.test(p.authProof)) throw new UserError('invalid login proof')
  const salt = randomBytes(16).toString('hex')
  try {
    await sql`INSERT INTO password_logins (username, wallet, vault, auth_salt, auth_hash, key_id)
              VALUES (${username}, ${p.wallet.toLowerCase()}, ${sql.json(p.vault as any)}, ${salt}, ${hash(p.authProof, salt)}, ${p.wallet.toLowerCase()})`
  } catch (e: any) {
    if (String(e?.code) === '23505') throw new UserError('that username is taken', 409)
    throw e
  }
}

/** Returns the encrypted vault (never decryptable by KEYKARD) if the login proof matches. Rate-limited. */
export async function fetchVault(p: { username: string; authProof: string }) {
  const username = normUsername(p.username)
  const [r] = await sql`SELECT * FROM password_logins WHERE username=${username}`
  // same work and same error for unknown users and wrong passwords
  const salt = r?.auth_salt ?? 'x'.repeat(32)
  const got = Buffer.from(hash(p.authProof, salt), 'hex')
  if (!r) throw new UserError('wrong username or password', 401)
  if (r.locked_until && new Date(r.locked_until) > new Date()) throw new UserError('too many attempts, try again in 15 minutes', 429)
  const want = Buffer.from(r.auth_hash, 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    const fails = r.failed_attempts + 1
    await sql`UPDATE password_logins SET failed_attempts=${fails},
              locked_until=${fails >= 5 ? new Date(Date.now() + 15 * 60_000) : null} WHERE username=${username}`
    throw new UserError('wrong username or password', 401)
  }
  await sql`UPDATE password_logins SET failed_attempts=0, locked_until=NULL WHERE username=${username}`
  // keyId: the key this vault holds (the wallet's root for older accounts, an admin key after a reset)
  return { wallet: r.wallet as Address, keyId: (r.key_id ?? r.wallet) as Address, vault: r.vault }
}

export { mintSession }
