import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { getNetwork, type Network } from '@keycard/sdk'

const root = resolve(import.meta.dirname, '../../..')

/** Loads ../../.env.<network> (operator keys) then process.env overrides. */
function loadEnvFile(network: string): Record<string, string> {
  const file = resolve(root, `.env.${network}`)
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  )
}

const networkName = process.env.TEMPO_NETWORK ?? 'testnet'
const raw = { ...loadEnvFile(networkName), ...process.env }

const hex = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const Env = z.object({
  TEMPO_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  TREASURY_PK: hex,
  ATTESTER_PK: hex,
  SERVICER_PK: hex,
  SETTLEMENT_PK: hex,
  KEY_ENC_SECRET: z.string().min(40),
  DATABASE_URL: z.string().default('postgres://keycard:keycard@127.0.0.1:5544/keycard'),
  PORT: z.coerce.number().default(8787),
  PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:3000'),
  // every origin the web app / PWA is served from (passkey origin + rpId are checked against these)
  WEB_ORIGINS: z.string().default('http://localhost:3000'),
  // native app origins for passkeys ("android:apk-key-hash:<base64url SHA-256 of the signing cert>"); comma-separated
  ANDROID_APP_ORIGINS: z.string().default('android:apk-key-hash:89RKgtQCc5C1KTj9xYFC7XQ1MYScRp5t2QnH1rvxZzM'),
  // WebAuthn relying party for the native app (the web domain that serves /.well-known/assetlinks.json)
  PASSKEY_RP_ID: z.string().optional(),
  // testnet-only: allow registering a raw public key without a WebAuthn ceremony (used by API e2e tests)
  ALLOW_UNVERIFIED_REGISTRATION: z.enum(['0', '1']).default('0'),
  // testnet-only: lets a signed-in user skip Self (for team testing before Self is configured). Ignored on mainnet.
  ALLOW_DEV_VERIFY: z.enum(['0', '1']).default('0'),
  PERIOD_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
  GRACE_SECONDS: z.coerce.number().int().positive().default(5 * 24 * 3600),
  TERM_DAYS: z.coerce.number().int().positive().default(180),
  // credit tiers in token base units (6 decimals): $20 -> $50 -> $100
  TIERS: z.string().default('20000000,50000000,100000000'),
  // physical card (NFC chip) per-period limit, contactless-style, in token base units ($10)
  CARD_LIMIT: z.coerce.bigint().default(10_000_000n),
  // secured lines: most collateral one borrower can lock (1:1 extra limit), in token base units ($500)
  MAX_SECURED: z.coerce.bigint().default(500_000_000n),
  // account recovery (lost password AND passkey): waiting period after the passport check. Default 5 min on
  // testnet, 48 h on mainnet (see recovery.ts)
  RECOVERY_DELAY_SECONDS: z.coerce.number().int().positive().optional(),
  // rewards (rewards.ts): standard merchant fee, cashback to cardholders (paid out of the fee), fee-shield streak
  MERCHANT_FEE_BPS: z.coerce.number().int().min(0).max(500).default(100),
  BASE_CASHBACK_BPS: z.coerce.number().int().min(0).max(500).default(50),
  SHIELD_EVERY: z.coerce.number().int().positive().default(3),
  // collateral that earns (earncollateral.ts): limit given per $1 of Earn collateral value (buffer against value
  // moves), and on testnet only, the simulated yield KEYKARD tops the demo venue up with (0 turns it off)
  EARN_LTV_BPS: z.coerce.number().int().min(1000).max(10_000).default(9500),
  EARN_SIM_APR_BPS: z.coerce.number().int().min(0).max(2000).default(500),
  EARN_SIM_EVERY_SECONDS: z.coerce.number().int().positive().default(3600),
  ON_TIME_TO_UPGRADE: z.coerce.number().int().positive().default(2),
  // Comma-separated ISO-3 residence countries refused at signup. Empty during the hackathon pilot (team decision
  // 2026-09-29). Set to 'IND' before any public launch unless a legal opinion says otherwise.
  EXCLUDED_COUNTRIES: z.string().default(''),
  SELF_API_KEY: z.string().optional(),
  SELF_FLOW_ID_BORROWER: z.string().optional(),
  SELF_FLOW_ID_GUARANTOR: z.string().optional(),
  SELF_WEBHOOK_SECRET: z.string().optional(),
  RELAY_MAX_TX_PER_SENDER_PER_DAY: z.coerce.number().default(200),
  ADMIN_TOKEN: z.string().min(24).optional(),
})

export const env = Env.parse(raw)

const deploymentsFile = resolve(root, `deployments/${env.TEMPO_NETWORK}.json`)
const deployed = existsSync(deploymentsFile) ? JSON.parse(readFileSync(deploymentsFile, 'utf8')) : {}

export const net: Network = getNetwork(env.TEMPO_NETWORK, {
  registry: deployed.registry as Address | undefined,
  lineBook: deployed.lineBook as Address | undefined,
  creditTerms: deployed.creditTerms as Address | undefined,
  collateralVault: deployed.collateralVault as Address | undefined,
  deployBlock: deployed.deployBlock ? BigInt(deployed.deployBlock) : undefined,
})
if (!net.registry || !net.lineBook) throw new Error(`no deployment found at ${deploymentsFile}`)

/** Collateral that earns: a Tempo Earn vault and the CollateralVault that holds its shares (null until deployed). */
export const earn = deployed.earnVault && deployed.earnShare && deployed.earnCollateralVault
  ? {
      vault: deployed.earnVault as Address,
      share: deployed.earnShare as Address,
      collateral: deployed.earnCollateralVault as Address,
      // testnet demo venue whose yield is simulated (DemoYieldVenue); null on mainnet, where the venue is real
      simVenue: (env.TEMPO_NETWORK === 'testnet' ? deployed.yieldVenue ?? null : null) as Address | null,
    }
  : null

/** Origins as browsers send them: no trailing slash, no path. */
export const webOrigins = env.WEB_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
export const publicWebOrigin = env.PUBLIC_WEB_ORIGIN.trim().replace(/\/+$/, '')
export const androidAppOrigins = env.ANDROID_APP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
export const passkeyRpId = env.PASSKEY_RP_ID?.trim() || new URL(publicWebOrigin).hostname

export const tiers = env.TIERS.split(',').map((s) => BigInt(s.trim()))
export const excludedCountries = new Set(env.EXCLUDED_COUNTRIES.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
export const keys = {
  treasury: env.TREASURY_PK as Hex,
  attester: env.ATTESTER_PK as Hex,
  servicer: env.SERVICER_PK as Hex,
  settlement: env.SETTLEMENT_PK as Hex,
}
