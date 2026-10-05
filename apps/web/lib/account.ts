'use client'

import type { Address, Hex } from 'viem'
import { api, setToken } from './api'
import { deriveAuthProof, importVaultAndUnlock, newDeviceKey, sealKey, useDeviceKey, type Vault } from './devicekey'
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
 * Account flows (identifier-first): the username decides whether this is a sign-in or a sign-up, a password always
 * works, a passkey is an optional one-tap upgrade, and there are three ways back in:
 *   forgot password → passkey · lost passkey → password · lost both → passport (Self) + a waiting period.
 * Mirrors mobile/src/lib/account.ts.
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
export const passkeysSupported = () => typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)

export function lookup(username: string) {
  return api<AccountInfo>(`/api/accounts/${encodeURIComponent(normUsername(username))}`, { auth: false })
}

/** Sign-up: the password key becomes the wallet. The recovery key is added right after (no prompt: the key is local). */
export async function signUp(p: { username: string; password: string; role: Role; country: string }) {
  const username = normUsername(p.username)
  const k = await newDeviceKey(p.password)
  const keyRegistration = await registrationForDeviceKey(k)
  const authProof = await deriveAuthProof(username, p.password)
  const r = await api<{ wallet: Address; token?: string }>('/api/users', {
    auth: false,
    body: { role: p.role, username, keyRegistration, backup: { username, authProof, vault: k.vault }, residenceCountry: p.country, residenceConfirmed: true },
  })
  storeCredential(null)
  useDeviceKey(k, r.wallet)
  if (r.token) setToken(r.token)
  else await signIn({ kind: 'password', wallet: r.wallet, address: k.address, pk: k.pk, root: true })
  rememberUsername(username)
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
  storeCredential(null)
  await signIn({ kind: 'password', wallet: r.wallet, address: k.address, pk: k.pk, root: k.address.toLowerCase() === r.wallet.toLowerCase() })
  rememberUsername(u)
  return r.wallet
}

export async function passkeySignIn(account?: AccountInfo & { exists: true }) {
  return signInWithPasskey(account ? { wallet: account.wallet, passkeys: account.passkeys } : undefined)
}

/** The signer to change keys with. Prefer the one the caller says is available (e.g. the passkey after "forgot password"). */
async function changeSigner(prefer?: 'passkey' | 'password'): Promise<Signer> {
  if (prefer === 'password' || (!storedCredential()?.wallet && prefer !== 'passkey')) return passwordSigner('Confirm with your password')
  return getSigner()
}

/** Prepare → the user's key sends the keychain calls → confirm (KEYKARD checks the result on-chain). */
async function change(body: Record<string, unknown>, signer: Signer, remove: number[] = []) {
  const prep = await api<{ calls: { to: Address; data: Hex }[] }>('/api/credentials/prepare', { body: { ...body, ...(remove.length ? { remove } : {}) } })
  await sendKeyCalls(signer, prep.calls)
  return api<Security>('/api/credentials/confirm', { body: { remove } })
}

/** Add this device's fingerprint / face as a sign-in method (one passkey prompt to create it). */
export async function addPasskey(username: string, opts: { replace?: number[]; signer?: Signer } = {}) {
  const signer = opts.signer ?? (await changeSigner('password'))
  const { cred, registration } = await registerPasskey(normUsername(username))
  const sec = await change({ passkey: registration }, signer, opts.replace ?? [])
  storeCredential({ ...cred, wallet: signer.wallet, root: false })
  return sec
}

export async function removePasskey(id: number) {
  const signer = await changeSigner('password')
  const sec = await change({}, signer, [id])
  const mine = storedCredential()
  if (mine && !sec.passkeys.some((p) => p.passkeyId === mine.id)) storeCredential(null)
  return sec
}

/**
 * New password with a NEW key (used for "forgot password": signed by the passkey). The old password stops working
 * everywhere; this device keeps the new key.
 */
export async function resetPassword(username: string, newPassword: string, signer?: Signer) {
  const s = signer ?? (await changeSigner('passkey'))
  const u = normUsername(username)
  const k = await newDeviceKey(newPassword)
  const keyRegistration = await registrationForDeviceKey(k)
  const authProof = await deriveAuthProof(u, newPassword)
  const sec = await change({ password: { keyRegistration, authProof, vault: k.vault } }, s)
  useDeviceKey(k, s.wallet)
  return sec
}

/** Change a password you know: the same key, re-encrypted with the new password. No on-chain change. */
export async function changePassword(username: string, currentPassword: string, newPassword: string) {
  const u = normUsername(username)
  // the current password fetches and unlocks the key (works on any device, and proves the password)
  const cur = await api<{ wallet: Address; keyId: Address; vault: Vault }>('/api/auth/password', {
    auth: false,
    body: { username: u, authProof: await deriveAuthProof(u, currentPassword) },
  }).catch(() => {
    throw new Error('Your current password isn’t right.')
  })
  const k = await importVaultAndUnlock(cur.vault, currentPassword, cur.wallet)
  const vault = await sealKey(k.pk, newPassword)
  await api('/api/auth/password/change', { body: { authProof: await deriveAuthProof(u, newPassword), vault } })
  useDeviceKey({ address: k.address, pk: k.pk, vault }, cur.wallet)
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
const RECOVERY = 'keycard.recovery'
type PendingRecovery = { id: string; username: string; vault: Vault; address: Address; withPasskey: boolean }

export function pendingRecovery(): PendingRecovery | null {
  try {
    const s = localStorage.getItem(RECOVERY)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}
function savePendingRecovery(r: PendingRecovery | null) {
  try {
    if (r) localStorage.setItem(RECOVERY, JSON.stringify(r))
    else localStorage.removeItem(RECOVERY)
  } catch {}
}

/** Start recovery on this device: new password (and optionally a new passkey), then Self. Returns the Self link. */
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
  savePendingRecovery({ id: r.recoveryId, username: u, vault: k.vault, address: k.address, withPasskey })
  if (cred) localStorage.setItem('keycard.recovery.passkey', JSON.stringify(cred))
  return r
}

export function recoveryStatus(id: string) {
  return api<{ status: 'awaiting_self' | 'waiting' | 'completed' | 'cancelled' | 'failed'; readyAt: string | null; error: string | null; username: string }>(
    `/api/recovery/${encodeURIComponent(id)}`,
    { auth: false },
  )
}

/** Recovery completed: sign in with the new password (this device already holds the new key). */
export async function finishRecovery(newPassword: string) {
  const r = pendingRecovery()
  if (!r) throw new Error('No recovery on this device.')
  const wallet = await signInWithPassword(r.username, newPassword)
  try {
    const cred = localStorage.getItem('keycard.recovery.passkey')
    if (cred) storeCredential({ ...JSON.parse(cred), wallet, root: false })
    localStorage.removeItem('keycard.recovery.passkey')
  } catch {}
  savePendingRecovery(null)
  return wallet
}

export function abandonRecovery() {
  savePendingRecovery(null)
  try {
    localStorage.removeItem('keycard.recovery.passkey')
  } catch {}
}

export function cancelRecovery() {
  return api('/api/recovery/cancel', { method: 'POST' })
}

export async function security() {
  return (await api<{ security: Security }>('/api/me')).security
}
