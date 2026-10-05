'use client'

// Same-origin by default (Next rewrites /api, /rpc, /relay to the servicer). Override only for split deployments.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''
const TOKEN_KEY = 'keycard.session'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== false) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  const r = await fetch(API_URL + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  let j: any = null
  try {
    j = await r.json()
  } catch {}
  if (!r.ok) {
    if (r.status === 401) setToken(null)
    throw new ApiError(j?.error ?? `request failed (${r.status})`, r.status)
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
  merchants: { code: string; label: string }[]
  creditTerms?: `0x${string}` | null
  collateralVault?: `0x${string}` | null
  /** Published pricing for missed payments, read from the CreditTerms contract. On time = 0%. */
  terms?: { lateFee: string; penaltyBpsPerPeriod: number; capBps: number; address: string } | null
  maxSecured?: string
}

let configPromise: Promise<AppConfig> | null = null
export const getConfig = () => (configPromise ??= api<AppConfig>('/api/config', { auth: false }))

export const usd = (base: string | bigint | null | undefined) => {
  if (base === null || base === undefined) return '—'
  const n = Number(BigInt(base)) / 1e6
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}
export const toBase = (dollars: string) => {
  const [i, f = ''] = dollars.trim().split('.')
  if (!/^\d+$/.test(i || '0') || !/^\d*$/.test(f)) throw new Error('invalid amount')
  return BigInt(i || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6))
}
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—')
export const duration = (s: number) =>
  s >= 86400 ? `${Math.round(s / 86400)} days` : s >= 3600 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 60)} minutes`
