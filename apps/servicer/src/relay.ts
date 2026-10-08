import type { Address } from 'viem'
import { Transaction } from 'viem/tempo'
import { Handler } from 'tempo.ts/server'
import { ACCOUNT_KEYCHAIN } from '@keycard/sdk'
import { earn, env, net, webOrigins } from './config'
import { publicClient, treasury } from './chain'
import { sql } from './db'

/**
 * Fee-sponsorship relay (Tempo's official tempo.ts Handler.feePayer), speaking the protocol viem's
 * `withRelay` transport expects (eth_signRawTransaction / eth_sendRawTransaction[Sync]).
 *
 * Policy (we only pay fees for KEYKARD activity):
 *   - sender must be a KEYKARD user wallet, credit account or guarantor wallet
 *   - every call must target the line token, the AccountKeychain precompile or the CollateralVault
 *     (an empty call list is allowed only when the tx carries a keyAuthorization)
 *   - per-sender daily cap
 */
const counts = new Map<string, { day: string; n: number }>()
const lower = (a: string) => a.toLowerCase() as Address

async function isKnownSender(a: Address): Promise<boolean> {
  const [r] = await sql`
    SELECT 1 FROM users WHERE wallet=${a}
    UNION SELECT 1 FROM lines WHERE credit_account=${a}
    LIMIT 1`
  return Boolean(r)
}

export class RelayPolicyError extends Error {}

export async function checkRelayPolicy(serialized: `0x${string}`) {
  const tx = Transaction.deserialize(serialized as any) as any
  const from = tx.from ? lower(tx.from) : null
  if (!from) throw new RelayPolicyError('unsigned transaction')
  if (!(await isKnownSender(from))) throw new RelayPolicyError('sender is not a KEYKARD account')
  const calls: { to?: string; data?: string; value?: bigint }[] = tx.calls ?? (tx.to ? [{ to: tx.to, data: tx.data }] : [])
  if (calls.length === 0 && !tx.keyAuthorization) throw new RelayPolicyError('empty transaction')
  for (const c of calls) {
    const to = c.to ? lower(c.to) : ''
    // viem attaches a no-op call (to 0x0, no data, no value) when a tx only carries a keyAuthorization
    const noop = /^0x0{40}$/.test(to) && (!c.data || c.data === '0x') && !c.value
    if (noop && tx.keyAuthorization) continue
    const vault = net.collateralVault ? lower(net.collateralVault) : null
    // collateral that earns: the Earn vault, its share token and the vault that locks the shares
    const earnTargets = earn ? [earn.vault, earn.share, earn.collateral].map(lower) : []
    if (to !== lower(net.token) && to !== lower(ACCOUNT_KEYCHAIN) && to !== vault && !earnTargets.includes(to as Address)) throw new RelayPolicyError(`call target not sponsored: ${to}`)
  }
  const day = new Date().toISOString().slice(0, 10)
  const c = counts.get(from)
  const n = c && c.day === day ? c.n + 1 : 1
  if (n > env.RELAY_MAX_TX_PER_SENDER_PER_DAY) throw new RelayPolicyError('daily sponsorship limit reached')
  counts.set(from, { day, n })
}

export const relayHandler = Handler.feePayer({
  account: treasury as any,
  client: publicClient as any,
  path: '/relay',
  cors: { origin: webOrigins },
  async onRequest(request: any) {
    const serialized = request?.params?.[0]
    if (typeof serialized === 'string') await checkRelayPolicy(serialized as `0x${string}`)
  },
})
