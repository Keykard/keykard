/**
 * Sign-up / sign-in / recovery end-to-end (password + passkey on ONE wallet, TIP-1049 admin keys) against a RUNNING
 * servicer on Tempo testnet. Run the servicer with RECOVERY_DELAY_SECONDS=20.
 * Based on e2e-default.ts: Real transactions, real relay,
 * real scheduler/watcher. Only the phone is simulated (headless WebAuthn signer) and the Self
 * webhook is signed with the test webhook secret the servicer is configured with.
 *
 *   TEMPO_NETWORK=testnet PERIOD_SECONDS=90 GRACE_SECONDS=60 SELF_WEBHOOK_SECRET=whsec_... \
 *   SELF_FLOW_ID_BORROWER=flow-b SELF_FLOW_ID_GUARANTOR=flow-g SELF_API_KEY=sk_test_x npx tsx src/main.ts
 *   ... then in another shell with the same env:  npx tsx test/e2e.ts
 */
import { randomUUID } from 'node:crypto'
import { createClient, http, parseUnits, type Address, type Hex } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account, Actions, withRelay } from 'viem/tempo'
import { P256, PublicKey, WebAuthnP256 } from 'ox'
import { Webhook } from 'svix'
import { mandateKeyPolicy, encodePayMemo } from '@keycard/sdk'
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

async function selfVerify(wallet: Address, role: 'borrower' | 'guarantor', nullifier: string, existingUuid?: string) {
  const externalUuid = existingUuid ?? randomUUID()
  const flowId = role === 'guarantor' ? env.SELF_FLOW_ID_GUARANTOR! : env.SELF_FLOW_ID_BORROWER!
  if (!existingUuid) await sql`INSERT INTO self_sessions (id, wallet, role, status, external_uuid, flow_id) VALUES (${'sess_' + externalUuid}, ${wallet}, ${role}, 'pending', ${externalUuid}, ${flowId})`
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
  return { ...(await api('/api/merchants', { token: t, body: { label } })), wallet: r.wallet as Address }
}
async function rl<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e: any) {
      if (i > 6 || !/rate limit|exceeds defined limit|429/i.test(String(e?.details ?? e?.message ?? e))) throw e
      await sleep(0.4 * 2 ** i)
    }
  }
}
const WA = { rpId: 'localhost', origin: 'http://localhost:3000' } as any

/** A password key as the browser makes it: secp256k1, its vault (stand-in for the AES ciphertext), a login proof. */
async function passwordKey() {
  const pk = generatePrivateKey()
  const address = privateKeyToAccount(pk).address.toLowerCase() as Address
  const { id: challengeId, challenge } = await api('/api/auth/register-challenge')
  const signature = await privateKeyToAccount(pk).signMessage({ message: { raw: challenge } })
  const authProof = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { pk, address, authProof, vault: { address, test: true }, keyRegistration: { challengeId, address, signature } }
}
type Pw = Awaited<ReturnType<typeof passwordKey>>
type Pk = ReturnType<typeof makePasskey>
const passkeyIn = (p: Pk) => ({ unverified: { id: p.id, publicKey: p.publicKey } })

async function signInPassword(username: string, pw: Pw) {
  const r = await api('/api/auth/password', { body: { username, authProof: pw.authProof } })
  const { challenge } = await api('/api/auth/challenge', { body: { wallet: r.wallet } })
  const keySignature = await privateKeyToAccount(pw.pk).signMessage({ message: { raw: challenge } })
  return { ...(await api('/api/auth/verify', { body: { wallet: r.wallet, keySignature } })), keyId: r.keyId as string }
}
async function signInRawKey(wallet: Address, pk: Hex) {
  const { challenge } = await api('/api/auth/challenge', { body: { wallet } })
  return api('/api/auth/verify', { body: { wallet, keySignature: await privateKeyToAccount(pk).signMessage({ message: { raw: challenge } }) } })
}
async function signInPasskey(wallet: Address, p: Pk) {
  const { challenge } = await api('/api/auth/challenge', { body: { wallet } })
  const { metadata, payload } = WebAuthnP256.getSignPayload({ challenge, ...WA })
  const sig = P256.sign({ payload, privateKey: p.pk, hash: true })
  return api('/api/auth/verify', { body: { wallet, metadata, signature: { r: sig.r.toString(), s: sig.s.toString() }, credentialId: p.id } })
}
const fails = async (fn: () => Promise<unknown>) => { try { await fn(); return false } catch { return true } }

/** Send the keychain calls KEYKARD prepared, signed by one of the user's keys, fee sponsored by the relay. */
async function sendCalls(account: any, calls: any[]) {
  const r = (await rl(() => sendTransactionSync(createClient({ account, chain, transport: relayTransport }), { calls, feePayer: true } as any))) as any
  if (r.status !== 'success') throw new Error('calls reverted')
}
const pwAdmin = (pw: Pw, wallet: Address) => Account.fromSecp256k1(pw.pk, { access: wallet })
const pkAdmin = (p: Pk, wallet: Address) => Account.fromHeadlessWebAuthn(p.pk, { ...WA, access: wallet })
async function payWith(account: any, settle: Address, code: string, amount: string) {
  try {
    const r = (await rl(() => Actions.token.transferSync(createClient({ account, chain, transport: relayTransport }), { token: net.token, to: settle, amount: u(amount), memo: encodePayMemo(code), feePayer: true } as any))) as any
    return r.receipt.status === 'success'
  } catch { return false }
}

async function main() {
  const cfg = await api('/api/config')
  const shop = await makeMerchant('Auth Shop')
  const username = `auth${Date.now().toString(36)}`

  // ---- 1. sign up: password first, then passkey + recovery key in ONE transaction ----
  check('username is free before sign-up', (await api(`/api/accounts/${username}`)).exists === false)
  const pw1 = await passwordKey()
  const reg = await api('/api/users', { body: { role: 'borrower', username, keyRegistration: pw1.keyRegistration, backup: { username, authProof: pw1.authProof, vault: pw1.vault }, residenceCountry: 'MEX', residenceConfirmed: true } })
  const wallet = reg.wallet as Address
  let token = reg.token as string
  check('sign-up with a password returns a session', Boolean(token) && wallet === pw1.address)
  const pk1 = makePasskey()
  const prep = await api('/api/credentials/prepare', { token, body: { passkey: passkeyIn(pk1), recovery: true } })
  check('KEYKARD prepared 2 keychain calls (passkey + recovery)', prep.calls.length === 2)
  await sendCalls(Account.fromSecp256k1(pw1.pk), prep.calls)
  const sec1 = await api('/api/credentials/confirm', { token, body: {} })
  check('passkey + recovery key on the wallet after ONE transaction', sec1.hasPassword && sec1.passkeys.length === 1 && sec1.recoveryOn)

  // ---- 2. sign in either way ----
  check('sign in with password', Boolean((await signInPassword(username, pw1)).token))
  check('sign in with passkey (admin key)', Boolean((await signInPasskey(wallet, pk1)).token))
  const info0 = await api(`/api/accounts/${username}`)
  check('account lookup: has password + passkey, recovery needs a passport first', info0.exists && info0.hasPassword && info0.passkeys.length === 1 && info0.recovery === false)

  // ---- 3. verify + open a line: BOTH keys can pay with the card ----
  const nullifier = 'nullifier-' + randomUUID()
  await selfVerify(wallet, 'borrower', nullifier)
  check('account lookup: recovery available once verified', (await api(`/api/accounts/${username}`)).recovery === true)
  const lp = await api('/api/lines/prepare', { token, method: 'POST' })
  const pol = mandateKeyPolicy({ token: net.token, instalment: BigInt(lp.mandate.cap), period: lp.mandate.periodSeconds, repayTo: lp.mandate.recipient, expiry: lp.mandate.expiry })
  await rl(() => Actions.accessKey.authorizeSync(createClient({ account: Account.fromSecp256k1(pw1.pk), chain, transport: relayTransport }), { accessKey: { address: lp.mandate.keyId, type: 'secp256k1' }, ...pol, feePayer: true } as any))
  const line = await api(`/api/lines/${lp.lineId}/open`, { token, method: 'POST' })
  const ca = line.creditAccount as Address
  const [{ n: nKeys }] = await sql`SELECT count(*)::int AS n FROM line_spend_keys WHERE line_id=${lp.lineId} AND status='active'`
  check('line opened with 2 card keys (password + passkey)', line.status === 'active' && nKeys === 2, `keys=${nKeys}`)
  check('card pays with the password key', await payWith(Account.fromSecp256k1(pw1.pk, { access: ca }), cfg.settlement, shop.code, '1'))
  check('card pays with the passkey', await payWith(Account.fromHeadlessWebAuthn(pk1.pk, { ...WA, access: ca }), cfg.settlement, shop.code, '1'))

  // ---- 4. FORGOT PASSWORD: sign in with the passkey, set a new password (passkey sends the change) ----
  token = (await signInPasskey(wallet, pk1)).token
  const pw2 = await passwordKey()
  const p2 = await api('/api/credentials/prepare', { token, body: { password: { keyRegistration: pw2.keyRegistration, authProof: pw2.authProof, vault: pw2.vault } } })
  await sendCalls(pkAdmin(pk1, wallet), p2.calls)
  await api('/api/credentials/confirm', { token, body: {} })
  const si2 = await signInPassword(username, pw2)
  check('forgot password: the NEW password signs in (same wallet)', Boolean(si2.token) && si2.keyId === pw2.address)
  check('forgot password: the OLD password no longer signs in', await fails(() => signInPassword(username, pw1)))
  check('forgot password: the old key can’t sign in either', await fails(() => signInRawKey(wallet, pw1.pk)))
  check('card pays with the new password key', await payWith(Account.fromSecp256k1(pw2.pk, { access: ca }), cfg.settlement, shop.code, '1'))
  check('card refuses the old password key', !(await payWith(Account.fromSecp256k1(pw1.pk, { access: ca }), cfg.settlement, shop.code, '1')))

  // ---- 5. an ADMIN key grants a permission itself (auto-pay renewal) ----
  token = si2.token
  const rn = await api('/api/lines/mandate/renew', { token, method: 'POST' })
  const rpol = mandateKeyPolicy({ token: net.token, instalment: BigInt(rn.mandate.cap), period: rn.mandate.periodSeconds, repayTo: rn.mandate.recipient, expiry: rn.mandate.expiry })
  await rl(() => Actions.accessKey.authorizeSync(createClient({ account: pwAdmin(pw2, wallet), chain, transport: relayTransport }), { accessKey: { address: rn.mandate.keyId, type: 'secp256k1' }, ...rpol, feePayer: true } as any))
  const rc = await api('/api/lines/mandate/renew/confirm', { token, body: {} })
  check('admin password key renewed auto-pay itself (no KEYKARD activation)', rc.mandateActive === true)

  // ---- 6. LOST PASSKEY: the password replaces it ----
  const sec2 = await api('/api/me', { token })
  const oldPasskeyId = sec2.security.passkeys[0].id
  const pk2 = makePasskey()
  const p3 = await api('/api/credentials/prepare', { token, body: { passkey: passkeyIn(pk2), remove: [oldPasskeyId] } })
  check('replace passkey = add new + revoke old in one transaction', p3.calls.length === 2)
  await sendCalls(pwAdmin(pw2, wallet), p3.calls)
  await api('/api/credentials/confirm', { token, body: { remove: [oldPasskeyId] } })
  check('lost passkey: the NEW passkey signs in', Boolean((await signInPasskey(wallet, pk2)).token))
  check('lost passkey: the OLD passkey is refused', await fails(() => signInPasskey(wallet, pk1)))
  check('card pays with the new passkey', await payWith(Account.fromHeadlessWebAuthn(pk2.pk, { ...WA, access: ca }), cfg.settlement, shop.code, '1'))
  check('card refuses the old passkey', !(await payWith(Account.fromHeadlessWebAuthn(pk1.pk, { ...WA, access: ca }), cfg.settlement, shop.code, '1')))

  // ---- 7. LOST BOTH, wrong passport → refused ----
  const pwX = await passwordKey()
  const bad = await api('/api/recovery/start', { body: { username, password: { keyRegistration: pwX.keyRegistration, authProof: pwX.authProof, vault: pwX.vault } } })
  const [badSess] = await sql`SELECT external_uuid FROM self_sessions WHERE recovery_id=${bad.recoveryId}`
  await selfVerify(wallet, 'borrower', 'someone-else-' + randomUUID(), badSess.external_uuid)
  const badSt = await waitFor('bad recovery', async () => { const s = await api(`/api/recovery/${bad.recoveryId}`); return s.status === 'failed' ? s : null }, 60)
  check('recovery with a DIFFERENT passport is refused', badSt?.error === 'passport_mismatch')

  // ---- 8. LOST BOTH, owner cancels ----
  const pwC = await passwordKey()
  const can = await api('/api/recovery/start', { body: { username, password: { keyRegistration: pwC.keyRegistration, authProof: pwC.authProof, vault: pwC.vault } } })
  const [canSess] = await sql`SELECT external_uuid FROM self_sessions WHERE recovery_id=${can.recoveryId}`
  await selfVerify(wallet, 'borrower', nullifier, canSess.external_uuid)
  await waitFor('waiting', async () => (await api(`/api/recovery/${can.recoveryId}`)).status === 'waiting', 60)
  const shown = await api('/api/me', { token })
  check('owner sees “recovery in progress” on their account', shown.security.openRecovery?.status === 'waiting')
  await api('/api/recovery/cancel', { token, method: 'POST' })
  await sleep(env.RECOVERY_DELAY_SECONDS ? env.RECOVERY_DELAY_SECONDS + 25 : 30)
  check('cancelled recovery never completes', (await api(`/api/recovery/${can.recoveryId}`)).status === 'cancelled')
  check('after cancelling, the current password still works', Boolean((await signInPassword(username, pw2)).token))

  // ---- 9. LOST BOTH, same passport → back into the SAME wallet ----
  const pw3 = await passwordKey()
  const pk3 = makePasskey()
  const rec = await api('/api/recovery/start', { body: { username, password: { keyRegistration: pw3.keyRegistration, authProof: pw3.authProof, vault: pw3.vault }, passkey: passkeyIn(pk3) } })
  const [recSess] = await sql`SELECT external_uuid FROM self_sessions WHERE recovery_id=${rec.recoveryId}`
  await selfVerify(wallet, 'borrower', nullifier, recSess.external_uuid)
  const w = await waitFor('waiting period', async () => { const s = await api(`/api/recovery/${rec.recoveryId}`); return s.status === 'waiting' ? s : null }, 60)
  check('passport matches → waiting period starts', Boolean(w?.readyAt))
  const done = await waitFor('recovery complete', async () => { const s = await api(`/api/recovery/${rec.recoveryId}`); return s.status === 'completed' ? s : null }, (env.RECOVERY_DELAY_SECONDS ?? 300) + 120)
  check('recovery completed after the wait', Boolean(done))
  const si3 = await signInPassword(username, pw3)
  check('recovered: the new password signs into the SAME wallet', si3.keyId === pw3.address && Boolean(si3.token))
  check('recovered: the new passkey signs in', Boolean((await signInPasskey(wallet, pk3)).token))
  check('recovered: the previous password is refused', await fails(() => signInPassword(username, pw2)))
  check('recovered: the previous passkey is refused', await fails(() => signInPasskey(wallet, pk2)))
  check('recovered: card pays with the new password key', await payWith(Account.fromSecp256k1(pw3.pk, { access: ca }), cfg.settlement, shop.code, '1'))
  check('recovered: card refuses the previous password key', !(await payWith(Account.fromSecp256k1(pw2.pk, { access: ca }), cfg.settlement, shop.code, '1')))

  // ---- 10. turn recovery OFF (self-custody) ----
  token = si3.token
  const me10 = await api('/api/me', { token })
  const [recCred] = await sql`SELECT id FROM credentials WHERE wallet=${wallet} AND kind='recovery' AND status='active'`
  const off = await api('/api/credentials/prepare', { token, body: { remove: [Number(recCred.id)] } })
  await sendCalls(pwAdmin(pw3, wallet), off.calls)
  const offSec = await api('/api/credentials/confirm', { token, body: { remove: [Number(recCred.id)] } })
  check('recovery turned off: no KEYKARD key on the wallet', offSec.recoveryOn === false && offSec.recoveryOptOut === true && me10.security.recoveryOn === true)
  const pwZ = await passwordKey()
  check('recovery turned off: lost-both recovery is refused', await fails(() => api('/api/recovery/start', { body: { username, password: { keyRegistration: pwZ.keyRegistration, authProof: pwZ.authProof, vault: pwZ.vault } } })))

  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`)
  await sql.end()
}
main().catch(async (e) => {
  console.error('AUTH E2E FATAL', e)
  process.exitCode = 1
  await sql.end()
})
