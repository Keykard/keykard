import { encodeFunctionData, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Abis, Account, Actions } from 'viem/tempo'
import { ACCOUNT_KEYCHAIN } from '@keycard/sdk'
import { env, net } from './config'
import { getKey, publicClient } from './chain'
import { audit, sql } from './db'
import { UserError, syncSpendKeys, webAuthnKeyId } from './lines'
import { verifyKeyRegistration, verifyRegistration } from './auth'
import { normUsername } from './passwordlogin'
import { open, seal } from './vault'
import { randomBytes, scryptSync } from 'node:crypto'

/**
 * Every key on a KEYKARD wallet, and the only place keys are added or removed.
 *
 *   password  secp256k1, encrypted on the user's device with their password (KEYKARD only stores the ciphertext)
 *   passkey   WebAuthn (fingerprint / face)
 *   recovery  KEYKARD-held, used only by recovery.ts after Self re-verification + a waiting period
 *
 * New accounts: the password key is the wallet's root; passkey and recovery keys are Tempo admin keys (TIP-1049),
 * so each can restore the others on the SAME wallet. KEYKARD builds the keychain calls; the user's own key sends
 * them in ONE fee-sponsored transaction; confirm() then checks the result on-chain before anything is recorded.
 */
const lower = (a: string) => a.toLowerCase() as Address
const SIG = { secp256k1: 0, p256: 1, webAuthn: 2 } as const
const NO_WITNESS = `0x${'0'.repeat(64)}` as Hex

export const addAdminCall = (keyId: Address, type: keyof typeof SIG) => ({
  to: ACCOUNT_KEYCHAIN as Address,
  data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'authorizeAdminKey', args: [keyId, SIG[type], NO_WITNESS] } as any),
})
export const revokeCall = (keyId: Address) => ({
  to: ACCOUNT_KEYCHAIN as Address,
  data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [keyId] } as any),
})

export const isAdminOnChain = (account: Address, keyId: Address) =>
  (Actions.accessKey as any).isAdmin(publicClient, { account, accessKey: keyId }) as Promise<boolean>

const hashProof = (proof: string, salt: string) => scryptSync(proof, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')

/** Store (or replace) the encrypted password vault a username signs in with. */
export async function setPasswordLogin(p: { username: string; wallet: Address; keyId: Address; authProof: string; vault: unknown }, t: any = sql) {
  if (!/^[0-9a-f]{64}$/.test(p.authProof)) throw new UserError('invalid login proof')
  const username = normUsername(p.username)
  const salt = randomBytes(16).toString('hex')
  await t`INSERT INTO password_logins (username, wallet, vault, auth_salt, auth_hash, key_id)
          VALUES (${username}, ${lower(p.wallet)}, ${sql.json(p.vault as any)}, ${salt}, ${hashProof(p.authProof, salt)}, ${lower(p.keyId)})
          ON CONFLICT (username) DO UPDATE SET wallet=EXCLUDED.wallet, vault=EXCLUDED.vault, auth_salt=EXCLUDED.auth_salt,
            auth_hash=EXCLUDED.auth_hash, key_id=EXCLUDED.key_id, failed_attempts=0, locked_until=NULL`
}

export async function activeCredentials(wallet: Address) {
  return sql`SELECT * FROM credentials WHERE wallet=${lower(wallet)} AND status='active' ORDER BY id`
}

/** What the sign-in screen needs to know about a username (public: usernames are shown on cards anyway). */
export async function accountInfo(username: string) {
  let u: string
  try {
    u = normUsername(username)
  } catch {
    return { exists: false as const }
  }
  const [user] = await sql`SELECT wallet, role, recovery_opt_out FROM users WHERE username=${u}`
  if (!user) return { exists: false as const }
  const creds = await activeCredentials(user.wallet)
  const [att] = await sql`SELECT 1 FROM attestations WHERE wallet=${user.wallet}`
  return {
    exists: true as const,
    wallet: user.wallet as Address, // public anyway (on-chain); lets sign-in ask for ONE passkey signature
    role: user.role as string,
    hasPassword: creds.some((c) => c.kind === 'password'),
    passkeys: creds.filter((c) => c.kind === 'passkey').map((c) => ({ id: c.passkey_id as string })),
    // "lost both" needs a verified passport on file and the recovery key on the wallet
    recovery: Boolean(att) && creds.some((c) => c.kind === 'recovery'),
  }
}

export async function securityView(wallet: Address) {
  const creds = await activeCredentials(wallet)
  const [u] = await sql`SELECT recovery_opt_out, username FROM users WHERE wallet=${lower(wallet)}`
  const [rec] = await sql`SELECT id, status, ready_at, created_at FROM recoveries WHERE wallet=${lower(wallet)} AND status IN ('awaiting_self','waiting') ORDER BY created_at DESC LIMIT 1`
  return {
    hasPassword: creds.some((c) => c.kind === 'password'),
    passkeys: creds.filter((c) => c.kind === 'passkey').map((c) => ({ id: Number(c.id), passkeyId: c.passkey_id, root: c.is_root, addedAt: c.created_at })),
    recoveryOn: creds.some((c) => c.kind === 'recovery'),
    recoveryKeyId: creds.find((c) => c.kind === 'recovery')?.id ? Number(creds.find((c) => c.kind === 'recovery')!.id) : null,
    recoveryOptOut: Boolean(u?.recovery_opt_out),
    openRecovery: rec ? { id: rec.id, status: rec.status, readyAt: rec.ready_at, startedAt: rec.created_at } : null,
  }
}

/**
 * A passkey being added: a WebAuthn registration verified server-side. Testnet API tests (no browser) may pass a raw
 * public key instead when ALLOW_UNVERIFIED_REGISTRATION=1, the same switch sign-up already honours; never on mainnet.
 */
export function readPasskey(p: any): { credentialId: string; publicKey: Hex } {
  if (p?.unverified) {
    if (env.ALLOW_UNVERIFIED_REGISTRATION !== '1' || net.name === 'mainnet') throw new UserError('passkey registration required', 400)
    return { credentialId: String(p.unverified.id), publicKey: p.unverified.publicKey as Hex }
  }
  const v = verifyRegistration(p)
  return { credentialId: v.credentialId, publicKey: v.publicKey }
}

type PasswordIn = { keyRegistration: { challengeId: string; address: Address; signature: Hex }; authProof: string; vault: unknown }
type PasskeyIn = { challengeId: string; credential: unknown } | { unverified: { id: string; publicKey: Hex } }

/**
 * Prepare a key change for the signed-in wallet: add a password key, a passkey and/or the recovery key, and
 * optionally retire existing credentials. Returns the keychain calls the user's key must send (one transaction).
 */
export async function prepareChange(wallet: Address, p: { password?: PasswordIn; passkey?: PasskeyIn; recovery?: boolean; remove?: number[] }) {
  wallet = lower(wallet)
  const [user] = await sql`SELECT wallet, username FROM users WHERE wallet=${wallet}`
  if (!user) throw new UserError('unknown account', 404)
  // a fresh change replaces any half-finished one
  await sql`DELETE FROM credentials WHERE wallet=${wallet} AND status='pending'`
  const active = await activeCredentials(wallet)
  const calls: { to: Address; data: Hex }[] = []

  if (p.password) {
    if (!user.username) throw new UserError('choose a username first')
    const v = await verifyKeyRegistration({ ...p.password.keyRegistration, signature: p.password.keyRegistration.signature })
    const keyId = lower(v.address)
    if (!/^[0-9a-f]{64}$/.test(p.password.authProof)) throw new UserError('invalid login proof')
    // the vault and login proof wait on the pending row; they only replace the live login once the key is on-chain
    await sql`INSERT INTO credentials (wallet, kind, key_id, pending, status)
              VALUES (${wallet}, 'password', ${keyId}, ${sql.json({ vault: p.password.vault, authProof: p.password.authProof } as any)}, 'pending')
              ON CONFLICT (wallet, key_id) DO UPDATE SET status='pending', pending=EXCLUDED.pending, updated_at=now()`
    calls.push(addAdminCall(keyId, 'secp256k1'))
  }
  if (p.passkey) {
    const v = readPasskey(p.passkey)
    const keyId = lower(webAuthnKeyId(v.publicKey, wallet))
    const [taken] = await sql`SELECT 1 FROM credentials WHERE passkey_id=${v.credentialId} AND status IN ('pending','active')`
    if (taken) throw new UserError('this passkey is already linked to a KEYKARD account', 409)
    await sql`INSERT INTO credentials (wallet, kind, key_id, passkey_id, public_key, status)
              VALUES (${wallet}, 'passkey', ${keyId}, ${v.credentialId}, ${v.publicKey.toLowerCase()}, 'pending')
              ON CONFLICT (wallet, key_id) DO UPDATE SET status='pending', passkey_id=EXCLUDED.passkey_id, public_key=EXCLUDED.public_key, updated_at=now()`
    calls.push(addAdminCall(keyId, 'webAuthn'))
  }
  if (p.recovery && !active.some((c) => c.kind === 'recovery')) {
    const pk = generatePrivateKey()
    const keyId = lower(Account.fromSecp256k1(pk, { access: wallet }).accessKeyAddress)
    await sql`INSERT INTO credentials (wallet, kind, key_id, sealed_key, status) VALUES (${wallet}, 'recovery', ${keyId}, ${seal(pk)}, 'pending')`
    calls.push(addAdminCall(keyId, 'secp256k1'))
  }
  for (const id of p.remove ?? []) {
    const c = active.find((x) => Number(x.id) === id)
    if (!c) throw new UserError('that sign-in method is not on your account', 404)
    const remaining = active.filter((x) => Number(x.id) !== id && x.kind !== 'recovery')
    const adding = Boolean(p.password || p.passkey)
    if (c.kind !== 'recovery' && remaining.length === 0 && !adding) throw new UserError('you need at least one way to sign in')
    if (!c.is_root) calls.push(revokeCall(c.key_id)) // a root key can't be revoked on Tempo: it is retired instead
  }
  await sql`UPDATE users SET recovery_opt_out=false WHERE wallet=${wallet} AND ${Boolean(p.recovery)}`
  return { calls, remove: p.remove ?? [] }
}

/**
 * After the user's key sent the calls: check each pending key really is an admin on-chain and each removed key
 * really is revoked (roots are retired), then make it official, update the password login and the card keys.
 */
export async function confirmChange(wallet: Address, remove: number[] = []) {
  wallet = lower(wallet)
  const pending = await sql`SELECT * FROM credentials WHERE wallet=${wallet} AND status='pending'`
  for (const c of pending) {
    if (!(await isAdminOnChain(wallet, c.key_id))) throw new UserError('the new sign-in method is not on your wallet yet: try again in a moment', 409)
  }
  const active = await activeCredentials(wallet)
  const removing = active.filter((c) => remove.includes(Number(c.id)))
  for (const c of removing) {
    if (c.is_root) continue
    const k = await getKey(wallet, c.key_id)
    if (k.exists && !k.revoked) throw new UserError('the old sign-in method is still on your wallet: try again in a moment', 409)
  }
  const [user] = await sql`SELECT username FROM users WHERE wallet=${wallet}`
  await sql.begin(async (t) => {
    for (const c of pending) {
      if (c.kind === 'password') {
        const { vault, authProof } = c.pending
        await setPasswordLogin({ username: user.username, wallet, keyId: c.key_id, authProof, vault }, t)
        // a new password replaces the old one: retire every other password key
        await t`UPDATE credentials SET status=CASE WHEN is_root THEN 'retired' ELSE 'revoked' END, updated_at=now()
                WHERE wallet=${wallet} AND kind='password' AND status='active' AND id<>${c.id}`
        await t`UPDATE credentials SET pending=NULL, status='active', updated_at=now() WHERE id=${c.id}`
      } else {
        await t`UPDATE credentials SET status='active', updated_at=now() WHERE id=${c.id}`
      }
    }
    for (const c of removing) {
      await t`UPDATE credentials SET status=${c.is_root ? 'retired' : 'revoked'}, updated_at=now() WHERE id=${c.id}`
      if (c.kind === 'recovery') await t`UPDATE users SET recovery_opt_out=true WHERE wallet=${wallet}`
    }
  })
  for (const c of pending) await audit({ actor: 'borrower', action: `credential.added`, detail: { wallet, kind: c.kind } })
  for (const c of removing) await audit({ actor: 'borrower', action: `credential.removed`, detail: { wallet, kind: c.kind } })
  await syncSpendKeys(wallet).catch((e) => console.error('[credentials] card key sync failed', e?.shortMessage ?? e?.message ?? e))
  return securityView(wallet)
}

/** Change the password while signed in (same key, re-encrypted on the device): no on-chain change. */
export async function changePassword(wallet: Address, p: { authProof: string; vault: { address: Address } }) {
  wallet = lower(wallet)
  const [user] = await sql`SELECT username FROM users WHERE wallet=${wallet}`
  const [cur] = await sql`SELECT key_id FROM password_logins WHERE wallet=${wallet} AND username=${user?.username ?? ''}`
  if (!cur) throw new UserError('this account has no password yet', 404)
  if (lower(p.vault.address) !== lower(cur.key_id)) throw new UserError('that is not this account’s password key')
  await setPasswordLogin({ username: user.username, wallet, keyId: cur.key_id, authProof: p.authProof, vault: p.vault })
  await audit({ actor: 'borrower', action: 'password.changed', detail: { wallet } })
  return { ok: true }
}

/** The recovery key as a signer on the wallet (recovery.ts only). */
export async function recoverySigner(wallet: Address) {
  const [c] = await sql`SELECT * FROM credentials WHERE wallet=${lower(wallet)} AND kind='recovery' AND status='active'`
  if (!c) return null
  return { credential: c, account: Account.fromSecp256k1(open(c.sealed_key), { access: lower(wallet) }) }
}
