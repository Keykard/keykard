import { createClient, encodeFunctionData, erc20Abi, http, type Address, type Hex } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { privateKeyToAccount } from 'viem/accounts'
import { Account, Actions, withRelay } from 'viem/tempo'
import { PublicKey } from 'ox'
import { KeyAuthorization, SignatureEnvelope } from 'ox/tempo'
import { collateralVaultAbi, encodePayMemo, guaranteeKeyPolicy, mandateKeyPolicy } from '@keycard/sdk'
import { API_URL, api, getConfig, setToken, type AppConfig } from './api'
import { KEYS, clearAll, get, set } from './storage'
import { deviceVault, forgetDeviceKey, lockDeviceKey, unlockDeviceKey, unlockedDeviceKey } from './devicekey'
import { createPasskey as nativeCreatePasskey, discoverPasskey, signWithPasskey } from './passkey'

/**
 * The KEYKARD wallet is a Tempo account with up to three keys (TIP-1049 admin keys, see the servicer's credentials.ts):
 *   - a password key: secp256k1, encrypted on the phone with the user's password (devicekey.ts). The wallet's root
 *     for new accounts; an admin key after a password reset;
 *   - a passkey (fingerprint / face / screen lock): an admin key, or the root for accounts created passkey-first;
 *   - KEYKARD's recovery key, used only after a passport re-check and a waiting period (never on the phone).
 * Every sign-in key is also a card key on the KEYKARD credit account. KEYKARD's relay pays every network fee.
 * Mirrors apps/web/lib/wallet.ts; keep the two in step.
 */
export type StoredCred = { id: string; publicKey: Hex; wallet?: Address; root?: boolean }
export type Signer =
  | { kind: 'passkey'; wallet: Address; cred: StoredCred; root: boolean }
  | { kind: 'password'; wallet: Address; address: Address; pk: Hex; root: boolean }

export const rpId = async () => (await getConfig()).passkeyRpId
const lower = (a: string) => a.toLowerCase() as Address

export function storedCredential(): StoredCred | null {
  const s = get(KEYS.passkey)
  try {
    return s ? (JSON.parse(s) as StoredCred) : null
  } catch {
    return null
  }
}
export const storeCredential = (c: StoredCred | null) => set(KEYS.passkey, c ? JSON.stringify(c) : null)
export const lastUsername = () => get(KEYS.lastUsername) ?? ''
export const rememberUsername = (u: string) => set(KEYS.lastUsername, u)

/* ---- password prompt: the UI registers a prompter (a masked modal) ---- */
let prompter: ((message: string) => Promise<string | null>) | null = null
export function setPasswordPrompter(fn: typeof prompter) {
  prompter = fn
}
export const askPassword = (message = 'Enter your KEYKARD password') => (prompter ? prompter(message) : Promise.resolve(null))

/** The password key on this phone as a signer (asks for the password once per app session if it's locked). */
export async function passwordSigner(reason = 'Enter your KEYKARD password'): Promise<Signer & { kind: 'password' }> {
  const v = deviceVault()
  if (!v) throw new Error('No password wallet on this phone. Sign in again.')
  let k = unlockedDeviceKey()
  let message = reason
  while (!k) {
    const pw = await askPassword(message)
    if (pw === null) throw new Error('Password entry cancelled.')
    try {
      k = await unlockDeviceKey(pw)
    } catch (e: any) {
      if (!/Wrong password/.test(e.message)) throw e
      message = 'Wrong password. Try again'
    }
  }
  const wallet = lower(v.wallet ?? v.address)
  return { kind: 'password', wallet, address: lower(k.address), pk: k.pk, root: lower(k.address) === wallet }
}

/** The signer on this phone: the passkey if there is one (one touch), otherwise the password key. */
export async function getSigner(): Promise<Signer> {
  const cred = storedCredential()
  if (cred?.wallet) return { kind: 'passkey', wallet: lower(cred.wallet), cred, root: cred.root ?? false }
  if (deviceVault()) return passwordSigner()
  throw new Error('No KEYKARD wallet on this phone. Sign in again.')
}
export const hasLocalWallet = () => Boolean(storedCredential()?.wallet || deviceVault())
export const signerKind = (): 'passkey' | 'password' | null => (storedCredential()?.wallet ? 'passkey' : deviceVault() ? 'password' : null)

/** A passkey registration against a server challenge (verified server-side). Nothing is stored yet. */
export async function registerPasskey(username: string) {
  const { id: challengeId, challenge } = await api<{ id: string; challenge: Hex }>('/api/auth/register-challenge', { auth: false })
  const p = await nativeCreatePasskey({ username, challenge, rpId: await rpId() })
  return { cred: { id: p.id, publicKey: p.publicKey } as StoredCred, registration: { challengeId, credential: p.serialized } }
}

/** A new password key proves possession by signing a server challenge (sign-up, reset, recovery). */
export async function registrationForDeviceKey(k: { address: Address; pk: Hex }) {
  const { id: challengeId, challenge } = await api<{ id: string; challenge: Hex }>('/api/auth/register-challenge', { auth: false })
  const signature = await privateKeyToAccount(k.pk).signMessage({ message: { raw: challenge } })
  return { challengeId, address: k.address, signature }
}

/**
 * Passkey sign-in in ONE prompt when we know the account (username first): sign the server challenge with any of the
 * account's passkeys. Without a username, the phone's passkey picker chooses (then a second prompt signs in).
 */
export async function signInWithPasskey(account?: { wallet: Address; passkeys: { id: string }[] }) {
  if (account) {
    const { challenge } = await api<{ challenge: Hex }>('/api/auth/challenge', { body: { wallet: account.wallet }, auth: false })
    const { metadata, signature, raw } = (await signWithPasskey({ challenge, credentialId: account.passkeys.map((p) => p.id), rpId: await rpId() })) as any
    const { token } = await api<{ token: string }>('/api/auth/verify', {
      auth: false,
      body: { wallet: account.wallet, metadata, signature: { r: signature.r.toString(), s: signature.s.toString() }, credentialId: raw.id },
    })
    const k = await api<{ wallet: Address; publicKey: Hex; root: boolean }>(`/api/passkeys/${encodeURIComponent(raw.id)}`, { auth: false })
    await storeCredential({ id: raw.id, publicKey: k.publicKey, wallet: lower(k.wallet), root: k.root })
    await setToken(token)
    return token
  }
  const id = await discoverPasskey(await rpId())
  const r = await api<{ publicKey: Hex; wallet: Address; root: boolean; username: string }>(`/api/passkeys/${encodeURIComponent(id)}`, { auth: false })
  const c: StoredCred = { id, publicKey: r.publicKey, wallet: lower(r.wallet), root: r.root }
  await storeCredential(c)
  if (r.username) await rememberUsername(r.username)
  return signIn({ kind: 'passkey', wallet: c.wallet!, cred: c, root: Boolean(c.root) })
}

export async function signOut() {
  await storeCredential(null)
  lockDeviceKey()
  await setToken(null)
}

/** Forget everything KEYKARD stored on this phone (session, passkey reference, password wallet). */
export async function startOver() {
  await forgetDeviceKey()
  await clearAll()
}

function passkeyAccount(s: Extract<Signer, { kind: 'passkey' }>, access?: Address, onSigned?: () => void) {
  const publicKey = PublicKey.fromHex(s.cred.publicKey)
  return Account.from({
    ...(access ? { access } : {}),
    keyType: 'webAuthn',
    publicKey,
    async sign({ hash }: { hash: Hex }) {
      const { metadata, signature } = await signWithPasskey({ challenge: hash, credentialId: s.cred.id, rpId: await rpId() })
      onSigned?.()
      return SignatureEnvelope.serialize({ publicKey, metadata, signature, type: 'webAuthn' } as any)
    },
  } as any)
}

/** The signer acting on the user's own wallet: as its root, or as an admin key. */
export const rootAccount = (s: Signer) =>
  s.kind === 'passkey'
    ? passkeyAccount(s, s.root ? undefined : s.wallet)
    : s.root ? Account.fromSecp256k1(s.pk) : Account.fromSecp256k1(s.pk, { access: s.wallet })

/** The signer acting as an access key on another account (the credit account = the card). */
export const accessKeyAccount = (s: Signer, parent: Address, onSigned?: () => void) =>
  s.kind === 'password' ? Account.fromSecp256k1(s.pk, { access: parent }) : passkeyAccount(s, parent, onSigned)

export async function relayClient(account: any, cfg?: AppConfig) {
  const config = cfg ?? (await getConfig())
  const { tempo, tempoModerato } = await import('viem/chains')
  const base = config.network === 'mainnet' ? tempo : tempoModerato
  const chain = base.extend({ feeToken: config.token })
  return createClient({
    account,
    chain,
    transport: withRelay(http(`${API_URL}/rpc`, { timeout: 45_000 }), http(`${API_URL}/relay`, { timeout: 45_000 }), { policy: 'sign-only' }),
  })
}

/** A fresh random 2D nonce lane: no expiry while the user approves with a fingerprint or taps a card. */
function slowSignerNonce() {
  const r = crypto.getRandomValues(new Uint8Array(24))
  let key = 1n
  for (const b of r) key = (key << 8n) | BigInt(b)
  return { nonceKey: key, nonce: 0 }
}

/** Proves control of the wallet to KEYKARD; stores the session token. */
export async function signIn(s: Signer) {
  const { challenge } = await api<{ challenge: Hex }>('/api/auth/challenge', { body: { wallet: s.wallet }, auth: false })
  let body: any
  if (s.kind === 'passkey') {
    const { metadata, signature } = await signWithPasskey({ challenge, credentialId: s.cred.id, rpId: await rpId() })
    body = { wallet: s.wallet, metadata, signature: { r: signature.r.toString(), s: signature.s.toString() }, credentialId: s.cred.id }
  } else {
    body = { wallet: s.wallet, keySignature: await privateKeyToAccount(s.pk).signMessage({ message: { raw: challenge } }) }
  }
  const { token } = await api<{ token: string }>('/api/auth/verify', { auth: false, body })
  await setToken(token)
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
 *   - ROOT key: one signature over the authorization only; KEYKARD checks and activates it.
 *   - ADMIN key (a passkey, or a password set after a reset): Tempo requires that admin to also sign the transaction
 *     carrying it, so the user's key sends it itself (fee sponsored) and KEYKARD verifies it on-chain.
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

type MandateTerms = { keyId: Address; cap: string; periodSeconds: number; recipient: Address; expiry: number }

export async function signMandate(s: Signer, lineId: number, m: MandateTerms) {
  const cfg = await getConfig()
  const policy = mandateKeyPolicy({ token: cfg.token, instalment: BigInt(m.cap), period: m.periodSeconds, repayTo: m.recipient, expiry: m.expiry })
  return api<{ tx: Hex | null }>(`/api/lines/${lineId}/mandate`, { body: await grant(s, m.keyId, policy) })
}

export async function signGuarantee(s: Signer, inviteId: string, k: { keyId: Address; cap: string; recipient: Address; expiry: number }) {
  const cfg = await getConfig()
  const policy = guaranteeKeyPolicy({ token: cfg.token, cap: BigInt(k.cap), recoveryTo: k.recipient, expiry: k.expiry })
  return api<{ tx: Hex | null }>(`/api/guarantee/${inviteId}/key`, { body: await grant(s, k.keyId, policy) })
}

export async function revokeKey(s: Signer, keyId: Address) {
  const client = await relayClient(rootAccount(s))
  const r = (await Actions.accessKey.revokeSync(client, { accessKey: keyId, feePayer: true, ...slowSignerNonce() } as any)) as any
  return r.receipt.transactionHash as Hex
}

export async function payWithCard(s: Signer, creditAccount: Address, merchantCode: string, amount: bigint, onStep?: (st: 'approve' | 'confirming') => void) {
  const cfg = await getConfig()
  onStep?.(s.kind === 'passkey' ? 'approve' : 'confirming') // a password wallet signs instantly
  const client = await relayClient(accessKeyAccount(s, creditAccount, () => onStep?.('confirming')), cfg)
  const r = (await Actions.token.transferSync(client, {
    token: cfg.token, to: cfg.settlement, amount, memo: encodePayMemo(merchantCode), feePayer: true, ...slowSignerNonce(),
  } as any)) as any
  return r.receipt.transactionHash as Hex
}

export async function payRawAddress(s: Signer, creditAccount: Address, to: Address, amount: bigint) {
  const cfg = await getConfig()
  const client = await relayClient(accessKeyAccount(s, creditAccount), cfg)
  const r = (await Actions.token.transferSync(client, { token: cfg.token, to, amount, feePayer: true, ...slowSignerNonce() } as any)) as any
  return r.receipt.transactionHash as Hex
}

export async function renewMandateFlow() {
  const s = await getSigner()
  const r = await api<{ lineId: number; mandate: MandateTerms }>('/api/lines/mandate/renew', { method: 'POST' })
  const cfg = await getConfig()
  const policy = mandateKeyPolicy({ token: cfg.token, instalment: BigInt(r.mandate.cap), period: r.mandate.periodSeconds, repayTo: r.mandate.recipient, expiry: r.mandate.expiry })
  return api('/api/lines/mandate/renew/confirm', { body: await grant(s, r.mandate.keyId, policy) })
}

export type CardStep = 'hold' | 'reading' | 'checking' | 'signing' | 'confirming' | 'linking'

/**
 * Merchant: charge a customer's physical KEYKARD with ONE tap. While the card is held: read it, check it can pay,
 * and have the chip sign the payment; then confirm on Tempo (the reader stays reserved until it's done).
 */
export async function chargePhysicalCard(p: { merchantCode: string; amount: bigint; onStep?: (s: CardStep) => void }) {
  if (process.env.EXPO_PUBLIC_FAKE_NFC === '1') return simulateCard(['hold', 'reading', 'checking', 'signing', 'confirming'], p.onStep, p.amount > 50_000_000n)
  const { withCard, readCard, cardAccessKeyAccount } = await import('./halo')
  const cfg = await getConfig()
  p.onStep?.('hold')
  return withCard(async (session) => {
    p.onStep?.('reading')
    const card = await readCard(session)
    p.onStep?.('checking')
    const info = await api<{ creditAccount: Address; cardLimit: string }>(`/api/cards/${card.address}`, { auth: false })
    if (p.amount > BigInt(info.cardLimit)) throw new Error(`Over this card’s tap limit ($${(Number(info.cardLimit) / 1e6).toFixed(2)}).`)
    p.onStep?.('signing')
    const account = cardAccessKeyAccount(session, info.creditAccount, card.publicKey, () => p.onStep?.('confirming'))
    const client = await relayClient(account, cfg)
    const r = (await Actions.token.transferSync(client, {
      token: cfg.token, to: cfg.settlement, amount: p.amount, memo: encodePayMemo(p.merchantCode), feePayer: true, ...slowSignerNonce(),
    } as any)) as any
    return { hash: r.receipt.transactionHash as Hex, card: card.address }
  })
}

/** Test builds only (EXPO_PUBLIC_FAKE_NFC): walk the card steps with realistic timing so the UI can be checked on an emulator. */
async function simulateCard(steps: CardStep[], onStep?: (s: CardStep) => void, fail = false) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (const st of steps) {
    onStep?.(st)
    await wait(st === 'hold' ? 2500 : st === 'confirming' ? 2200 : 900)
  }
  if (fail) throw new Error('Refused by the Tempo protocol: this is over your available limit for this period (or your card is frozen).')
  return { hash: ('0x' + 'ab'.repeat(32)) as Hex, card: '0x3c86aa11bb22cc33dd44ee55ff6677889900abcd' as Address }
}

/** Cardholder: link a physical card to your line with ONE tap (the card proves possession by signing a challenge). */
export async function linkPhysicalCard(onStep?: (s: CardStep) => void) {
  if (process.env.EXPO_PUBLIC_FAKE_NFC === '1') return simulateCard(['hold', 'signing', 'linking'], onStep, false).then(() => ({ cardAddress: '0x3c86aa11bb22cc33dd44ee55ff6677889900abcd' as Address, cardLimit: '10000000' }))
  const { withCard, cardSignDigest } = await import('./halo')
  const { digest } = await api<{ challenge: Hex; digest: Hex }>('/api/card/challenge', { method: 'POST' })
  onStep?.('hold')
  return withCard(async (session) => {
    onStep?.('signing')
    const { signature, address } = await cardSignDigest(session, digest)
    onStep?.('linking')
    return api<{ cardAddress: Address; cardLimit: string }>('/api/card/link', { body: { cardAddress: address, signature } })
  })
}

/** Human-readable reason from a Tempo keychain / TIP-20 revert or a wallet error. */
export function explainChainError(e: any): string {
  const s = String(e?.details ?? e?.shortMessage ?? e?.message ?? e)
  if (/CallNotAllowed/.test(s)) return 'Refused by the Tempo protocol: your card can only pay through the KEYKARD network, not a raw wallet.'
  if (/SpendingLimitExceeded/.test(s)) return 'Refused by the Tempo protocol: this is over your available limit for this period (or your card is frozen).'
  if (/KeyAlreadyRevoked|KeyExpired/.test(s)) return 'This card key is no longer active.'
  if (/InsufficientBalance/.test(s)) return 'Not enough available credit.'
  if (/HTTP request failed|fetch failed|Network request failed|timed out|took too long/i.test(s))
    return 'The network is slow right now. Check your connection; if a payment was sent, it will show up in your activity.'
  return s.slice(0, 220)
}

/**
 * Secured line, 1:1: approve + deposit into the KEYKARD CollateralVault in ONE transaction (fee sponsored), then
 * KEYKARD locks it and raises the limit by the same amount. If the new limit is above the auto-pay cap, the user also
 * signs a bigger auto-pay permission (still payable only to KEYKARD). Mirrors apps/web/lib/wallet.ts.
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

/** Lower the secured limit, then withdraw that collateral from the vault back to the wallet. */
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
