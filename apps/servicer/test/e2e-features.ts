/**
 * Card freeze, credit file sharing and payment-request parsing against a running servicer (jobs may be disabled).
 * Uses an existing active line: LINE_ID=<id> npx tsx test/e2e-features.ts
 */
import { mintSession } from '../src/auth'
import { sql } from '../src/db'
import { env } from '../src/config'

const API = process.env.API ?? `http://localhost:${env.PORT}`
let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`)
}
async function call(path: string, token?: string, body?: unknown) {
  const r = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}

const [line] = await sql`SELECT l.id, l.borrower_wallet, u.username FROM lines l JOIN users u ON u.wallet=l.borrower_wallet
                         WHERE l.id=${process.env.LINE_ID ?? 0} OR (${!process.env.LINE_ID} AND l.status='active' AND u.username IS NOT NULL)
                         ORDER BY l.created_at DESC LIMIT 1`
if (!line) throw new Error('no active line with a username in this database')
const token = mintSession(line.borrower_wallet)
console.log(`line ${line.id} @${line.username}`)

// ---- freeze ----
const before = (await call('/api/me', token)).json.line
ok('line starts unfrozen', before.userFrozen === false && before.status === 'active', before)
const fr = await call('/api/lines/freeze', token, { frozen: true })
ok('freeze returns userFrozen', fr.status === 200 && fr.json.userFrozen === true, fr)
ok('frozen card can spend nothing (on-chain limit 0)', fr.json?.spendable === '0', fr.json?.spendable)
const [db1] = await sql`SELECT user_frozen, status FROM lines WHERE id=${line.id}`
ok('db user_frozen, status unchanged', db1.user_frozen === true && db1.status === 'active', db1)
const un = await call('/api/lines/freeze', token, { frozen: false })
ok('unfreeze returns userFrozen=false', un.status === 200 && un.json.userFrozen === false, un)
ok('spending restored on-chain', BigInt(un.json?.periodRemaining ?? '0') > 0n, un.json)
ok('freeze needs a boolean', (await call('/api/lines/freeze', token, { frozen: 'yes' })).status === 400)
ok('freeze needs a session', (await call('/api/lines/freeze', undefined, { frozen: true })).status === 401)

// ---- credit file ----
await sql`UPDATE users SET public_profile=false WHERE wallet=${line.borrower_wallet}`
ok('private by default → 404', (await call(`/api/profiles/${line.username}`)).status === 404)
ok('unknown username → 404', (await call('/api/profiles/nobody-here-zz')).status === 404)
ok('bad username → 404', (await call('/api/profiles/%20!!')).status === 404)
const on = await call('/api/me/profile', token, { public: true })
ok('share on', on.status === 200 && on.json.publicProfile === true, on)
ok('/api/me shows public_profile', (await call('/api/me', token)).json.user.public_profile === true)
const p = await call(`/api/profiles/${line.username.toUpperCase()}`)
ok('public file readable (case-insensitive)', p.status === 200 && p.json.username === line.username, p)
const keys = Object.keys(p.json ?? {}).sort()
ok('file has history fields', ['onTime', 'missed', 'defaults', 'verified', 'lineBookIds', 'current'].every((k) => keys.includes(k)), keys)
const leak = JSON.stringify(p.json)
ok('no balances, spending or documents', !/available|owed|spendable|nationality|residence|amount_due|password/i.test(leak), leak)
const [agg] = await sql`SELECT sum(on_time_count)::int AS t, sum(missed_count)::int AS m FROM lines WHERE borrower_wallet=${line.borrower_wallet} AND status<>'preparing'`
ok('counts match records', p.json.onTime === agg.t && p.json.missed === agg.m, { file: [p.json.onTime, p.json.missed], db: agg })
const off = await call('/api/me/profile', token, { public: false })
ok('share off', off.status === 200 && off.json.publicProfile === false)
ok('hidden again → 404', (await call(`/api/profiles/${line.username}`)).status === 404)
const [m] = await sql`SELECT wallet FROM users WHERE role<>'borrower' LIMIT 1`
if (m) ok('non-cardholder cannot share', (await call('/api/me/profile', mintSession(m.wallet), { public: true })).status === 403)

console.log(`\n${pass}/${pass + fail} passed`)
await sql.end()
process.exit(fail ? 1 : 0)
