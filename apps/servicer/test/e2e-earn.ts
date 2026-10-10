/**
 * Collateral that earns, end to end against a RUNNING servicer on Tempo testnet: lock stablecoins in the Tempo Earn
 * vault (one passkey tx), limit +95% of value, simulated yield raises the value, unlock → stablecoins back with the
 * yield; and a default where KEYKARD takes only enough Earn shares to cover the debt and releases the rest.
 * Run the servicer with PERIOD_SECONDS=90 GRACE_SECONDS=200 EARN_SIM_EVERY_SECONDS=20 EARN_SIM_APR_BPS=2000.
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
import { readContract } from 'viem/actions'
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


const send = (x: { root: any }, calls: { to: Address; data: Hex }[]) => rl(() => sendTransactionSync(x.root, { calls, feePayer: true } as any)) as Promise<any>

/** E: lock & earn $20 → limit $20 + $20, yield accrues, unlock → $20+ back in the wallet. */
async function lockEarnUnlock() {
  const x = await borrower('E')
  await fund(x.wallet)
  const cfg = await api('/api/config')
  check('E: config publishes Earn (simulated, 1:1 on testnet)', Boolean(cfg.earn?.vault) && cfg.earn.simulated === true && cfg.earn.ltvBps === 10000, JSON.stringify(cfg.earn))
  const prep = await api('/api/earn/prepare', { token: x.token, body: { amount: u('20').toString() } })
  check('E: prepare: $20 more limit (1:1), no new auto-pay, 4 calls', prep.credit === u('20').toString() && prep.mandate === null && prep.calls.length === 4, `credit=${prep.credit}`)
  const before = await bal(x.wallet)
  const dep = await send(x, prep.calls)
  check('E: Earn deposit + lock in ONE passkey transaction, fee sponsored', dep.status === 'success', dep.transactionHash)
  check('E: $20 left the wallet', before - (await bal(x.wallet)) === u('20'))
  const line = await api('/api/earn/confirm', { token: x.token, body: {} })
  const m1 = await me(x.token)
  const credit = BigInt(line.securedEarn)
  check('E: limit grew 1:1 with the Earn value', credit >= u('19.99') && credit <= u('20') && BigInt(line.limit) === u('20') + credit, `limit=${line.limit} securedEarn=${line.securedEarn}`)
  check('E: card can spend the new limit', m1.line.spendable === line.limit, `spendable=${m1.line.spendable}`)
  check('E: /api/me shows the locked Earn position (≤0.01% dust)', BigInt(m1.earn?.lockedShares ?? 0) > 0n && BigInt(m1.earn.value) >= u('19.998'), JSON.stringify(m1.earn))
  let blocked = false
  try {
    await send(x, [{ to: cfg.earn.collateralVault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [1n] }) }])
  } catch { blocked = true }
  check('E: locked Earn shares cannot be withdrawn', blocked)
  const grown = await waitFor('E simulated yield', async () => { const m = await me(x.token); return BigInt(m.earn?.earned ?? 0) > 0n ? m : null }, 200)
  check('E: simulated yield → the collateral earned', Boolean(grown), `earned=${grown?.earn?.earned} value=${grown?.earn?.value}`)
  const [y] = await sql`SELECT tx_hash FROM audit_log WHERE action='earn.yield_simulated' ORDER BY id DESC LIMIT 1`
  check('E: every simulated top-up is a public transaction', Boolean(y?.tx_hash), y?.tx_hash)

  const value = BigInt((await me(x.token)).earn.value)
  const rel = await api('/api/earn/release', { token: x.token, method: 'POST' })
  check('E: unlock → limit back to $20', rel.line.limit === u('20').toString() && rel.line.securedEarn === '0', `limit=${rel.line.limit}`)
  const b0 = await bal(x.wallet)
  const out = await send(x, rel.calls)
  const back = (await bal(x.wallet)) - b0
  check('E: withdraw + redeem in one tx → stablecoins back with the yield', out.status === 'success' && back >= (value * 999n) / 1000n && back > u('20') - 1n, `back=${back} value=${value}`)
  const m2 = await me(x.token)
  check('E: nothing left locked or withdrawable', m2.earn.lockedShares === '0' && BigInt(m2.earn.withdrawable) < 10n, JSON.stringify(m2.earn))
}

/** F: lock $10 in Earn, spend $25, default → KEYKARD takes only what covers the debt, the rest goes back. */
async function earnDefault(settle: Address, code: string) {
  const x = await borrower('F')
  await fund(x.wallet)
  const prep = await api('/api/earn/prepare', { token: x.token, body: { amount: u('10').toString() } })
  const dep = await send(x, prep.calls)
  check('F: locked $10 in Earn', dep.status === 'success')
  const line = await api('/api/earn/confirm', { token: x.token, body: {} })
  check('F: limit ~$30 (1:1)', BigInt(line.limit) >= u('29.99'), `limit=${line.limit}`)
  const rest = await bal(x.wallet)
  await Actions.token.transferSync(x.root, { token: net.token, to: privateKeyToAccount(generatePrivateKey()).address, amount: rest, feePayer: true } as any)
  const s = (await rl(() => Actions.token.transferSync(x.card, { token: net.token, to: settle, amount: u('25'), memo: encodePayMemo(code), feePayer: true } as any))) as any
  check('F: spent $25 (more than the unsecured $20)', s.receipt.status === 'success')
  const d = await waitFor('F default + Earn seize', async () => {
    const [booked] = await sql`SELECT amount, tx_hash FROM movements WHERE line_id=${x.lineId} AND memo LIKE 'SEIZE-EARN:%'`
    const m = await me(x.token)
    return booked && m.earn?.lockedShares === '0' ? { m, booked } : null
  }, env.PERIOD_SECONDS + env.GRACE_SECONDS + 300)
  const [def] = await sql`SELECT detail->>'unpaid' AS unpaid FROM audit_log WHERE line_id=${x.lineId} AND action='line.defaulted'`
  const unpaid = BigInt(def?.unpaid ?? 0)
  const took = BigInt(d?.booked.amount ?? 0)
  check('F: after default KEYKARD took Earn collateral covering the debt (all $10 needed here)', took > u('9.9') && took <= u('10.1'), `took=${took} unpaid=${unpaid}`)
  check('F: the uncovered rest is still owed', d?.m.line.status === 'defaulted' && BigInt(d!.m.line.amountDue) === unpaid - took, `due=${d?.m.line.amountDue}`)
}

/** G: lock $10, spend only $4, default → shares worth ~$5 (bill + late fee) cover it, the other ~$5 come back. */
async function earnPartialDefault(settle: Address, code: string) {
  const x = await borrower('G')
  await fund(x.wallet)
  const prep = await api('/api/earn/prepare', { token: x.token, body: { amount: u('10').toString() } })
  await send(x, prep.calls)
  await api('/api/earn/confirm', { token: x.token, body: {} })
  const rest = await bal(x.wallet)
  await Actions.token.transferSync(x.root, { token: net.token, to: privateKeyToAccount(generatePrivateKey()).address, amount: rest, feePayer: true } as any)
  await rl(() => Actions.token.transferSync(x.card, { token: net.token, to: settle, amount: u('4'), memo: encodePayMemo(code), feePayer: true } as any))
  const d = await waitFor('G default + partial seize', async () => {
    const [booked] = await sql`SELECT amount FROM movements WHERE line_id=${x.lineId} AND memo LIKE 'SEIZE-EARN:%'`
    const m = await me(x.token)
    return booked && m.earn?.lockedShares === '0' && m.line.status === 'settled' ? { m, booked } : null
  }, env.PERIOD_SECONDS + env.GRACE_SECONDS + 300)
  check('G: line settled from Earn collateral alone', d?.m.line.status === 'settled' && BigInt(d?.m.line.amountDue ?? 1) === 0n, `status=${d?.m.line.status} due=${d?.m.line.amountDue}`)
  const back = BigInt(d?.m.earn?.withdrawable ?? 0)
  check('G: the shares not needed went back to the borrower (~$5)', back > u('4') && back < u('6'), `withdrawable=${back} took=${d?.booked.amount}`)
  const w = await api('/api/earn/withdraw', { token: x.token, method: 'POST' })
  const b0 = await bal(x.wallet)
  const out = await send(x, w.calls)
  check('G: borrower redeemed the returned shares to stablecoins', out.status === 'success' && (await bal(x.wallet)) - b0 >= (back * 999n) / 1000n)
}

async function main() {
  const cfg = await api('/api/config')
  const shop = await makeMerchant('Earn Shop')
  await Promise.all([lockEarnUnlock(), earnDefault(cfg.settlement, shop.code), earnPartialDefault(cfg.settlement, shop.code)])
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`)
  await sql.end()
}
main().catch(async (e) => {
  console.error('E2E FATAL', e)
  process.exitCode = 1
  await sql.end()
})
