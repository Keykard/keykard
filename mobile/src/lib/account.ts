import type { Address, Hex } from 'viem'
import { api, setToken } from './api'
import { KEYS, get, set } from './storage'
import { deriveAuthProof, importVaultAndUnlock, newDeviceKey, sealKey, useDeviceKey, type Vault } from './devicekey'
import { passkeysSupported as nativePasskeys } from './passkey'
import {
  getSigner,
  passwordSigner,
  registerPasskey,
  registrationForDeviceKey,
  rememberUsername,
  sendKeyCalls,
  signIn,
  signInWithPasskey,
  storeCredential,
  storedCredential,
  type Signer,
} from './wallet'

/**
 * Account flows (username first): the username decides sign-in vs sign-up, a password always works, a passkey is an
 * optional one-touch upgrade, and there are three ways back in:
 *   forgot password → passkey · lost passkey → password · lost both → passport (Self) + a waiting period.
 * Mirrors apps/web/lib/account.ts; keep the two in step.
 */
export type Role = 'borrower' | 'guarantor' | 'merchant'
export type AccountInfo =
  | { exists: false }
  | { exists: true; wallet: Address; role: Role; hasPassword: boolean; passkeys: { id: string }[]; recovery: boolean }
export type Security = {
  hasPassword: boolean
  passkeys: { id: number; passkeyId: string; root: boolean; addedAt: string }[]
  recoveryOn: boolean
  recoveryKeyId: number | null
  recoveryOptOut: boolean
  openRecovery: { id: string; status: 'awaiting_self' | 'waiting'; readyAt: string | null; startedAt: string } | null
}

export const USERNAME_RE = /^[a-z0-9._-]{3,30}$/
export const normUsername = (u: string) => u.trim().toLowerCase()
export const passkeysSupported = nativePasskeys

export function lookup(username: string) {
  return api<AccountInfo>(`/api/accounts/${encodeURIComponent(normUsername(username))}`, { auth: false })
}

/** Sign-up: the password key becomes the wallet; the recovery key is added right after (no prompt: the key is local). */
export async function signUp(p: { username: string; password: string; role: Role; country: string }) {
  const username = normUsername(p.username)
  const k = await newDeviceKey(p.password)
  const keyRegistration = await registrationForDeviceKey(k)
  const authProof = await deriveAuthProof(username, p.password)
  const r = await api<{ wallet: Address; token?: string }>('/api/users', {
    auth: false,
    body: { role: p.role, username, keyRegistration, backup: { username, authProof, vault: k.vault }, residenceCountry: p.country, residenceConfirmed: true },
  })
  await storeCredential(null)
  await useDeviceKey(k, r.wallet)
  if (r.token) await setToken(r.token)
  else await signIn({ kind: 'password', wallet: r.wallet, address: k.address, pk: k.pk, root: true })
  await rememberUsername(username)
  // account recovery is on by default; failing here must not block sign-up (Settings offers it again)
  await setRecovery(true).catch((e) => console.warn('recovery key not added yet:', e?.message))
  return r.wallet
}

export async function signInWithPassword(username: string, password: string) {
  const u = normUsername(username)
  const authProof = await deriveAuthProof(u, password)
  const r = await api<{ wallet: Address; keyId: Address; vault: Vault }>('/api/auth/password', { auth: false, body: { username: u, authProof } })
  const k = await importVaultAndUnlock(r.vault, password, r.wallet)
  if (k.address.toLowerCase() !== r.keyId.toLowerCase()) throw new Error('This password key doesn’t match the account. Contact KEYKARD.')
  await storeCredential(null)
  await signIn({ kind: 'password', wallet: r.wallet, address: k.address, pk: k.pk, root: k.address.toLowerCase() === r.wallet.toLowerCase() })
  await rememberUsername(u)
  return r.wallet
}

export function passkeySignIn(account?: AccountInfo & { exists: true }) {
  return signInWithPasskey(account ? { wallet: account.wallet, passkeys: account.passkeys } : undefined)
}

async function change(body: Record<string, unknown>, signer: Signer, remove: number[] = []) {
  const prep = await api<{ calls: { to: Address; data: Hex }[] }>('/api/credentials/prepare', { body: { ...body, ...(remove.length ? { remove } : {}) } })
  await sendKeyCalls(signer, prep.calls)
  return api<Security>('/api/credentials/confirm', { body: { remove } })
}

/** Add this phone's fingerprint / face as a sign-in method. */
export async function addPasskey(username: string, opts: { replace?: number[]; signer?: Signer } = {}) {
  const signer = opts.signer ?? (storedCredential()?.wallet ? await getSigner() : await passwordSigner('Confirm with your password'))
  const { cred, registration } = await registerPasskey(normUsername(username))
  const sec = await change({ passkey: registration }, signer, opts.replace ?? [])
  await storeCredential({ ...cred, wallet: signer.wallet, root: false })
  return sec
}

export async function removePasskey(id: number) {
  const signer = await passwordSigner('Confirm with your password')
  const sec = await change({}, signer, [id])
  const mine = storedCredential()
  if (mine && !sec.passkeys.some((p) => p.passkeyId === mine.id)) await storeCredential(null)
  return sec
}

/** New password with a NEW key ("forgot password", signed by the passkey). The old password stops working everywhere. */
export async function resetPassword(username: string, newPassword: string, signer?: Signer) {
  const s = signer ?? (await getSigner())
  const u = normUsername(username)
  const k = await newDeviceKey(newPassword)
  const keyRegistration = await registrationForDeviceKey(k)
  const authProof = await deriveAuthProof(u, newPassword)
  const sec = await change({ password: { keyRegistration, authProof, vault: k.vault } }, s)
  await useDeviceKey(k, s.wallet)
  return sec
}

/** Change a password you know: the same key, re-encrypted with the new password. No on-chain change. */
export async function changePassword(username: string, currentPassword: string, newPassword: string) {
  const u = normUsername(username)
  const cur = await api<{ wallet: Address; keyId: Address; vault: Vault }>('/api/auth/password', {
    auth: false,
    body: { username: u, authProof: await deriveAuthProof(u, currentPassword) },
  }).catch(() => {
    throw new Error('Your current password isn’t right.')
  })
  const k = await importVaultAndUnlock(cur.vault, currentPassword, cur.wallet)
  const vault = await sealKey(k.pk, newPassword)
  await api('/api/auth/password/change', { body: { authProof: await deriveAuthProof(u, newPassword), vault } })
  await useDeviceKey({ address: k.address, pk: k.pk, vault }, cur.wallet)
}

export async function security() {
  return (await api<{ security: Security }>('/api/me')).security
}

/** Turn KEYKARD account recovery on (adds the recovery key) or off (removes it: fully self-custodial). */
export async function setRecovery(on: boolean, signer?: Signer) {
  const s = signer ?? (await getSigner())
  if (on) return change({ recovery: true }, s)
  const sec = await security()
  if (!sec.recoveryKeyId) return sec
  return change({}, s, [sec.recoveryKeyId])
}

// ---------------- lost both: passport + waiting period ----------------
type PendingRecovery = { id: string; username: string; vault: Vault; address: Address; withPasskey: boolean }

export function pendingRecovery(): PendingRecovery | null {
  try {
    const s = get(KEYS.recovery)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

export async function startRecovery(username: string, newPassword: string, withPasskey: boolean) {
  const u = normUsername(username)
  const k = await newDeviceKey(newPassword)
  const keyRegistration = await registrationForDeviceKey(k)
  const authProof = await deriveAuthProof(u, newPassword)
  let passkey: { challengeId: string; credential: unknown } | undefined
  let cred: { id: string; publicKey: Hex } | undefined
  if (withPasskey) {
    const r = await registerPasskey(u)
    passkey = r.registration
    cred = r.cred
  }
  const r = await api<{ recoveryId: string; verificationUrl: string }>('/api/recovery/start', {
    auth: false,
    body: { username: u, password: { keyRegistration, authProof, vault: k.vault }, ...(passkey ? { passkey } : {}) },
  })
  await set(KEYS.recovery, JSON.stringify({ id: r.recoveryId, username: u, vault: k.vault, address: k.address, withPasskey } satisfies PendingRecovery))
  await set(KEYS.recoveryPasskey, cred ? JSON.stringify(cred) : null)
  return r
}

export function recoveryStatus(id: string) {
  return api<{ status: 'awaiting_self' | 'waiting' | 'completed' | 'cancelled' | 'failed'; readyAt: string | null; error: string | null; username: string }>(
    `/api/recovery/${encodeURIComponent(id)}`,
    { auth: false },
  )
}

/** Recovery completed: sign in with the new password (this phone already holds the new key). */
export async function finishRecovery(newPassword: string) {
  const r = pendingRecovery()
  if (!r) throw new Error('No recovery on this phone.')
  const wallet = await signInWithPassword(r.username, newPassword)
  try {
    const cred = get(KEYS.recoveryPasskey)
    if (cred) await storeCredential({ ...JSON.parse(cred), wallet, root: false })
  } catch {}
  await abandonRecovery()
  return wallet
}

export async function abandonRecovery() {
  await set(KEYS.recovery, null)
  await set(KEYS.recoveryPasskey, null)
}

export function cancelRecovery() {
  return api('/api/recovery/cancel', { method: 'POST' })
}
