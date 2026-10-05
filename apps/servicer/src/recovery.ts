import { randomBytes } from 'node:crypto'
import { keccak256, stringToHex, type Address, type Hex } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { env, net } from './config'
import { clientFor, treasury } from './chain'
import { audit, sql } from './db'
import { UserError, syncSpendKeys, webAuthnKeyId } from './lines'
import { verifyKeyRegistration } from './auth'
import { normUsername } from './passwordlogin'
import { addAdminCall, isAdminOnChain, readPasskey, recoverySigner, revokeCall, setPasswordLogin } from './credentials'
import { startSelfSession } from './self'

/**
 * "I lost my password AND my passkey." Access to the SAME wallet comes back like this:
 *   1. On a new device the user picks a new password (and optionally a new passkey). The keys are made there;
 *      KEYKARD only ever sees the new password key's ciphertext.
 *   2. They verify with Self. The passport must be the one already linked to the account (same nullifier).
 *   3. A waiting period starts. The account shows "Recovery in progress": if the real owner still has any key, they
 *      cancel it from their own device.
 *   4. When it ends, KEYKARD's recovery key (an admin key the user approved at sign-up) adds the new keys to the
 *      wallet and removes the old password key and passkeys, in one transaction anyone can see on the explorer.
 * The recovery key can do nothing else, and the user can turn it off (fully self-custodial) in Settings.
 */
const lower = (a: string) => a.toLowerCase() as Address
export const recoveryDelaySeconds = () => env.RECOVERY_DELAY_SECONDS ?? (net.name === 'mainnet' ? 48 * 3600 : 300)

export async function startRecovery(p: {
  username: string
  password: { keyRegistration: { challengeId: string; address: Address; signature: Hex }; authProof: string; vault: unknown }
  passkey?: unknown
}) {
  const username = normUsername(p.username)
  const [user] = await sql`SELECT wallet, role FROM users WHERE username=${username}`
  if (!user) throw new UserError('no KEYKARD account with that username', 404)
  const [att] = await sql`SELECT nullifier_hash FROM attestations WHERE wallet=${user.wallet}`
  if (!att) throw new UserError('this account never verified with Self, so it can’t be recovered with Self')
  if (!(await recoverySigner(user.wallet))) throw new UserError('account recovery is turned off for this account')
  const pw = await verifyKeyRegistration({ ...p.password.keyRegistration, signature: p.password.keyRegistration.signature })
  if (!/^[0-9a-f]{64}$/.test(p.password.authProof)) throw new UserError('invalid login proof')
  let passkey: { id: string; publicKey: Hex } | null = null
  if (p.passkey) {
    const v = readPasskey(p.passkey)
    passkey = { id: v.credentialId, publicKey: v.publicKey }
  }
  // a newer request replaces one that hasn't been verified yet; one in its waiting period must be finished or cancelled
  const [open] = await sql`SELECT status FROM recoveries WHERE wallet=${user.wallet} AND status IN ('awaiting_self','waiting')`
  if (open?.status === 'waiting') throw new UserError('a recovery is already in progress for this account')
  await sql`UPDATE recoveries SET status='cancelled', updated_at=now() WHERE wallet=${user.wallet} AND status='awaiting_self'`

  const id = randomBytes(18).toString('base64url')
  const self = await startSelfSession(user.wallet, user.role === 'merchant' ? 'borrower' : user.role, { purpose: 'recovery', recoveryId: id })
  await sql`INSERT INTO recoveries (id, wallet, self_session_id, new_password_key, new_vault, new_auth_proof, new_passkey_id, new_passkey_public_key)
            VALUES (${id}, ${user.wallet}, ${self.sessionId}, ${lower(pw.address)}, ${sql.json(p.password.vault as any)}, ${p.password.authProof},
                    ${passkey?.id ?? null}, ${passkey?.publicKey.toLowerCase() ?? null})`
  await audit({ actor: 'borrower', action: 'recovery.started', detail: { wallet: user.wallet } })
  return { recoveryId: id, verificationUrl: self.verificationUrl }
}

/** Called by the Self webhook for a recovery session: the passport must be the one on the account. */
export async function onRecoveryVerified(recoveryId: string, nullifier: string | null, valid: boolean) {
  const [r] = await sql`SELECT * FROM recoveries WHERE id=${recoveryId}`
  if (!r || r.status !== 'awaiting_self') return
  const [att] = await sql`SELECT nullifier_hash FROM attestations WHERE wallet=${r.wallet}`
  const matches = valid && nullifier && att && keccak256(stringToHex(nullifier)) === att.nullifier_hash
  if (!matches) {
    await sql`UPDATE recoveries SET status='failed', error=${valid ? 'passport_mismatch' : 'not_verified'}, updated_at=now() WHERE id=${recoveryId}`
    await audit({ actor: 'servicer', action: 'recovery.failed', detail: { wallet: r.wallet, reason: valid ? 'passport_mismatch' : 'not_verified' } })
    return
  }
  const readyAt = new Date(Date.now() + recoveryDelaySeconds() * 1000)
  await sql`UPDATE recoveries SET status='waiting', ready_at=${readyAt}, updated_at=now() WHERE id=${recoveryId}`
  await audit({ actor: 'servicer', action: 'recovery.verified', detail: { wallet: r.wallet, readyAt } })
}

export async function recoveryStatus(id: string) {
  const [r] = await sql`SELECT r.status, r.ready_at, r.error, u.username FROM recoveries r JOIN users u ON u.wallet=r.wallet WHERE r.id=${id}`
  if (!r) throw new UserError('recovery not found', 404)
  return { status: r.status as string, readyAt: r.ready_at, error: r.error as string | null, username: r.username as string }
}

/** The owner, signed in with a key they still have, stops a recovery they didn't start. */
export async function cancelRecovery(wallet: Address) {
  const r = await sql`UPDATE recoveries SET status='cancelled', updated_at=now() WHERE wallet=${lower(wallet)} AND status IN ('awaiting_self','waiting') RETURNING id`
  if (r.length === 0) throw new UserError('no recovery in progress', 404)
  await audit({ actor: 'borrower', action: 'recovery.cancelled', detail: { wallet } })
  return { ok: true }
}

/** Scheduler: finish recoveries whose waiting period is over. */
export async function completeRecoveries() {
  const ready = await sql`SELECT * FROM recoveries WHERE status='waiting' AND ready_at <= now() ORDER BY ready_at LIMIT 10`
  for (const r of ready) {
    try {
      await completeOne(r)
    } catch (e: any) {
      const error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)
      console.error('[recovery] failed', r.id, error)
      await sql`UPDATE recoveries SET error=${error}, updated_at=now() WHERE id=${r.id}`
    }
  }
}

async function completeOne(r: any) {
  const wallet = lower(r.wallet)
  const signer = await recoverySigner(wallet)
  if (!signer) throw new Error('recovery key is gone')
  const old = await sql`SELECT * FROM credentials WHERE wallet=${wallet} AND status='active' AND kind IN ('password','passkey')`
  const newPw = lower(r.new_password_key)
  const newPasskey = r.new_passkey_public_key ? { keyId: lower(webAuthnKeyId(r.new_passkey_public_key as Hex, wallet)), id: r.new_passkey_id, publicKey: r.new_passkey_public_key } : null

  // one transaction, signed by the recovery key: add the new keys, remove the old admin keys (roots are retired)
  let txHash: string | null = r.completed_tx ?? null
  if (!(await isAdminOnChain(wallet, newPw))) {
    const calls = [
      addAdminCall(newPw, 'secp256k1'),
      ...(newPasskey ? [addAdminCall(newPasskey.keyId, 'webAuthn')] : []),
      ...old.filter((c) => !c.is_root).map((c) => revokeCall(c.key_id)),
    ]
    const receipt = (await sendTransactionSync(clientFor(signer.account), { calls, feePayer: treasury } as any)) as any
    if (receipt.status !== 'success') throw new Error(`recovery transaction reverted ${receipt.transactionHash}`)
    txHash = receipt.transactionHash
    await sql`UPDATE recoveries SET completed_tx=${txHash} WHERE id=${r.id}`
  }
  if (!(await isAdminOnChain(wallet, newPw))) throw new Error('new password key not on the wallet')

  const [user] = await sql`SELECT username FROM users WHERE wallet=${wallet}`
  await sql.begin(async (t) => {
    for (const c of old) await t`UPDATE credentials SET status=${c.is_root ? 'retired' : 'revoked'}, updated_at=now() WHERE id=${c.id}`
    await t`INSERT INTO credentials (wallet, kind, key_id, status) VALUES (${wallet}, 'password', ${newPw}, 'active')
            ON CONFLICT (wallet, key_id) DO UPDATE SET status='active', updated_at=now()`
    if (newPasskey) {
      await t`INSERT INTO credentials (wallet, kind, key_id, passkey_id, public_key, status)
              VALUES (${wallet}, 'passkey', ${newPasskey.keyId}, ${newPasskey.id}, ${newPasskey.publicKey}, 'active')
              ON CONFLICT (wallet, key_id) DO UPDATE SET status='active', passkey_id=EXCLUDED.passkey_id, public_key=EXCLUDED.public_key, updated_at=now()`
    }
    await setPasswordLogin({ username: user.username, wallet, keyId: newPw, authProof: r.new_auth_proof, vault: r.new_vault }, t)
    await t`UPDATE recoveries SET status='completed', error=NULL, new_auth_proof='', updated_at=now() WHERE id=${r.id}`
  })
  await audit({ actor: 'servicer', action: 'recovery.completed', detail: { wallet }, txHash })
  await syncSpendKeys(wallet).catch((e) => console.error('[recovery] card key sync failed', e?.shortMessage ?? e?.message ?? e))
}
