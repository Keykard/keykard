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

/** A: miss a bill → late fee → penalty interest → repaid from a DIFFERENT wallet → cured, fees paid, extra refunded. */
async function feesAndExternalRepay(settle: Address, code: string) {
  const x = await borrower('A')
  const s = (await rl(() => Actions.token.transferSync(x.card, { token: net.token, to: settle, amount: u('10'), memo: encodePayMemo(code), feePayer: true } as any))) as any
  check('A: spent $10', s.receipt.status === 'success')
  const grace = await waitFor('A grace + late fee', async () => { const m = await me(x.token); return m.line.status === 'grace' && BigInt(m.line.feesDue) > 0n ? m : null }, env.PERIOD_SECONDS + 150)
  check('A: missed bill → grace with a $1 late fee', grace?.line.feesDue === u('1').toString(), `due=${grace?.line.amountDue} fees=${grace?.line.feesDue}`)
  const pen = await waitFor('A penalty', async () => { const m = await me(x.token); return BigInt(m.line.feesDue) > u('1') ? m : null }, env.PERIOD_SECONDS + 90)
  check('A: penalty interest 2% of $10 one period later', pen?.line.feesDue === u('1.2').toString(), `fees=${pen?.line.feesDue}`)
  const [ch] = await sql`SELECT count(*)::int AS n FROM line_charges WHERE line_id=${x.lineId}`
  check('A: both charges recorded with on-chain receipts', ch.n === 2)

  const repayTo = pen!.line.repayAccount as Address
  check('A: line has its own repayment address', /^0x[0-9a-f]{40}$/.test(repayTo ?? ''))
  const f = funder()
  await fund(f.acct.address)
  const total = BigInt(pen!.line.totalDue)
  const before = await bal(x.wallet)
  const sent = total + u('0.5')
  const t = (await rl(() => Actions.token.transferSync(f.client, { token: net.token, to: repayTo, amount: sent } as any))) as any
  check(`A: a different wallet sent ${toUsd(sent)} to the repayment address`, t.receipt.status === 'success')
  const cured = await waitFor('A cured', async () => { const m = await me(x.token); return m.line.status === 'active' && m.line.totalDue === '0' ? m : null }, 120)
  check('A: line cured, nothing due, no fees due', Boolean(cured), `status=${cured?.line.status} spendable=${cured?.line.spendable}`)
  check('A: credit restored to the full limit', cured?.line.available === cured?.line.limit, `available=${cured?.line.available}`)
  const [rep] = await sql`SELECT applied FROM external_repayments WHERE line_id=${x.lineId}`
  const leftover = BigInt(rep?.applied?.leftover ?? -1)
  const refunded = await waitFor('A refund', async () => ((await bal(x.wallet)) - before === leftover ? true : null), 60)
  check('A: the extra went back to the borrower’s KEYKARD wallet', Boolean(refunded) && leftover > 0n, `leftover=${toUsd(leftover)}`)
  check('A: fees booked as paid', cured?.line.feesPaid === pen?.line.feesDue || BigInt(cured?.line.feesPaid ?? 0) >= u('1.2'), `paid=${cured?.line.feesPaid}`)
}

/** B: deposit collateral (one batched tx), limit +1:1, release part + withdraw, then default → vault covers it. */
async function securedAndDefault(settle: Address, code: string) {
  const x = await borrower('B')
  await fund(x.wallet)
  const cfg = await api('/api/config')
  const vault = cfg.collateralVault as Address
  const prep = await api('/api/collateral/prepare', { token: x.token, body: { amount: u('15').toString() } })
  check('B: collateral prepare needs no new auto-pay', prep.mandate === null, `newLimit=${prep.newLimit}`)
  const dep = (await rl(() => sendTransactionSync(x.root, {
    calls: [
      { to: net.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, u('15')] }) },
      { to: vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [u('15')] }) },
    ],
    feePayer: true,
  } as any))) as any
  check('B: approve + deposit $15 in ONE passkey transaction, fee sponsored', dep.status === 'success')
  const conf = await api('/api/collateral/confirm', { token: x.token, body: { amount: u('15').toString() } })
  check('B: limit $20 → $35 (1:1), $15 locked', conf.limit === u('35').toString() && conf.secured === u('15').toString())
  const m1 = await me(x.token)
  check('B: card can spend the full $35', m1.line.spendable === u('35').toString(), `spendable=${m1.line.spendable}`)
  check('B: vault shows $15 locked', m1.collateral?.locked === u('15').toString())

  const rel = await api('/api/collateral/release', { token: x.token, body: { amount: u('5').toString() } })
  check('B: released $5 → limit $30', rel.limit === u('30').toString() && rel.secured === u('10').toString())
  const w = (await rl(() => sendTransactionSync(x.root, { to: vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [u('5')] }), feePayer: true } as any))) as any
  check('B: borrower withdrew the released $5 themselves', w.status === 'success')
  let blocked = false
  try {
    await rl(() => sendTransactionSync(x.root, { to: vault, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [u('1')] }), feePayer: true } as any))
  } catch { blocked = true }
  check('B: locked collateral cannot be withdrawn', blocked)

  // empty the wallet so the next bill is missed, then spend into the secured part
  const rest = await bal(x.wallet)
  await Actions.token.transferSync(x.root, { token: net.token, to: privateKeyToAccount(generatePrivateKey()).address, amount: rest, feePayer: true } as any)
  const s = (await rl(() => Actions.token.transferSync(x.card, { token: net.token, to: settle, amount: u('25'), memo: encodePayMemo(code), feePayer: true } as any))) as any
  check('B: spent $25 (more than the unsecured $20)', s.receipt.status === 'success')
  // the vault pays on-chain first; the line's numbers follow a moment later, once the seizure is booked
  const d = await waitFor('B default', async () => {
    const [booked] = await sql`SELECT 1 FROM movements WHERE line_id=${x.lineId} AND kind='SEIZE'`
    const m = await me(x.token)
    return booked && ['defaulted', 'settled'].includes(m.line.status) && m.collateral?.locked === '0' ? m : null
  }, env.PERIOD_SECONDS + env.GRACE_SECONDS + 240)
  const [seize] = await sql`SELECT amount, tx_hash FROM movements WHERE line_id=${x.lineId} AND kind='SEIZE'`
  check('B: after default the vault paid $10 of collateral to KEYKARD', seize?.amount === u('10').toString(), seize?.tx_hash)
  check('B: what collateral didn’t cover is still owed', d?.line.status === 'defaulted' && d?.line.amountDue === u('15').toString(), `status=${d?.line.status} due=${d?.line.amountDue} fees=${d?.line.feesDue}`)

  const f = funder()
  await fund(f.acct.address)
  const total = BigInt(d!.line.totalDue)
  await rl(() => Actions.token.transferSync(f.client, { token: net.token, to: d!.line.repayAccount, amount: total + u('2') } as any))
  const st = await waitFor('B settled', async () => { const m = await me(x.token); return m.line.status === 'settled' ? m : null }, 150)
  check('B: repaid from another wallet after default → settled', Boolean(st), `fees paid=${st?.line.feesPaid}`)
}

async function main() {
  const cfg = await api('/api/config')
  check('config publishes the terms', cfg.terms?.lateFee === u('1').toString() && cfg.terms?.penaltyBpsPerPeriod === 200 && cfg.terms?.capBps === 2500, JSON.stringify(cfg.terms))
  const shop = await makeMerchant('v2 Shop')
  await Promise.all([feesAndExternalRepay(cfg.settlement, shop.code), securedAndDefault(cfg.settlement, shop.code)])
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`)
  await sql.end()
}
main().catch(async (e) => {
  console.error('E2E FATAL', e)
  process.exitCode = 1
  await sql.end()
})
