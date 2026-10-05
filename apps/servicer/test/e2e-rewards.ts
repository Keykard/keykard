/**
 * Rewards end-to-end (merchant fee, 0.5% cashback, merchant offers with budgets, per-merchant fee, fee shield) against
 * a RUNNING servicer on Tempo testnet. Run the servicer with PERIOD_SECONDS=60 GRACE_SECONDS=300.
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


const pays = async (lineId: number) => sql`SELECT * FROM payments WHERE line_id=${lineId} ORDER BY id`
async function payAt(card: any, settle: Address, code: string, amount: string) {
  const r = (await rl(() => Actions.token.transferSync(card, { token: net.token, to: settle, amount: u(amount), memo: encodePayMemo(code), feePayer: true } as any))) as any
  return r.receipt.status === 'success'
}
const settled = (lineId: number, n: number) =>
  waitFor(`${n} payments settled + cashback paid`, async () => {
    const ps = await pays(lineId)
    return ps.length >= n && ps.slice(0, n).every((p: any) => p.settle_tx && ['paid', 'none'].includes(p.cashback_status)) ? ps : null
  }, 120)

async function offersAndFees(settle: Address) {
  const m = await makeMerchant('Rewards Cafe')
  const mt = mintSession(m.wallet)
  const o = await api('/api/merchant/offers', { token: mt, body: { pctBps: 1000, maxPerPayment: u('2').toString(), budget: u('1.2').toString(), endsAt: null } })
  check('merchant created a 10% offer (max $2, budget $1.20) from the dashboard', o.pctBps === 1000 && o.status === 'active')
  const pub = await api(`/api/merchants/${m.code}`)
  check('customers see the offer on the shop', pub.offer?.pctBps === 1000)
  const cfg = await api('/api/config')
  check('config publishes the reward terms (1% fee, 0.5% back)', cfg.rewards?.merchantFeeBps === 100 && cfg.rewards?.baseCashbackBps === 50)
  check('shop with an offer is listed with its % back', cfg.merchants.find((x: any) => x.code === m.code)?.offerPctBps === 1000)

  const x = await borrower('R')
  const mBefore = await bal(m.wallet)
  check('R: paid $5 at the shop', await payAt(x.card, settle, m.code, '5'))
  let ps = await settled(x.lineId, 1)
  const p1 = ps![0]
  check('split: fee $0.05 · 0.5% back $0.025 · offer $0.50 · shop gets $4.45',
    p1.fee === u('0.05').toString() && p1.base_cashback === u('0.025').toString() && p1.offer_cashback === u('0.5').toString() && p1.merchant_net === u('4.45').toString(),
    `fee=${p1.fee} base=${p1.base_cashback} offer=${p1.offer_cashback} net=${p1.merchant_net}`)
  check('shop received exactly $4.45 on-chain', (await bal(m.wallet)) - mBefore === u('4.45'))
  const me1 = await api('/api/me', { token: x.token })
  check('cashback paid down the bill: owed $4.475, spendable $15.525', me1.line.owed === u('4.475').toString() && me1.line.spendable === u('15.525').toString(), `owed=${me1.line.owed} spendable=${me1.line.spendable}`)

  check('R: paid $5 again', await payAt(x.card, settle, m.code, '5'))
  check('R: paid $5 a third time', await payAt(x.card, settle, m.code, '5'))
  ps = await settled(x.lineId, 3)
  check('offer budget enforced: $0.50 + $0.50 + $0.20 = $1.20 exactly', ps![1].offer_cashback === u('0.5').toString() && ps![2].offer_cashback === u('0.2').toString(), `${ps![1].offer_cashback}/${ps![2].offer_cashback}`)
  const dash = await api('/api/merchant/me', { token: mt })
  check('dashboard: offer used up, stats show 3 payments / 1 customer / $1.20 given', dash.offer.ended === true && dash.stats.payments === 3 && dash.stats.customers === 1 && dash.stats.cashback === u('1.2').toString(), JSON.stringify(dash.stats))
  check('dashboard shows the 1% fee and fees paid', dash.feeBps === 100 && dash.feesPaid === u('0.15').toString(), `fee=${dash.feeBps} paid=${dash.feesPaid}`)

  // new offer, paused → no offer cashback; then KEYKARD sets this shop to 0% fee
  const o2 = await api('/api/merchant/offers', { token: mt, body: { pctBps: 500, maxPerPayment: u('1').toString(), budget: u('5').toString(), endsAt: null } })
  await api(`/api/merchant/offers/${o2.id}/pause`, { token: mt, method: 'POST' })
  check('R: paid $2 while the offer is paused', await payAt(x.card, settle, m.code, '2'))
  ps = await settled(x.lineId, 4)
  check('paused offer gives nothing; base 0.5% still paid', ps![3].offer_cashback === '0' && ps![3].base_cashback === u('0.01').toString())
  await api(`/api/admin/merchants/${m.code}/fee`, { token: env.ADMIN_TOKEN!, body: { feeBps: 0 } })
  await api(`/api/merchant/offers/${o2.id}/resume`, { token: mt, method: 'POST' })
  check('R: paid $2 at 0% fee with the offer resumed', await payAt(x.card, settle, m.code, '2'))
  ps = await settled(x.lineId, 5)
  check('0% fee shop: no fee, no base cashback (never more than the fee), offer 5% = $0.10', ps![4].fee === '0' && ps![4].base_cashback === '0' && ps![4].offer_cashback === u('0.1').toString() && ps![4].merchant_net === u('1.9').toString(), `fee=${ps![4].fee} base=${ps![4].base_cashback} offer=${ps![4].offer_cashback}`)
  const act = await api('/api/me/activity', { token: x.token })
  check('activity shows cashback on each payment', act.spends.filter((s: any) => BigInt(s.base_cashback) + BigInt(s.offer_cashback) > 0n).length >= 4)
}

/** 3 on-time bills in a row earn a fee shield; the next missed bill uses it instead of a late fee. */
async function feeShield(settle: Address, code: string) {
  const x = await borrower('S')
  await fund(x.wallet) // auto-pay can pay every bill
  for (let i = 1; i <= 3; i++) {
    check(`S: spent $1 before bill ${i}`, await payAt(x.card, settle, code, '1'))
    const ok = await waitFor(`on-time bill ${i}`, async () => { const m = await me(x.token); return m.line.onTimeStreak >= i ? m : null }, env.PERIOD_SECONDS + 120)
    check(`S: bill ${i} paid on time (streak ${i})`, Boolean(ok), `streak=${ok?.line.onTimeStreak} shields=${ok?.line.feeShields}`)
  }
  const m3 = await me(x.token)
  check('S: 3 on time in a row earned a fee shield', m3.line.feeShields === 1)
  const rest = await bal(x.wallet)
  await rl(() => Actions.token.transferSync(x.root, { token: net.token, to: privateKeyToAccount(generatePrivateKey()).address, amount: rest, feePayer: true } as any))
  check('S: spent $2 with an empty wallet', await payAt(x.card, settle, code, '2'))
  const g = await waitFor('missed bill', async () => { const m = await me(x.token); return m.line.status === 'grace' ? m : null }, env.PERIOD_SECONDS + 120)
  await sleep(8)
  const after = await me(x.token)
  check('S: missed bill → grace, but the shield cancelled the late fee', Boolean(g) && after.line.feesDue === '0' && after.line.feeShields === 0 && after.line.onTimeStreak === 0, `fees=${after.line.feesDue} shields=${after.line.feeShields} streak=${after.line.onTimeStreak}`)
  const [used] = await sql`SELECT 1 FROM audit_log WHERE line_id=${x.lineId} AND action='reward.shield_used'`
  check('S: shield use recorded', Boolean(used))
}

async function main() {
  const cfg = await api('/api/config')
  const shop = await makeMerchant('Shield Shop')
  // offers need bills far apart (PERIOD_SECONDS=600); the fee shield needs them fast (PERIOD_SECONDS=60)
  const part = process.env.PART ?? 'all'
  if (part === 'offers') await offersAndFees(cfg.settlement)
  else if (part === 'shield') await feeShield(cfg.settlement, shop.code)
  else await Promise.all([offersAndFees(cfg.settlement), feeShield(cfg.settlement, shop.code)])
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`)
  await sql.end()
}
main().catch(async (e) => {
  console.error('E2E FATAL', e)
  process.exitCode = 1
  await sql.end()
})
