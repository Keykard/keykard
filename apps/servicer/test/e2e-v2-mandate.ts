/**
 * v2 end-to-end (fees for missed bills, repay from any wallet, 1:1 secured line, collateral on default) against a
 * RUNNING servicer on Tempo testnet. Run the servicer with PERIOD_SECONDS=90 GRACE_SECONDS=200.
 * Based on e2e-default.ts: Real transactions, real relay,
 * real scheduler/watcher. Only the phone is simulated (headless WebAuthn signer) and the Self
 * webhook is signed with the test webhook secret the servicer is configured with.
 *
 *   TEMPO_NETWORK=testnet PERIOD_SECONDS=90 GRACE_SECONDS=60 SELF_WEBHOOK_SECRET=whsec_... \
 *   SELF_FLOW_ID_BORROWER=flow-b SELF_FLOW_ID_GUARANTOR=flow-g SELF_API_KEY=sk_test_x npx tsx src/main.ts
 *   ... then in another shell with the same env:  npx tsx test/e2e.ts
 */
import { randomUUID } from 'node:crypto'
import { createClient, encodeFunctionData, erc20Abi, http, parseUnits, type Address, type Hex } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account, Actions, withRelay } from 'viem/tempo'
import { P256, PublicKey } from 'ox'
import { Webhook } from 'svix'
import { collateralVaultAbi, mandateKeyPolicy, encodePayMemo } from '@keycard/sdk'
import { KeyAuthorization } from 'ox/tempo'
import { env, net } from '../src/config'
import { sql } from '../src/db'
import { mintSession } from '../src/auth'

const API = `http://localhost:${env.PORT}`
const u = (n: string) => parseUnits(n, 6)
const chain = net.chain.extend({ feeToken: net.feeToken })
const relayTransport = withRelay(http(net.rpcUrl), http(`${API}/relay`), { policy: 'sign-only' })
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))
const results: string[] = []
function check(name: string, ok: boolean, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`
  console.log(line)
  results.push(line)
  if (!ok) process.exitCode = 1
}

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const r = await fetch(API + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`)
  return j
}

function makePasskey() {
  const pk = P256.randomPrivateKey()
  const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey: pk })) as Hex
  const root = Account.fromHeadlessWebAuthn(pk, { rpId: 'localhost', origin: 'http://localhost:3000' } as any)
  return { pk, publicKey, root, id: randomUUID() }
}

async function selfVerify(wallet: Address, role: 'borrower' | 'guarantor', nullifier: string) {
  const externalUuid = randomUUID()
  const flowId = role === 'guarantor' ? env.SELF_FLOW_ID_GUARANTOR! : env.SELF_FLOW_ID_BORROWER!
  await sql`INSERT INTO self_sessions (id, wallet, role, status, external_uuid, flow_id) VALUES (${'sess_' + externalUuid}, ${wallet}, ${role}, 'pending', ${externalUuid}, ${flowId})`
  const payload = JSON.stringify({
    type: 'verification.completed', verification_id: randomUUID(), external_uuid: externalUuid, flow_id: flowId,
    flow_version_id: 'v1', environment: 'test', status: 'valid', product: 'pre_kyc',
    proof_attributes: role === 'guarantor' ? { nationality: 'PHL' } : {}, proof: null, nullifier,
    verified_at: new Date().toISOString(), storage_state: 'skipped', storage_uri: null,
  })
  const id = 'msg_' + randomUUID()
  const ts = new Date()
  const sig = new Webhook(env.SELF_WEBHOOK_SECRET!).sign(id, ts, payload)
  const r = await fetch(`${API}/api/self/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(Math.floor(ts.getTime() / 1000)), 'svix-signature': sig },
    body: payload,
  })
  return r.ok
}

const bal = async (a: Address) =>
  ((await Actions.token.getBalance(createClient({ chain, transport: http(net.rpcUrl) }), { account: a, token: net.token } as any)) as any).amount as bigint

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutS: number): Promise<T | null> {
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < timeoutS) {
    const v = await fn()
    if (v) return v as T
    await sleep(5)
  }
  console.log(`timeout waiting for ${label}`)
  return null
}

if (process.env.E2E_TRACE) {
  const f = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const r = await f(url, init)
    const t = await r.clone().text()
    try { JSON.parse(t) } catch { console.log('NON-JSON', String(url), r.status, t.slice(0, 200), String(init?.body ?? '').slice(0, 200)) }
    return r
  }) as any
}


async function makeMerchant(label: string) {
  const mk = makePasskey()
  const r = await api('/api/users', { body: { role: 'merchant', passkeyId: mk.id, passkeyPublicKey: mk.publicKey, residenceCountry: 'PHL', residenceConfirmed: true } })
  await selfVerify(r.wallet, 'borrower', 'nullifier-' + randomUUID())
  const t = mintSession(r.wallet)
  const m = await api('/api/merchants', { token: t, body: { label } })
  return { ...m, wallet: r.wallet as Address }
}


const toUsd = (v: bigint | string) => (Number(v) / 1e6).toFixed(2)
/** the public testnet RPC rate-limits bursts; a rejected send never reached the chain, so retrying is safe */
async function rl<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e: any) {
      if (i > 6 || !/rate limit|exceeds defined limit|429/i.test(String(e?.details ?? e?.message ?? e))) throw e
      await sleep(0.4 * 2 ** i)
    }
  }
}

async function borrower(label: string) {
  const b = makePasskey()
  const reg = await api('/api/users', { body: { role: 'borrower', passkeyId: b.id, passkeyPublicKey: b.publicKey, residenceCountry: 'MEX', residenceConfirmed: true } })
  const wallet = reg.wallet as Address
  const token = mintSession(wallet)
  await selfVerify(wallet, 'borrower', 'nullifier-' + randomUUID())
  const prep = await api('/api/lines/prepare', { token, method: 'POST' })
  const root = createClient({ account: b.root, chain, transport: relayTransport })
  const pol = mandateKeyPolicy({ token: net.token, instalment: BigInt(prep.mandate.cap), period: prep.mandate.periodSeconds, repayTo: prep.mandate.recipient, expiry: prep.mandate.expiry })
  await rl(() => Actions.accessKey.authorizeSync(root, { accessKey: { address: prep.mandate.keyId, type: 'secp256k1' }, ...pol, feePayer: true } as any))
  const line = await api(`/api/lines/${prep.lineId}/open`, { token, method: 'POST' })
  check(`${label}: line opened, auto-pay cap covers secured limits`, line.status === 'active' && BigInt(prep.mandate.cap) >= u('600'), `cap=${toUsd(prep.mandate.cap)}`)
  const spendKey = Account.fromHeadlessWebAuthn(b.pk, { access: line.creditAccount, rpId: 'localhost', origin: 'http://localhost:3000' } as any)
  const card = createClient({ account: spendKey, chain, transport: relayTransport })
  return { b, wallet, token, lineId: prep.lineId as number, line, root, card }
}

const me = (token: string) => api('/api/me', { token })
const funder = () => {
  const acct = Account.fromSecp256k1(generatePrivateKey())
  return { acct, client: createClient({ account: acct, chain, transport: http(net.rpcUrl) }) }
}
async function fund(a: Address) {
  await Actions.faucet.fund(createClient({ chain, transport: http(net.rpcUrl) }), { account: a })
  await waitFor('faucet', async () => (await bal(a)) > 0n, 90)
}


/** C: a line opened before secured limits (auto-pay cap $100) adds collateral past the cap → signs a bigger auto-pay. */
async function main() {
  const x = await borrower('C')
  await sql`UPDATE lines SET mandate_cap=${u('100').toString()} WHERE id=${x.lineId}` // as old lines were opened
  await fund(x.wallet)
  const cfg = await api('/api/config')
  const vault = cfg.collateralVault as Address
  const amount = u('90') // $20 + $90 = $110 > $100 cap
  const prep = await api('/api/collateral/prepare', { token: x.token, body: { amount: amount.toString() } })
  check('C: prepare asks for a bigger auto-pay', Boolean(prep.mandate) && BigInt(prep.mandate.cap) === u('600'), `cap=${prep.mandate?.cap}`)
  const m = prep.mandate
  const pol = mandateKeyPolicy({ token: net.token, instalment: BigInt(m.cap), period: m.periodSeconds, repayTo: m.recipient, expiry: m.expiry })
  const ka = await Actions.accessKey.signAuthorization(x.root, { accessKey: { address: m.keyId, type: 'secp256k1' }, ...pol } as any)
  const keyAuthorization = KeyAuthorization.serialize(ka as any)
  const dep = (await rl(() => sendTransactionSync(x.root, {
    calls: [
      { to: net.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amount] }) },
      { to: vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [amount] }) },
    ],
    feePayer: true,
  } as any))) as any
  check('C: deposited $90', dep.status === 'success')
  let refused = false
  try { await api('/api/collateral/confirm', { token: x.token, body: { amount: amount.toString() } }) } catch { refused = true }
  check('C: confirm without the new auto-pay is refused', refused)
  const conf = await api('/api/collateral/confirm', { token: x.token, body: { amount: amount.toString(), keyAuthorization } })
  check('C: limit $110 with the new $600 auto-pay active', conf.limit === u('110').toString() && conf.mandateActive && conf.mandateCap === u('600').toString(), `limit=${conf.limit} cap=${conf.mandateCap} active=${conf.mandateActive}`)
  const [row] = await sql`SELECT repay_key_id FROM lines WHERE id=${x.lineId}`
  check('C: line now uses the new auto-pay key', row.repay_key_id.toLowerCase() === m.keyId.toLowerCase())
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`)
  await sql.end()
}
main().catch(async (e) => {
  console.error('E2E FATAL', e)
  process.exitCode = 1
  await sql.end()
})
