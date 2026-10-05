'use client'

import { createClient, encodeFunctionData, erc20Abi, http, type Address, type Hex } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { privateKeyToAccount } from 'viem/accounts'
import { Account, Actions, WebAuthnP256, withRelay } from 'viem/tempo'
import { PublicKey, WebAuthnP256 as OxWebAuthn } from 'ox'
import { Credential, Registration } from 'ox/webauthn'
import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import { collateralVaultAbi, encodePayMemo, guaranteeKeyPolicy, mandateKeyPolicy } from '@keycard/sdk'
import { api, API_URL, getConfig, setToken, type AppConfig } from './api'
import { askPassword, deviceVault, forgetDeviceKey, lockDeviceKey, unlockDeviceKey, unlockedDeviceKey } from './devicekey'

/**
 * The KEYKARD wallet is a Tempo account with up to three keys (TIP-1049 admin keys, see the servicer's credentials.ts):
 *   - a password key: a secp256k1 key encrypted on this device with the user's password (devicekey.ts). The wallet's
 *     root for new accounts; an admin key after a password reset;
 *   - a passkey (fingerprint / face): an admin key, or the root for accounts created passkey-first;
 *   - KEYKARD's recovery key, used only after a passport re-check and a waiting period (never on this device).
 * Every sign-in key is also a card key on the KEYKARD credit account. KEYKARD's relay pays every network fee.
 */
const CRED_KEY = 'keycard.passkey'
const LAST_USER = 'keycard.lastUsername'
/** A passkey this browser can sign with, and the wallet it belongs to. */
export type StoredCred = { id: string; publicKey: Hex; wallet?: Address; root?: boolean }
export type Signer =
  | { kind: 'passkey'; wallet: Address; cred: StoredCred; root: boolean }
  | { kind: 'password'; wallet: Address; address: Address; pk: Hex; root: boolean }

export const rpId = () => window.location.hostname

export function storedCredential(): StoredCred | null {
  try {
    const s = localStorage.getItem(CRED_KEY)
    return s ? (JSON.parse(s) as StoredCred) : null
  } catch {
    return null
  }
}
export function storeCredential(c: StoredCred | null) {
  try {
    if (c) localStorage.setItem(CRED_KEY, JSON.stringify(c))
    else localStorage.removeItem(CRED_KEY)
  } catch {}
}
export function lastUsername(): string {
  try {
    return localStorage.getItem(LAST_USER) ?? ''
  } catch {
    return ''
  }
}
export function rememberUsername(u: string) {
  try {
    localStorage.setItem(LAST_USER, u)
  } catch {}
}

const lower = (a: string) => a.toLowerCase() as Address

/** The password key on this device as a signer (asks for the password once per session if it's locked). */
export async function passwordSigner(reason?: string): Promise<Signer & { kind: 'password' }> {
  const v = deviceVault()
  if (!v) throw new Error('No password wallet on this device. Sign in again.')
  let k = unlockedDeviceKey()
  if (!k) {
    const pw = await askPassword(reason)
    if (pw === null) throw new Error('Password entry cancelled.')
    k = await unlockDeviceKey(pw)
  }
  const wallet = lower(v.wallet ?? v.address)
  return { kind: 'password', wallet, address: lower(k.address), pk: k.pk, root: lower(k.address) === wallet }
}

/** The signer on this device: the passkey if there is one (one tap), otherwise the password key. */
export async function getSigner(): Promise<Signer> {
  const cred = storedCredential()
  if (cred?.wallet) return { kind: 'passkey', wallet: lower(cred.wallet), cred, root: cred.root ?? false }
  if (deviceVault()) return passwordSigner()
  throw new Error('No KEYKARD wallet on this device. Sign in again.')
}
export const hasLocalWallet = () => Boolean(storedCredential()?.wallet || deviceVault())

/** A WebAuthn registration against a server challenge (verified server-side). Nothing is stored yet. */
export async function registerPasskey(username: string): Promise<{ cred: StoredCred; registration: { challengeId: string; credential: unknown } }> {
  const { id: challengeId, challenge } = await api<{ id: string; challenge: Hex }>('/api/auth/register-challenge', { auth: false })
  // user.name = the KEYKARD username: shown in iOS/Android passkey pickers as "<username> · KEYKARD"
  const credential = await Registration.create({ name: username, challenge, rp: { id: rpId(), name: 'KEYKARD' } } as any)
  const serialized = Credential.serialize(credential as any)
  return { cred: { id: (credential as any).id as string, publicKey: serialized.publicKey as Hex }, registration: { challengeId, credential: serialized } }
}

/** A new password key proves possession by signing a server challenge (used at sign-up, reset and recovery). */
export async function registrationForDeviceKey(k: { address: Address; pk: Hex }) {
  const { id: challengeId, challenge } = await api<{ id: string; challenge: Hex }>('/api/auth/register-challenge', { auth: false })
  const signature = await privateKeyToAccount(k.pk).signMessage({ message: { raw: challenge } })
  return { challengeId, address: k.address, signature }
}

/**
 * Passkey sign-in in ONE prompt when we know the account (identifier-first): sign the server challenge with any of
 * the account's passkeys. Without a username, the browser's own picker chooses the passkey (two prompts).
 */
export async function signInWithPasskey(account?: { wallet: Address; passkeys: { id: string }[] }) {
  if (account) {
    const { challenge } = await api<{ challenge: Hex }>('/api/auth/challenge', { body: { wallet: account.wallet }, auth: false })
    const { metadata, signature, raw } = await OxWebAuthn.sign({ challenge, credentialId: account.passkeys.map((p) => p.id), rpId: rpId() } as any)
    const { token } = await api<{ token: string }>('/api/auth/verify', {
      auth: false,
      body: { wallet: account.wallet, metadata, signature: { r: signature.r.toString(), s: signature.s.toString() }, credentialId: (raw as any).id },
    })
    const k = await api<{ wallet: Address; publicKey: Hex; root: boolean }>(`/api/passkeys/${encodeURIComponent((raw as any).id)}`, { auth: false })
    storeCredential({ id: (raw as any).id, publicKey: k.publicKey, wallet: lower(k.wallet), root: k.root })
    setToken(token)
    return token
  }
  let found: { wallet: Address; root: boolean; username: string } | null = null
  const cred = await WebAuthnP256.getCredential({
    rpId: rpId(),
    async getPublicKey(credential: { id: string }) {
      const r = await api<{ publicKey: Hex; wallet: Address; root: boolean; username: string }>(`/api/passkeys/${encodeURIComponent(credential.id)}`, { auth: false })
      found = r
      return r.publicKey
    },
  } as any)
  const f = found as unknown as { wallet: Address; root: boolean; username: string }
  const c: StoredCred = { id: (cred as any).id, publicKey: (cred as any).publicKey as Hex, wallet: lower(f.wallet), root: f.root }
  storeCredential(c)
  if (f.username) rememberUsername(f.username)
  return signIn({ kind: 'passkey', wallet: c.wallet!, cred: c, root: Boolean(c.root) })
}

export function signOut() {
  storeCredential(null)
  lockDeviceKey()
  setToken(null)
}

/** Forget everything KEYKARD stored in this browser (session, passkey reference, password wallet). */
export function startOver() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('keycard.')) localStorage.removeItem(k)
  } catch {}
  forgetDeviceKey()
  setToken(null)
}

/** The signer acting on the user's own wallet: as its root, or as an admin key. */
export function rootAccount(s: Signer) {
  if (s.kind === 'password') return s.root ? Account.fromSecp256k1(s.pk) : Account.fromSecp256k1(s.pk, { access: s.wallet })
  return s.root ? Account.fromWebAuthnP256({ id: s.cred.id, publicKey: s.cred.publicKey }, { rpId: rpId() }) : accessKeyAccount(s, s.wallet)
}

/** The signer acting as an access key on another account (the credit account = the card), or as an admin key. */
export function accessKeyAccount(s: Signer, parent: Address) {
  if (s.kind === 'password') return Account.fromSecp256k1(s.pk, { access: parent })
  const publicKey = PublicKey.fromHex(s.cred.publicKey)
  return Account.from({
    access: parent,
    keyType: 'webAuthn',
    publicKey,
    async sign({ hash }: { hash: Hex }) {
      const { metadata, signature } = await OxWebAuthn.sign({ challenge: hash, credentialId: s.cred.id, rpId: rpId() })
      return SignatureEnvelope.serialize({ publicKey, metadata, signature, type: 'webAuthn' } as any)
    },
  } as any)
}

async function relayClient(account: any, cfg?: AppConfig) {
  const config = cfg ?? (await getConfig())
  const { tempo, tempoModerato } = await import('viem/chains')
  const base = config.network === 'mainnet' ? tempo : tempoModerato
  const chain = base.extend({ feeToken: config.token })
  return createClient({
    account,
    chain,
    // chain reads/sends go through the KEYKARD RPC proxy (CORS + retries for reads); fees via the relay
    transport: withRelay(http(`${API_URL}/rpc`), http(`${API_URL}/relay`), { policy: 'sign-only' }),
  })
}

/**
 * Passkey-signed transactions can take a long time to approve (Face ID, or a phone QR hand-off). viem's
 * default for fee-sponsored txs is an EXPIRING nonce valid ~25s; a fresh random 2D nonce lane has no expiry.
 */
function slowSignerNonce() {
  const r = crypto.getRandomValues(new Uint8Array(24))
  let key = 1n
  for (const b of r) key = (key << 8n) | BigInt(b)
  return { nonceKey: key, nonce: 0 }
}

/** Proves control of the wallet to the KEYKARD server; stores the session token. */
export async function signIn(s: Signer) {
  const { challenge } = await api<{ challenge: Hex }>('/api/auth/challenge', { body: { wallet: s.wallet }, auth: false })
  let body: any
  if (s.kind === 'passkey') {
    const { metadata, signature } = await OxWebAuthn.sign({ challenge, credentialId: s.cred.id, rpId: rpId() })
    body = { wallet: s.wallet, metadata, signature: { r: signature.r.toString(), s: signature.s.toString() }, credentialId: s.cred.id }
  } else {
    body = { wallet: s.wallet, keySignature: await privateKeyToAccount(s.pk).signMessage({ message: { raw: challenge } }) }
  }
  const { token } = await api<{ token: string }>('/api/auth/verify', { auth: false, body })
  setToken(token)
  return token
}

/** Send keychain calls KEYKARD prepared (add / remove sign-in keys), signed by one of the user's keys, fee sponsored. */
export async function sendKeyCalls(s: Signer, calls: { to: Address; data: Hex }[]) {
  if (calls.length === 0) return null
  const client = await relayClient(rootAccount(s))
  const r = (await sendTransactionSync(client, { calls, feePayer: true, ...slowSignerNonce() } as any)) as any
  if (r.status !== 'success') throw new Error('Your wallet didn’t accept the change. Try again.')
  return r.transactionHash as Hex
}

export async function tokenBalance(owner: Address): Promise<bigint> {
  const cfg = await getConfig()
  const client = await relayClient(undefined, cfg)
  const r = (await Actions.token.getBalance(client, { account: owner, token: cfg.token } as any)) as any
  return r.amount as bigint
}

/**
 * A permission for a KEYKARD key on the user's wallet (auto-pay, family backup).
 *   - Signed by the wallet's ROOT key: one signature over the authorization only; KEYKARD checks and activates it.
 *   - Signed by an ADMIN key (a passkey, or a password set after a reset): Tempo requires that admin to also sign the
 *     transaction carrying it, so the user's key sends it itself (fee sponsored) and KEYKARD verifies it on-chain.
 * Returns the body field(s) to send to KEYKARD.
 */
async function grant(s: Signer, keyId: Address, policy: any): Promise<{ keyAuthorization?: Hex }> {
  // the wallet's root password key, already unlocked here, signs with no prompt at all: prefer it over a passkey
  const k = unlockedDeviceKey()
  const v = deviceVault()
  if (!s.root && k && v && lower(v.wallet ?? v.address) === lower(s.wallet) && lower(k.address) === lower(s.wallet)) {
    s = { kind: 'password', wallet: s.wallet, address: lower(k.address), pk: k.pk, root: true }
  }
  const cfg = await getConfig()
  const client = await relayClient(rootAccount(s), cfg)
  if (s.root) {
    const ka = await Actions.accessKey.signAuthorization(client, { accessKey: { address: keyId, type: 'secp256k1' }, ...policy } as any)
    return { keyAuthorization: KeyAuthorization.serialize(ka as any) as Hex }
  }
  await Actions.accessKey.authorizeSync(client, { accessKey: { address: keyId, type: 'secp256k1' }, ...policy, feePayer: true, ...slowSignerNonce() } as any)
  return {}
}

export async function signMandate(s: Signer, lineId: number, m: { keyId: Address; cap: string; periodSeconds: number; recipient: Address; expiry: number }) {
  const cfg = await getConfig()
  const policy = mandateKeyPolicy({ token: cfg.token, instalment: BigInt(m.cap), period: m.periodSeconds, repayTo: m.recipient, expiry: m.expiry })
  return api<{ tx: Hex | null }>(`/api/lines/${lineId}/mandate`, { body: await grant(s, m.keyId, policy) })
}

export async function signGuarantee(s: Signer, inviteId: string, k: { keyId: Address; cap: string; recipient: Address; expiry: number }) {
  const cfg = await getConfig()
  const policy = guaranteeKeyPolicy({ token: cfg.token, cap: BigInt(k.cap), recoveryTo: k.recipient, expiry: k.expiry })
  return api<{ tx: Hex | null }>(`/api/guarantee/${inviteId}/key`, { body: await grant(s, k.keyId, policy) })
}

/** Revoke a key KEYKARD holds on the user's own wallet (mandate or guarantee). */
export async function revokeKey(s: Signer, keyId: Address) {
  const client = await relayClient(rootAccount(s))
  const r = (await Actions.accessKey.revokeSync(client, { accessKey: keyId, feePayer: true, ...slowSignerNonce() } as any)) as any
  return r.receipt.transactionHash as Hex
}

/**
 * Pay a KEYKARD merchant from the credit line. The card key can only pay the KEYKARD settlement
 * address (protocol-enforced); the memo names the merchant, who is settled by the network.
 */
export async function payWithCard(s: Signer, creditAccount: Address, merchantCode: string, amount: bigint) {
  const cfg = await getConfig()
  const client = await relayClient(accessKeyAccount(s, creditAccount), cfg)
  const memo = encodePayMemo(merchantCode)
  const r = (await Actions.token.transferSync(client, { token: cfg.token, to: cfg.settlement, amount, memo, feePayer: true, ...slowSignerNonce() } as any)) as any
  return r.receipt.transactionHash as Hex
}

/** Deliberately pay a raw address with the card: used to show the protocol refusal. */
export async function payRawAddress(s: Signer, creditAccount: Address, to: Address, amount: bigint) {
  const cfg = await getConfig()
  const client = await relayClient(accessKeyAccount(s, creditAccount), cfg)
  const r = (await Actions.token.transferSync(client, { token: cfg.token, to, amount, feePayer: true, ...slowSignerNonce() } as any)) as any
  return r.receipt.transactionHash as Hex
}

/** Human-readable reason from a Tempo keychain / TIP-20 revert. */
export function explainChainError(e: any): string {
  const s = String(e?.details ?? e?.shortMessage ?? e?.message ?? e)
  if (/CallNotAllowed/.test(s)) return 'Refused by the Tempo protocol: your card can only pay through the KEYKARD network, not a raw wallet.'
  if (/SpendingLimitExceeded/.test(s)) return 'Refused by the Tempo protocol: this is over your available limit for this period (or your card is frozen).'
  if (/KeyAlreadyRevoked|KeyExpired/.test(s)) return 'This card key is no longer active.'
  if (/InsufficientBalance/.test(s)) return 'Not enough available credit.'
  if (/NotAllowedError|AbortError|timed out or was not allowed/.test(s))
    return 'The passkey request was cancelled or timed out, or this passkey no longer exists (for example, deleted from your phone). Try again, or tap “Start over” to create a new account.'
  return s.slice(0, 200)
}

/**
 * Merchant-side: charge a customer's PHYSICAL KEYKARD (NFC chip). Tap 1 identifies the card; the chip then
 * signs the payment on tap 2. The card key can only pay the settlement address, within its own limit.
 */
export async function chargePhysicalCard(p: { merchantCode: string; amount: bigint; onStatus?: (s: string) => void }) {
  const { readCard, cardAccessKeyAccount } = await import('./halo')
  const cfg = await getConfig()
  p.onStatus?.('Customer: tap your KEYKARD')
  const card = await readCard(p.onStatus)
  const info = await api<{ creditAccount: Address; cardLimit: string }>(`/api/cards/${card.address}`, { auth: false })
  if (p.amount > BigInt(info.cardLimit)) throw new Error(`Over this card’s tap limit (${Number(info.cardLimit) / 1e6} USD).`)
  p.onStatus?.('Tap the card again to pay')
  const client = await relayClient(cardAccessKeyAccount(info.creditAccount, card.publicKey, p.onStatus), cfg)
  const r = (await Actions.token.transferSync(client, {
    token: cfg.token, to: cfg.settlement, amount: p.amount, memo: encodePayMemo(p.merchantCode), feePayer: true, ...slowSignerNonce(),
  } as any)) as any
  return r.receipt.transactionHash as Hex
}

/** Borrower-side: link a physical card to your line (card proves possession by signing a server challenge). */
export async function linkPhysicalCard(onStatus?: (s: string) => void) {
  const { cardSignDigest } = await import('./halo')
  const { digest } = await api<{ challenge: Hex; digest: Hex }>('/api/card/challenge', { method: 'POST' })
  onStatus?.('Tap your card to link it')
  const { signature, address } = await cardSignDigest(digest, onStatus)
  return api<{ cardAddress: Address; cardLimit: string }>('/api/card/link', { body: { cardAddress: address, signature } })
}

/** Re-enable a revoked auto-debit: new mandate key, one signature, KEYKARD activates it. */
export async function renewMandateFlow() {
  const s = await getSigner()
  const r = await api<{ lineId: number; mandate: { keyId: Address; cap: string; periodSeconds: number; recipient: Address; expiry: number } }>(
    '/api/lines/mandate/renew',
    { method: 'POST' },
  )
  const cfg = await getConfig()
  const policy = mandateKeyPolicy({ token: cfg.token, instalment: BigInt(r.mandate.cap), period: r.mandate.periodSeconds, repayTo: r.mandate.recipient, expiry: r.mandate.expiry })
  return api('/api/lines/mandate/renew/confirm', { body: await grant(s, r.mandate.keyId, policy) })
}

type MandateTerms = { keyId: Address; cap: string; periodSeconds: number; recipient: Address; expiry: number }

/**
 * Secured line, 1:1: move your own stablecoins into the KEYKARD CollateralVault (approve + deposit batched in ONE
 * transaction, fee sponsored), then KEYKARD locks it and raises your limit by the same amount. If the new limit is
 * above your auto-pay cap, you also sign a bigger auto-pay permission (still payable only to KEYKARD).
 */
export async function addCollateral(amount: bigint) {
  const s = await getSigner()
  const prep = await api<{ vault: Address; token: Address; amount: string; mandate: MandateTerms | null }>('/api/collateral/prepare', {
    body: { amount: amount.toString() },
  })
  let granted: { keyAuthorization?: Hex } = {}
  if (prep.mandate) {
    const cfg = await getConfig()
    const m = prep.mandate
    granted = await grant(s, m.keyId, mandateKeyPolicy({ token: cfg.token, instalment: BigInt(m.cap), period: m.periodSeconds, repayTo: m.recipient, expiry: m.expiry }))
  }
  const client = await relayClient(rootAccount(s))
  const r = (await sendTransactionSync(client, {
    calls: [
      { to: prep.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [prep.vault, amount] }) },
      { to: prep.vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [amount] }) },
    ],
    feePayer: true,
    ...slowSignerNonce(),
  } as any)) as any
  if (r.status !== 'success') throw new Error('The deposit did not go through.')
  return api('/api/collateral/confirm', { body: { amount: amount.toString(), ...granted } })
}

/** Lower the secured limit, then withdraw that collateral from the vault back to your wallet. */
export async function withdrawCollateral(amount: bigint, alreadyReleased = false) {
  const s = await getSigner()
  const cfg = await getConfig()
  if (!alreadyReleased) await api('/api/collateral/release', { body: { amount: amount.toString() } })
  const client = await relayClient(rootAccount(s), cfg)
  const r = (await sendTransactionSync(client, {
    to: cfg.collateralVault!,
    data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [amount] }),
    feePayer: true,
    ...slowSignerNonce(),
  } as any)) as any
  if (r.status !== 'success') throw new Error('The withdrawal did not go through.')
  return r.transactionHash as Hex
}
