import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { KEYS, get, set } from './storage'

/**
 * Password wallet ("device key"), byte-for-byte compatible with the web app (apps/web/lib/devicekey.ts):
 * a secp256k1 key stored ONLY encrypted, PBKDF2-SHA256 600k → AES-256-GCM, base64 fields. So the same account
 * opens on the website and in this app ("sign in with password" fetches the encrypted vault from KEYKARD).
 * Crypto is native (react-native-quick-crypto installs global.crypto.subtle).
 */
const ITER = 600_000
/** `address` = the key's address; `wallet` = the KEYKARD wallet it unlocks (the same for older accounts). */
export type Vault = { address: `0x${string}`; salt: string; iv: string; ct: string; iter: number; wallet?: `0x${string}` }

let unlocked: { address: `0x${string}`; pk: Hex } | null = null

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const enc = (s: string) => new TextEncoder().encode(s)

async function deriveKey(password: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter } as any, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

export function deviceVault(): Vault | null {
  const s = get(KEYS.vault)
  try {
    return s ? (JSON.parse(s) as Vault) : null
  } catch {
    return null
  }
}

export const MIN_PASSWORD = 10

/** Encrypt a key with a password (PBKDF2 600k → AES-GCM). Nothing is stored. */
export async function sealKey(pk: Hex, password: string): Promise<Vault> {
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`)
  const address = privateKeyToAddress(pk)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, ITER)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv } as any, key, enc(pk)))
  return { address, salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: ITER }
}

/** A brand-new password key, NOT yet stored on this phone (sign-up, password reset, recovery). */
export async function newDeviceKey(password: string) {
  const pk = generatePrivateKey()
  const vault = await sealKey(pk, password)
  return { address: vault.address, pk, vault }
}

/** Make `vault` this phone's password wallet, unlocked. */
export async function useDeviceKey(k: { address: `0x${string}`; pk: Hex; vault: Vault }, wallet: `0x${string}`) {
  await set(KEYS.vault, JSON.stringify({ ...k.vault, wallet: wallet.toLowerCase() }))
  unlocked = { address: k.address, pk: k.pk }
}

/** Password strength for the sign-up hint: 0 too short · 1 weak · 2 okay · 3 strong. */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length < MIN_PASSWORD) return { score: 0, label: `At least ${MIN_PASSWORD} characters` }
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  const common = /^(password|qwerty|12345|letmein|keykard|keycard)/i.test(pw) || /^(.)\1+$/.test(pw)
  if (common || kinds <= 1) return { score: 1, label: 'Weak: mix letters, numbers and a symbol' }
  if (pw.length >= 14 && kinds >= 3) return { score: 3, label: 'Strong' }
  return { score: 2, label: 'Okay: longer is stronger' }
}

/** Login proof for password sign-in on other devices: a separate derivation the server can check but can't decrypt with. */
export async function deriveAuthProof(username: string, password: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits'])
  const salt = enc(`keycard-auth:${username.trim().toLowerCase()}`)
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER } as any, base, 256)
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function importVaultAndUnlock(vault: Vault, password: string, wallet?: `0x${string}`) {
  const k = await unlockVault(vault, password)
  await set(KEYS.vault, JSON.stringify({ ...vault, wallet: (wallet ?? vault.wallet ?? vault.address).toLowerCase() }))
  return k
}

async function unlockVault(v: Vault, password: string) {
  try {
    const key = await deriveKey(password, unb64(v.salt), v.iter)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) } as any, key, unb64(v.ct))
    unlocked = { address: v.address, pk: new TextDecoder().decode(new Uint8Array(pt)) as Hex }
    return unlocked
  } catch {
    throw new Error('Wrong password.')
  }
}

export async function unlockDeviceKey(password: string) {
  const v = deviceVault()
  if (!v) throw new Error('No password wallet on this phone.')
  return unlockVault(v, password)
}

export const unlockedDeviceKey = () => unlocked
export async function forgetDeviceKey() {
  unlocked = null
  await set(KEYS.vault, null)
}
export const lockDeviceKey = () => {
  unlocked = null
}
