import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { recoverMessageAddress, verifyMessage, type Address, type Hex } from 'viem'
import { PublicKey, WebAuthnP256 } from 'ox'
import { Credential, Registration } from 'ox/webauthn'
import { Account } from 'viem/tempo'
import { androidAppOrigins, env, passkeyRpId, webOrigins } from './config'
import { sql } from './db'

// Session auth: the client proves control of its passkey by signing a server nonce (WebAuthn assertion).
// Sessions are stateless HMAC tokens: base64url(wallet.expiry).sig

const secret = createHmac('sha256', env.KEY_ENC_SECRET).update('keycard-session-v1').digest()
const challenges = new Map<string, { challenge: Hex; exp: number }>()
const SESSION_TTL = 12 * 3600

/** Wallet address Tempo derives from a WebAuthn P-256 public key (same as the browser). */
export function walletFromPasskey(publicKey: Hex): Address {
  return Account.fromWebAuthnP256({ id: 'x', publicKey } as any).address as Address
}

export function issueChallenge(wallet: Address): Hex {
  const challenge = `0x${randomBytes(32).toString('hex')}` as Hex
  challenges.set(wallet.toLowerCase(), { challenge, exp: Date.now() + 5 * 60_000 })
  return challenge
}

/**
 * Sign-in: the client signs a server nonce with ANY active key on the account: its password key (root or admin,
 * EIP-191) or one of its passkeys (WebAuthn). Retired and revoked keys can't sign in.
 */
export async function verifyAssertion(p: {
  wallet: Address
  metadata?: any
  signature?: { r: string | bigint; s: string | bigint }
  keySignature?: Hex
  credentialId?: string
}): Promise<string> {
  const wallet = p.wallet.toLowerCase() as Address
  const c = challenges.get(wallet)
  if (!c || c.exp < Date.now()) throw new Error('challenge expired')
  const creds = await sql`SELECT * FROM credentials WHERE wallet=${wallet} AND status='active' AND kind IN ('password','passkey')`
  if (creds.length === 0) throw new Error('unknown wallet')
  if (p.keySignature) {
    const signer = (await recoverMessageAddress({ message: { raw: c.challenge }, signature: p.keySignature })).toLowerCase()
    if (!creds.some((k) => k.kind === 'password' && k.key_id.toLowerCase() === signer)) throw new Error('bad signature')
    challenges.delete(wallet)
    return mintSession(wallet)
  }
  if (!p.metadata || !p.signature) throw new Error('passkey assertion required')
  const passkeys = creds.filter((k) => k.kind === 'passkey' && (!p.credentialId || k.passkey_id === p.credentialId))
  const ok = passkeys.some((k) => {
    try {
      return WebAuthnP256.verify({
        metadata: p.metadata,
        challenge: c.challenge,
        publicKey: PublicKey.fromHex(k.public_key as Hex),
        signature: { r: BigInt(p.signature!.r), s: BigInt(p.signature!.s) },
      } as any)
    } catch {
      return false
    }
  })
  if (!ok) throw new Error('bad signature')
  challenges.delete(wallet)
  return mintSession(wallet)
}

export function mintSession(wallet: Address): string {
  const body = Buffer.from(`${wallet.toLowerCase()}.${Math.floor(Date.now() / 1000) + SESSION_TTL}`).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function readSession(token: string | undefined): Address | null {
  if (!token) return null
  const [body, sig] = token.replace(/^Bearer\s+/i, '').split('.')
  if (!body || !sig) return null
  const want = createHmac('sha256', secret).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  const [wallet, exp] = Buffer.from(body, 'base64url').toString().split('.')
  if (Number(exp) < Date.now() / 1000) return null
  return wallet as Address
}

// ---------------- registration (sign-up = one passkey prompt) ----------------
const regChallenges = new Map<string, { challenge: Hex; exp: number }>()

export function issueRegistrationChallenge() {
  const id = randomBytes(16).toString('base64url')
  const challenge = `0x${randomBytes(32).toString('hex')}` as Hex
  regChallenges.set(id, { challenge, exp: Date.now() + 5 * 60_000 })
  return { id, challenge }
}

/**
 * Verifies a WebAuthn registration server-side (challenge, origin, rpId, user verification) and returns
 * the VERIFIED public key. The client-supplied key is never trusted.
 */
export function verifyRegistration(p: { challengeId: string; credential: any }): { publicKey: Hex; credentialId: string } {
  const c = regChallenges.get(p.challengeId)
  if (!c || c.exp < Date.now()) throw new Error('registration challenge expired')
  regChallenges.delete(p.challengeId)
  // web: the rpId is the page's host; native Android app: its apk-key-hash origin with the web domain as rpId
  const candidates = [
    ...webOrigins.map((origin) => ({ origin, rpId: new URL(origin).hostname })),
    ...androidAppOrigins.map((origin) => ({ origin, rpId: passkeyRpId })),
  ]
  const cred = Credential.deserialize(p.credential)
  let lastErr: unknown
  for (const { origin, rpId } of candidates) {
    try {
      const r = Registration.verify({
        credential: cred as any,
        challenge: c.challenge,
        origin,
        rpId,
      } as any) as any
      return { publicKey: PublicKey.toHex(r.credential.publicKey) as Hex, credentialId: r.credential.id ?? cred.id }
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`passkey registration could not be verified: ${String((lastErr as any)?.message ?? lastErr)}`)
}

/** Password-wallet registration: the device key signs the registration challenge (EIP-191). */
export async function verifyKeyRegistration(p: { challengeId: string; address: Address; signature: Hex }) {
  const c = regChallenges.get(p.challengeId)
  if (!c || c.exp < Date.now()) throw new Error('registration challenge expired')
  regChallenges.delete(p.challengeId)
  const ok = await verifyMessage({ address: p.address, message: { raw: c.challenge }, signature: p.signature })
  if (!ok) throw new Error('registration signature invalid')
  return { address: p.address.toLowerCase() as Address }
}
