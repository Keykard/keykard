'use client'

import type { Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'

/**
 * Password wallet ("device key"): a secp256k1 key generated in the browser and stored ONLY encrypted
 * (PBKDF2-SHA256 600k iterations → AES-256-GCM), the MetaMask model. The password never leaves the device.
 * Trade-offs shown in the UI: the key lives on this device only; security equals password strength.
 */
const STORE = 'keycard.devicekey'
const ITER = 600_000
/** `address` = the key's address; `wallet` = the KEYKARD wallet it unlocks (the same for older accounts). */
export type Vault = { address: `0x${string}`; salt: string; iv: string; ct: string; iter: number; wallet?: `0x${string}` }

let unlocked: { address: `0x${string}`; pk: Hex } | null = null

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

export function deviceVault(): Vault | null {
  try {
    const s = localStorage.getItem(STORE)
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
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(pk)))
  return { address, salt: b64(salt), iv: b64(iv), ct: b64(ct), iter: ITER }
}

/** A brand-new password key, NOT yet stored on this device (sign-up, password reset, recovery). */
export async function newDeviceKey(password: string) {
  const pk = generatePrivateKey()
  const vault = await sealKey(pk, password)
  return { address: vault.address, pk, vault }
}

/** Make `vault` this device's password wallet, unlocked. */
export function useDeviceKey(k: { address: `0x${string}`; pk: Hex; vault: Vault }, wallet: `0x${string}`) {
  localStorage.setItem(STORE, JSON.stringify({ ...k.vault, wallet: wallet.toLowerCase() }))
  unlocked = { address: k.address, pk: k.pk }
}

export async function createDeviceKey(password: string) {
  const k = await newDeviceKey(password)
  localStorage.setItem(STORE, JSON.stringify(k.vault))
  unlocked = { address: k.address, pk: k.pk }
  return k
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

/**
 * Login proof for password sign-in on other devices: a SEPARATE derivation (different salt) from the vault key,
 * so the server can check the password without ever being able to decrypt the vault.
 */
export async function deriveAuthProof(username: string, password: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const salt = new TextEncoder().encode(`keycard-auth:${username.trim().toLowerCase()}`)
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, 256)
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Install a vault fetched from KEYKARD (encrypted) and unlock it locally with the password. */
export async function importVaultAndUnlock(vault: Vault, password: string, wallet?: `0x${string}`) {
  localStorage.setItem(STORE, JSON.stringify({ ...vault, wallet: (wallet ?? vault.wallet ?? vault.address).toLowerCase() }))
  return unlockDeviceKey(password)
}

export async function unlockDeviceKey(password: string) {
  const v = deviceVault()
  if (!v) throw new Error('No password wallet on this device.')
  try {
    const key = await deriveKey(password, unb64(v.salt), v.iter)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct))
    unlocked = { address: v.address, pk: new TextDecoder().decode(pt) as Hex }
    return unlocked
  } catch {
    throw new Error('Wrong password.')
  }
}

export const unlockedDeviceKey = () => unlocked
export function forgetDeviceKey() {
  unlocked = null
  try {
    localStorage.removeItem(STORE)
  } catch {}
}
export function lockDeviceKey() {
  unlocked = null
}

/** Password prompt (native <dialog>, masked input with a show/hide toggle). Resolves null if cancelled. */
export function askPassword(message = 'Enter your KEYKARD password'): Promise<string | null> {
  return new Promise((resolve) => {
    const d = document.createElement('dialog')
    d.className = 'kc-dialog'
    d.innerHTML = `<form method="dialog"><p class="kc-dialog__title"></p>
      <p class="small muted" style="margin:0 0 12px">Your password unlocks the wallet on this device. It never leaves it.</p>
      <span class="pw-wrap"><input type="password" autocomplete="current-password" aria-label="Password" />
      <button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="pw-slash" d="M4 4l16 16" style="display:none"/></svg>
      </button></span>
      <div style="display:flex;gap:8px;margin-top:14px"><button value="cancel" class="ghost" style="flex:1">Cancel</button><button value="ok" style="flex:1">Unlock</button></div></form>`
    ;(d.querySelector('.kc-dialog__title') as HTMLElement).textContent = message
    document.body.appendChild(d)
    const input = d.querySelector('input') as HTMLInputElement
    const toggle = d.querySelector('.pw-toggle') as HTMLButtonElement
    const slash = d.querySelector('.pw-slash') as SVGPathElement
    toggle.addEventListener('click', () => {
      const show = input.type === 'password'
      input.type = show ? 'text' : 'password'
      slash.style.display = show ? '' : 'none'
      toggle.setAttribute('aria-pressed', String(show))
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password')
      input.focus()
    })
    d.addEventListener('close', () => {
      const v = d.returnValue === 'ok' ? input.value : null
      d.remove()
      resolve(v)
    })
    d.showModal()
    input.focus()
  })
}
