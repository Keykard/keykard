import Constants from 'expo-constants'
import { KEYS, get, set } from './storage'

/** The KEYKARD servicer. Production by default; `EXPO_PUBLIC_API_URL` overrides it for local development. */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as any)?.apiUrl ?? 'https://keycard-production-da41.up.railway.app'

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

let onSignedOut: (() => void) | null = null
/** Called when the server rejects the session (expired): the app returns to sign-in. */
export const setSignedOutHandler = (fn: () => void) => (onSignedOut = fn)

export const getToken = () => get(KEYS.session)
export const setToken = (t: string | null) => set(KEYS.session, t)

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000)
  let r: Response
  try {
    r = await fetch(API_URL + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    })
  } catch (e: any) {
    throw new ApiError(e?.name === 'AbortError' ? 'KEYKARD took too long to answer. Check your connection and try again.' : 'No connection to KEYKARD. Check your internet and try again.', 0)
  } finally {
    clearTimeout(timer)
  }
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  if (!r.ok) {
    if (r.status === 401 && opts.auth !== false && getToken()) {
      await setToken(null)
      onSignedOut?.()
    }
    throw new ApiError(j?.error ?? `Request failed (${r.status})`, r.status)
  }
  return j as T
}

export type AppConfig = {
  network: 'testnet' | 'mainnet'
  chainId: number
  rpcUrl: string
  explorerUrl: string
  token: `0x${string}`
  tokenSymbol: string
  tokenDecimals: number
  treasury: `0x${string}`
  settlement: `0x${string}`
  tiers: string[]
  periodSeconds: number
  graceSeconds: number
  excludedCountries: string[]
  selfEnabled: boolean
  devVerify?: boolean
  publicWebOrigin: string
  passkeyRpId: string
  merchants: { code: string; label: string }[]
  creditTerms?: `0x${string}` | null
  collateralVault?: `0x${string}` | null
  /** Published pricing for missed payments, read from the CreditTerms contract. On time = 0%. */
  terms?: { lateFee: string; penaltyBpsPerPeriod: number; capBps: number; address: string } | null
  maxSecured?: string
}

let configPromise: Promise<AppConfig> | null = null
export const getConfig = () => {
  configPromise ??= api<AppConfig>('/api/config', { auth: false }).catch((e) => {
    configPromise = null // retry on the next call
    throw e
  })
  return configPromise
}
