import type { Address, Hex } from 'viem'
import { Account, Actions } from 'viem/tempo'
import { KeyAuthorization } from 'ox/tempo'
import { Selectors } from 'viem/tempo'
import { net } from './config'
import { clientFor, getKey, remainingLimit, sendWithBackoff, treasury, verifyKeyPolicy } from './chain'
import { UserError } from './lines'
import { open } from './vault'

/**
 * One-signature key grants. The user's wallet signs ONLY a key authorization (one passkey prompt / one
 * password unlock). KEYKARD verifies it matches the agreed terms exactly, then activates it on-chain with a
 * zero-value transfer signed BY THE NEW KEY carrying the authorization (Tempo allows a key to be used in the
 * same tx that authorizes it). Fee sponsored by the treasury. Verified on testnet 2026-09-29.
 */
const lower = (a: string) => a.toLowerCase()

export function checkKeyAuthorization(
  serialized: Hex,
  expect: { keyId: Address; expiry: number; limit: bigint; period: number; recipients: Address[] },
) {
  let ka: any
  try {
    ka = KeyAuthorization.deserialize(serialized as any)
  } catch {
    throw new UserError('malformed key authorization')
  }
  const fail = (why: string): never => {
    throw new UserError(`signed permission does not match the agreed terms: ${why}`)
  }
  if (lower(ka.address ?? '') !== lower(expect.keyId)) fail('key')
  if (ka.type !== 'secp256k1') fail('key type')
  if (ka.chainId !== undefined && Number(ka.chainId) !== net.chainId) fail('chain')
  if (Number(ka.expiry) !== expect.expiry) fail('expiry')
  if (ka.admin) fail('admin keys are not allowed')
  const limits = ka.limits ?? []
  if (limits.length !== 1) fail('limits')
  const l = limits[0]
  if (lower(l.token) !== lower(net.token)) fail('token')
  if (BigInt(l.limit) !== expect.limit) fail('amount')
  if (Number(l.period ?? 0) !== expect.period) fail('period')
  const scopes = ka.scopes ?? []
  if (scopes.length === 0) fail('unscoped key')
  const allowedSelectors = new Set([lower(Selectors.tip20.transfer), lower(Selectors.tip20.transferWithMemo)])
  const want = new Set(expect.recipients.map(lower))
  for (const s of scopes) {
    if (lower(s.address) !== lower(net.token)) fail('call target')
    if (!s.selector || !allowedSelectors.has(lower(s.selector))) fail('function')
    const rec: string[] = s.recipients ?? []
    if (rec.length === 0) fail('recipient allow-list')
    for (const r of rec) if (!want.has(lower(r))) fail('recipient')
  }
  return ka
}

/** Submit the authorization on-chain using the new key itself (held by KEYKARD). Idempotent. */
export async function activateKeyAuthorization(p: { owner: Address; keyId: Address; sealedKey: string; ka: any }) {
  if ((await getKey(p.owner, p.keyId)).exists) return null
  const key = Account.fromSecp256k1(open(p.sealedKey), { access: p.owner })
  // a rate-limited send is rejected before broadcast, so retrying it is safe
  const r = (await sendWithBackoff(() =>
    Actions.token.transferSync(clientFor(key), {
      token: net.token,
      to: treasury.address,
      amount: 0n,
      keyAuthorization: p.ka,
      feePayer: treasury,
    } as any),
  )) as any
  if (r.receipt.status !== 'success') throw new UserError('could not activate permission on-chain', 502)
  return r.receipt.transactionHash as Hex
}

/**
 * Accept a permission either way it can arrive:
 *   - `keyAuthorization` signed by the wallet's ROOT key: checked against the terms, then activated by KEYKARD; or
 *   - nothing: the user's ADMIN key (a passkey, or a reset password) already sent the authorization itself, because
 *     Tempo requires an admin-signed authorization to travel in a transaction that same admin signs. Then the key
 *     must already be on-chain with exactly the agreed terms.
 */
export async function acceptGrant(p: {
  owner: Address
  keyId: Address
  sealedKey: string
  keyAuthorization?: Hex
  expect: { expiry: number; limit: bigint; period: number; recipients: Address[] }
}) {
  if (p.keyAuthorization) {
    const ka = checkKeyAuthorization(p.keyAuthorization, { keyId: p.keyId, ...p.expect })
    return activateKeyAuthorization({ owner: p.owner, keyId: p.keyId, sealedKey: p.sealedKey, ka })
  }
  const k = await getKey(p.owner, p.keyId)
  if (!k.exists || k.revoked) throw new UserError('the permission is not on your wallet yet: try again in a moment', 409)
  if (Number(k.expiry) !== p.expect.expiry) throw new UserError('signed permission does not match the agreed terms: expiry')
  const v = await verifyKeyPolicy({ account: p.owner, keyId: p.keyId, recipients: p.expect.recipients })
  if (!v.ok) throw new UserError(`signed permission does not match the agreed terms: ${v.reason}`)
  const lim = await remainingLimit(p.owner, p.keyId)
  if (lim.remaining !== p.expect.limit) throw new UserError('signed permission does not match the agreed terms: amount')
  return null
}
