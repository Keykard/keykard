import * as SecureStore from 'expo-secure-store'

/**
 * Everything KEYKARD keeps on the phone lives in the Android Keystore-backed SecureStore
 * (session token, passkey reference, the password wallet's encrypted vault). Same key names as the web app.
 */
export const KEYS = {
  session: 'keycard.session',
  passkey: 'keycard.passkey',
  vault: 'keycard.devicekey',
  mode: 'keycard.mode', // 'cardholder' | 'merchant': which home the app opens to
  lastUsername: 'keycard.lastUsername',
  recovery: 'keycard.recovery', // a "lost both" recovery started on this phone (new key's vault, never the password)
  recoveryPasskey: 'keycard.recovery.passkey',
  passkeyOfferDismissed: 'keycard.passkeyOfferDismissed',
} as const

const cache = new Map<string, string | null>()

export async function load() {
  await Promise.all(Object.values(KEYS).map(async (k) => cache.set(k, await SecureStore.getItemAsync(k).catch(() => null))))
}
/** Synchronous read of the in-memory copy (filled by load() at startup, kept in sync by set()). */
export const get = (k: string) => cache.get(k) ?? null
export async function set(k: string, v: string | null) {
  cache.set(k, v)
  if (v === null) await SecureStore.deleteItemAsync(k).catch(() => {})
  else await SecureStore.setItemAsync(k, v)
}
export async function clearAll() {
  await Promise.all(Object.values(KEYS).map((k) => set(k, null)))
}
