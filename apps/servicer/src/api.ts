import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Address, Hex } from 'viem'
import { z } from 'zod'
import { BORROWER_FLAGS, GUARANTOR_FLAGS } from '@keycard/sdk'
import { env, excludedCountries, net, passkeyRpId, publicWebOrigin, tiers, webOrigins } from './config'
import { treasury } from './chain'
import { audit, sql } from './db'
import { issueChallenge, issueRegistrationChallenge, mintSession, readSession, verifyAssertion, verifyKeyRegistration, verifyRegistration, walletFromPasskey } from './auth'
import { UserError, lineView, openLine, prepareLine, freezeLine } from './lines'
import { confirmGuarantee, createInvite, getInvite, prepareGuarantee } from './guarantee'
import { selfEnabled, startSelfSession, handleSelfWebhook, devVerify, devVerifyEnabled } from './self'
import { stats } from './stats'
import { acceptGrant } from './keyauth'
import { fetchVault, normUsername, storeBackup, usernameAvailable } from './passwordlogin'
import { cardChallenge, cardInfo, linkCard, releaseCard, setCardFrozen, unlinkCard } from './cards'
import { confirmRenewMandate, maybeUnfreeze, payNow, renewMandate } from './lifecycle'
import { getMerchant, merchantDashboard, registerMerchant } from './merchants'
import { settlement, publicClient } from './chain'
import { Actions } from 'viem/tempo'
import { publishedTerms } from './charges'
import { ensureRepayAccount } from './repay'
import { collateralView, confirmCollateral, prepareCollateral, releaseCollateral } from './collateral'
import { accountInfo, changePassword, confirmChange, prepareChange, securityView } from './credentials'
import { cancelRecovery, recoveryStatus, startRecovery } from './recovery'

type Vars = { wallet: Address }
export const app = new Hono<{ Variables: Vars }>()

app.use('/api/*', cors({ origin: webOrigins, allowHeaders: ['Content-Type', 'Authorization'], credentials: false }))

app.onError((err, c) => {
  if (err instanceof UserError) return c.json({ error: err.message }, err.status as any)
  if (err instanceof z.ZodError) return c.json({ error: 'invalid request', issues: err.issues }, 400)
  console.error(err)
  return c.json({ error: 'internal error' }, 500)
})

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase() as Address)
const amount = z.string().regex(/^\d+$/).transform((s) => BigInt(s))

const requireSession = async (c: any, next: any) => {
  const wallet = readSession(c.req.header('Authorization'))
  if (!wallet) return c.json({ error: 'sign in required' }, 401)
  c.set('wallet', wallet)
  await next()
}

// ---------------- public ----------------
app.get('/api/health', (c) => c.json({ ok: true, network: net.name }))

app.get('/api/config', async (c) => {
  const merchants = await sql`SELECT code, label FROM merchants WHERE active AND code IS NOT NULL ORDER BY created_at DESC LIMIT 200`
  return c.json({
    network: net.name,
    chainId: net.chainId,
    rpcUrl: net.rpcUrl,
    explorerUrl: net.explorerUrl,
    token: net.token,
    tokenSymbol: net.tokenSymbol,
    tokenDecimals: net.tokenDecimals,
    registry: net.registry,
    lineBook: net.lineBook,
    creditTerms: net.creditTerms ?? null,
    collateralVault: net.collateralVault ?? null,
    // published pricing for missed payments (read from the CreditTerms contract); on time = 0%
    terms: await publishedTerms().catch(() => null),
    maxSecured: env.MAX_SECURED.toString(),
    treasury: treasury.address,
    settlement: settlement.address,
    tiers: tiers.map(String),
    periodSeconds: env.PERIOD_SECONDS,
    graceSeconds: env.GRACE_SECONDS,
    excludedCountries: [...excludedCountries],
    selfEnabled: selfEnabled(),
    devVerify: devVerifyEnabled(),
    webOrigins,
    publicWebOrigin,
    passkeyRpId,
    merchants,
  })
})

app.get('/api/stats', async (c) => c.json(await stats()))

// Which build is live (Railway sets RAILWAY_GIT_COMMIT_SHA on every deploy).
const startedAt = new Date().toISOString()
app.get('/api/version', (c) => c.json({ commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'local', startedAt }))

// ---------------- registration + auth ----------------
app.get('/api/auth/register-challenge', (c) => c.json(issueRegistrationChallenge()))

/**
 * Sign-up. Preferred: `registration` = a WebAuthn registration verified server-side, which also signs the user
 * in (ONE passkey prompt). Legacy raw `passkeyPublicKey` is accepted only when ALLOW_UNVERIFIED_REGISTRATION=1
 * (testnet API tests) and never returns a session.
 */
app.post('/api/users', async (c) => {
  const b = z
    .object({
      role: z.enum(['borrower', 'guarantor', 'merchant']),
      username: z.string().optional(),
      residenceCountry: z.string().length(3).transform((s) => s.toUpperCase()),
      residenceConfirmed: z.literal(true),
      registration: z.object({ challengeId: z.string(), credential: z.any() }).optional(),
      keyRegistration: z
        .object({ challengeId: z.string(), address: addr, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })
        .optional(),
      backup: z.object({ username: z.string(), authProof: z.string(), vault: z.any() }).optional(),
      passkeyId: z.string().min(8).optional(),
      passkeyPublicKey: z.string().regex(/^0x(04)?[0-9a-fA-F]{128}$/).optional(),
    })
    .parse(await c.req.json())
  if (excludedCountries.has(b.residenceCountry))
    throw new UserError('KEYKARD is not available to residents of this country.', 403)

  let publicKey: Hex
  let passkeyId: string
  let verified = false
  let keyType: 'webauthn' | 'secp256k1' = 'webauthn'
  let wallet: Address
  if (b.keyRegistration) {
    try {
      const v = await verifyKeyRegistration({ ...b.keyRegistration, signature: b.keyRegistration.signature as Hex })
      keyType = 'secp256k1'
      publicKey = v.address as unknown as Hex // for device keys the identifier is the key address
      passkeyId = `device:${v.address}`
      verified = true
    } catch (e: any) {
      throw new UserError(e.message, 400)
    }
  } else if (b.registration) {
    try {
      const v = verifyRegistration(b.registration)
      publicKey = v.publicKey
      passkeyId = v.credentialId
      verified = true
    } catch (e: any) {
      throw new UserError(e.message, 400)
    }
  } else {
    if (env.ALLOW_UNVERIFIED_REGISTRATION !== '1' || net.name === 'mainnet') throw new UserError('passkey registration required', 400)
    if (!b.passkeyId || !b.passkeyPublicKey) throw new UserError('missing passkey', 400)
    publicKey = b.passkeyPublicKey as Hex
    passkeyId = b.passkeyId
  }

  // one username for every account type (the password backup reuses it)
  const username = b.username ?? b.backup?.username
  const uname = username ? normUsername(username) : null
  if (!uname && verified) throw new UserError('choose a username', 400)
  if (uname && !(await usernameAvailable(uname))) {
    const [mine] = await sql`SELECT 1 FROM users WHERE username=${uname} AND wallet=${(keyType === 'secp256k1' ? publicKey : walletFromPasskey(publicKey)).toLowerCase()}`
    if (!mine) throw new UserError('that username is taken', 409)
  }
  const ipCountry = c.req.header('cf-ipcountry') ?? c.req.header('x-vercel-ip-country') ?? null
  wallet = (keyType === 'secp256k1' ? publicKey : walletFromPasskey(publicKey)).toLowerCase() as Address
  const inserted = await sql`
    INSERT INTO users (wallet, role, passkey_id, passkey_public_key, key_type, residence_country, residence_declared_at, signup_ip_country, username)
    VALUES (${wallet}, ${b.role}, ${passkeyId}, ${publicKey.toLowerCase()}, ${keyType}, ${b.residenceCountry}, now(), ${ipCountry}, ${uname})
    ON CONFLICT (wallet) DO NOTHING RETURNING wallet`
  const [u] = await sql`SELECT wallet, role FROM users WHERE wallet=${wallet}`
  if (u.role !== b.role) throw new UserError(`this passkey is already registered as a ${u.role}`, 409)
  if (keyType === 'secp256k1' && b.backup && inserted.length > 0) await storeBackup({ ...b.backup, username: uname ?? b.backup.username, wallet })
  if (inserted.length > 0) {
    // the account's first key is its root: the password key (new sign-ups) or a passkey (older apps)
    await sql`INSERT INTO credentials (wallet, kind, key_id, is_root, passkey_id, public_key, status)
              VALUES (${wallet}, ${keyType === 'secp256k1' ? 'password' : 'passkey'}, ${wallet}, true,
                      ${keyType === 'secp256k1' ? null : passkeyId}, ${keyType === 'secp256k1' ? null : publicKey.toLowerCase()}, 'active')
              ON CONFLICT (wallet, key_id) DO NOTHING`
  }
  await audit({ actor: b.role, action: 'user.registered', detail: { wallet, residence: b.residenceCountry, ipCountry, verified } })
  // a freshly registered, server-verified passkey signs the user in without a second prompt
  const token = verified && inserted.length > 0 ? mintSession(wallet) : undefined
  return c.json({ wallet, token, publicKey, passkeyId })
})

// Passkey public keys are not secret; the browser needs them to restore the account on sign-in.
app.get('/api/passkeys/:id', async (c) => {
  const [k] = await sql`SELECT c.wallet, c.public_key, c.is_root, u.role, u.username FROM credentials c JOIN users u ON u.wallet=c.wallet
                        WHERE c.passkey_id=${c.req.param('id')} AND c.kind='passkey' AND c.status='active'`
  if (!k) throw new UserError('this passkey isn’t linked to a KEYKARD account (it may have been replaced)', 404)
  return c.json({ wallet: k.wallet, role: k.role, username: k.username, publicKey: k.public_key, root: k.is_root })
})

// Identifier-first sign-in: what the next screen should offer for this username.
app.get('/api/accounts/:username', async (c) => c.json(await accountInfo(c.req.param('username'))))

// ---------------- sign-in methods on the account (password, passkeys, recovery key) ----------------
const passwordIn = z.object({
  keyRegistration: z.object({ challengeId: z.string(), address: addr, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  authProof: z.string().regex(/^[0-9a-f]{64}$/),
  vault: z.object({ address: addr }).passthrough(),
})
const passkeyIn = z.union([
  z.object({ challengeId: z.string(), credential: z.any() }),
  z.object({ unverified: z.object({ id: z.string(), publicKey: z.string().regex(/^0x(04)?[0-9a-fA-F]{128}$/) }) }),
])
app.post('/api/credentials/prepare', requireSession, async (c) => {
  const b = z.object({ password: passwordIn.optional(), passkey: passkeyIn.optional(), recovery: z.boolean().optional(), remove: z.array(z.number()).optional() }).parse(await c.req.json())
  return c.json(await prepareChange(c.get('wallet'), b as any))
})
app.post('/api/credentials/confirm', requireSession, async (c) => {
  const b = z.object({ remove: z.array(z.number()).optional() }).parse(await c.req.json().catch(() => ({})))
  return c.json(await confirmChange(c.get('wallet'), b.remove))
})
app.post('/api/auth/password/change', requireSession, async (c) => {
  const b = z.object({ authProof: z.string().regex(/^[0-9a-f]{64}$/), vault: z.object({ address: addr }).passthrough() }).parse(await c.req.json())
  return c.json(await changePassword(c.get('wallet'), b as any))
})

// ---------------- account recovery (lost password AND passkey) ----------------
app.post('/api/recovery/start', async (c) => {
  const b = z.object({ username: z.string(), password: passwordIn, passkey: passkeyIn.optional() }).parse(await c.req.json())
  return c.json(await startRecovery(b as any))
})
app.get('/api/recovery/:id', async (c) => c.json(await recoveryStatus(c.req.param('id'))))
app.post('/api/recovery/cancel', requireSession, async (c) => c.json(await cancelRecovery(c.get('wallet'))))

app.get('/api/username/:u', async (c) => c.json({ available: await usernameAvailable(c.req.param('u')) }))

// Password sign-in on any device: returns the client-encrypted vault if the login proof matches.
app.post('/api/auth/password', async (c) => {
  const b = z.object({ username: z.string(), authProof: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await c.req.json())
  return c.json(await fetchVault(b))
})

app.post('/api/auth/challenge', async (c) => {
  const { wallet } = z.object({ wallet: addr }).parse(await c.req.json())
  return c.json({ challenge: issueChallenge(wallet) })
})

app.post('/api/auth/verify', async (c) => {
  const b = z
    .object({
      wallet: addr,
      metadata: z.any().optional(),
      signature: z.object({ r: z.string(), s: z.string() }).optional(),
      keySignature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      credentialId: z.string().optional(),
    })
    .parse(await c.req.json())
  try {
    return c.json({ token: await verifyAssertion({ ...b, keySignature: b.keySignature as Hex | undefined }) })
  } catch (e: any) {
    throw new UserError(e.message, 401)
  }
})

// ---------------- identity (Self) ----------------
app.post('/api/self/session', requireSession, async (c) => {
  const wallet = c.get('wallet')
  const [u] = await sql`SELECT role FROM users WHERE wallet=${wallet}`
  if (!u) throw new UserError('register first')
  return c.json(await startSelfSession(wallet, u.role))
})

app.post('/api/dev/verify', requireSession, async (c) => {
  const wallet = c.get('wallet')
  const [u] = await sql`SELECT role FROM users WHERE wallet=${wallet}`
  if (!u) throw new UserError('register first')
  await devVerify(wallet, u.role)
  return c.json({ ok: true })
})

app.post('/api/self/webhook', async (c) => {
  const raw = await c.req.text()
  const headers = Object.fromEntries(c.req.raw.headers.entries())
  await handleSelfWebhook(raw, headers)
  return c.json({ ok: true })
})

// ---------------- me ----------------
app.get('/api/me', requireSession, async (c) => {
  const wallet = c.get('wallet')
  const [u] = await sql`SELECT wallet, role, key_type, username, residence_country, created_at FROM users WHERE wallet=${wallet}`
  const [a] = await sql`SELECT flags, expires_at, tx_hash FROM attestations WHERE wallet=${wallet}`
  const [s] = await sql`SELECT status, updated_at FROM self_sessions WHERE wallet=${wallet} ORDER BY created_at DESC LIMIT 1`
  const [l] = await sql`SELECT id FROM lines WHERE borrower_wallet=${wallet} ORDER BY created_at DESC LIMIT 1`
  const guaranteeing = await sql`
    SELECT i.id AS invite_id, i.cap, i.status, l.borrower_wallet, l.guaranteed, l.status AS line_status, l.guar_key_id
    FROM guarantee_invites i JOIN lines l ON l.id=i.line_id WHERE i.guarantor_wallet=${wallet} ORDER BY i.created_at DESC`
  const required = u?.role === 'guarantor' ? GUARANTOR_FLAGS : BORROWER_FLAGS
  return c.json({
    user: u ?? null,
    identity: {
      verified: Boolean(a && (a.flags & required) === required && new Date(a.expires_at) > new Date()),
      attestationTx: a?.tx_hash ?? null,
      selfStatus: s?.status ?? null,
    },
    line: l ? await (async () => {
      await ensureRepayAccount(l.id).catch((e) => console.error('[me] repay address', e))
      return lineView(l.id)
    })() : null,
    collateral: l && u?.role === 'borrower' ? await collateralView(wallet).catch(() => null) : null,
    security: u ? await securityView(wallet) : null,
    guaranteeing,
  })
})

// accounts created before usernames existed can pick one once
app.post('/api/me/username', requireSession, async (c) => {
  const { username } = z.object({ username: z.string() }).parse(await c.req.json())
  const n = normUsername(username)
  const [u] = await sql`SELECT username FROM users WHERE wallet=${c.get('wallet')}`
  if (!u) throw new UserError('unknown account', 404)
  if (u.username) throw new UserError('username already set', 409)
  if (!(await usernameAvailable(n))) throw new UserError('that username is taken', 409)
  await sql`UPDATE users SET username=${n} WHERE wallet=${c.get('wallet')}`
  return c.json({ username: n })
})

app.get('/api/me/activity', requireSession, async (c) => {
  const wallet = c.get('wallet')
  const [l] = await sql`SELECT id FROM lines WHERE borrower_wallet=${wallet} ORDER BY created_at DESC LIMIT 1`
  if (!l) return c.json({ spends: [], movements: [], events: [] })
  const spends = await sql`SELECT p.pay_tx AS tx_hash, p.merchant_code, p.amount, p.status, p.settle_tx, p.block_number::text AS block_number, p.created_at, m.label
                           FROM payments p LEFT JOIN merchants m ON m.code=p.merchant_code
                           WHERE p.line_id=${l.id} ORDER BY p.id DESC LIMIT 100`
  const movements = await sql`SELECT kind, amount, tx_hash, status, created_at FROM movements WHERE line_id=${l.id} ORDER BY created_at DESC LIMIT 100`
  const events = await sql`SELECT action, detail, tx_hash, created_at FROM audit_log WHERE line_id=${l.id} ORDER BY created_at DESC LIMIT 100`
  const charges = await sql`SELECT kind, amount, overdue, tx_hash, created_at FROM line_charges WHERE line_id=${l.id} ORDER BY created_at DESC LIMIT 100`
  return c.json({ spends, movements, events, charges })
})

// ---------------- borrower line ----------------
app.post('/api/lines/prepare', requireSession, async (c) => c.json(await prepareLine(c.get('wallet'))))

// One-signature mandate: the borrower signs only the key authorization; KEYKARD verifies and activates it.
const optionalKa = z.object({ keyAuthorization: z.string().regex(/^0x[0-9a-fA-F]+$/).optional() })
app.post('/api/lines/:id/mandate', requireSession, async (c) => {
  const { keyAuthorization } = optionalKa.parse(await c.req.json())
  const wallet = c.get('wallet')
  const [row] = await sql`SELECT * FROM lines WHERE id=${c.req.param('id')} AND borrower_wallet=${wallet} AND status='preparing'`
  if (!row) throw new UserError('line not found', 404)
  const tx = await acceptGrant({
    owner: wallet,
    keyId: row.repay_key_id,
    sealedKey: row.repay_key_enc,
    keyAuthorization: keyAuthorization as Hex | undefined,
    expect: { expiry: Math.floor(new Date(row.term_end).getTime() / 1000), limit: BigInt(row.mandate_cap), period: row.period_seconds, recipients: [treasury.address] },
  })
  await audit({ lineId: row.id, actor: 'borrower', action: 'mandate.signed', txHash: tx })
  return c.json({ ok: true, tx })
})

// ---- recovery paths ----
app.post('/api/lines/pay-now', requireSession, async (c) => {
  const v = await payNow(c.get('wallet'))
  await maybeUnfreeze(c.get('wallet'))
  return c.json(v)
})
// ---- secured line (1:1 collateral in the CollateralVault) ----
const usdAmount = z.object({ amount: z.string().regex(/^\d+$/) })
app.post('/api/collateral/prepare', requireSession, async (c) => {
  const { amount } = usdAmount.parse(await c.req.json())
  return c.json(await prepareCollateral(c.get('wallet'), BigInt(amount)))
})
app.post('/api/collateral/confirm', requireSession, async (c) => {
  const { amount, keyAuthorization } = usdAmount.extend({ keyAuthorization: z.string().regex(/^0x[0-9a-fA-F]+$/).optional() }).parse(await c.req.json())
  return c.json(await confirmCollateral(c.get('wallet'), BigInt(amount), keyAuthorization as Hex | undefined))
})
app.post('/api/collateral/release', requireSession, async (c) => {
  const { amount } = usdAmount.parse(await c.req.json())
  return c.json(await releaseCollateral(c.get('wallet'), BigInt(amount)))
})

app.post('/api/lines/mandate/renew', requireSession, async (c) => c.json(await renewMandate(c.get('wallet'))))
app.post('/api/lines/mandate/renew/confirm', requireSession, async (c) => {
  const { keyAuthorization } = optionalKa.parse(await c.req.json())
  return c.json(await confirmRenewMandate(c.get('wallet'), keyAuthorization as Hex | undefined))
})

app.post('/api/lines/:id/open', requireSession, async (c) =>
  c.json(await openLine(c.get('wallet'), Number(c.req.param('id')))),
)

// ---------------- guarantor ----------------
app.post('/api/guarantee/invite', requireSession, async (c) => {
  const { requested } = z.object({ requested: amount }).parse(await c.req.json())
  return c.json(await createInvite(c.get('wallet'), requested))
})

app.get('/api/guarantee/:id', async (c) => c.json(await getInvite(c.req.param('id'))))

app.post('/api/guarantee/:id/prepare', requireSession, async (c) => {
  const b = z.object({ monthlyIncome: amount, monthlyObligations: amount }).parse(await c.req.json())
  return c.json(await prepareGuarantee({ inviteId: c.req.param('id'), guarantor: c.get('wallet'), ...b }))
})

app.post('/api/guarantee/:id/key', requireSession, async (c) => {
  const { keyAuthorization } = optionalKa.parse(await c.req.json())
  const wallet = c.get('wallet')
  const [inv] = await sql`SELECT i.*, l.term_end FROM guarantee_invites i JOIN lines l ON l.id=i.line_id
                          WHERE i.id=${c.req.param('id')} AND i.guarantor_wallet=${wallet} AND i.status='prepared'`
  if (!inv) throw new UserError('invite not prepared for you', 404)
  const tx = await acceptGrant({
    owner: wallet,
    keyId: inv.guar_key_id,
    sealedKey: inv.guar_key_enc,
    keyAuthorization: keyAuthorization as Hex | undefined,
    expect: { expiry: Math.floor(new Date(inv.term_end).getTime() / 1000), limit: BigInt(inv.cap), period: 0, recipients: [treasury.address] },
  })
  return c.json({ ok: true, tx })
})

app.post('/api/guarantee/:id/confirm', requireSession, async (c) => {
  const b = z.object({ consentHash: z.string() }).parse(await c.req.json())
  return c.json(await confirmGuarantee({ inviteId: c.req.param('id'), guarantor: c.get('wallet'), ...b }))
})

// ---------------- physical card (NFC chip) ----------------
app.post('/api/card/challenge', requireSession, (c) => c.json(cardChallenge(c.get('wallet'))))
app.post('/api/card/link', requireSession, async (c) => {
  const b = z.object({ cardAddress: addr, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).parse(await c.req.json())
  return c.json(await linkCard({ wallet: c.get('wallet'), cardAddress: b.cardAddress, signature: b.signature as Hex }))
})
app.post('/api/card/freeze', requireSession, async (c) => c.json(await setCardFrozen(c.get('wallet'), true)))
app.post('/api/card/unfreeze', requireSession, async (c) => c.json(await setCardFrozen(c.get('wallet'), false)))
app.post('/api/card/unlink', requireSession, async (c) => c.json(await unlinkCard(c.get('wallet'))))
app.get('/api/cards/:address', async (c) => c.json(await cardInfo(addr.parse(c.req.param('address')))))

// ---------------- merchants ----------------
app.get('/api/merchants/:code', async (c) => c.json(await getMerchant(c.req.param('code'))))

app.post('/api/merchants', requireSession, async (c) => {
  const { label } = z.object({ label: z.string().trim().min(2).max(60) }).parse(await c.req.json())
  return c.json(await registerMerchant(c.get('wallet'), label))
})

app.get('/api/merchant/me', requireSession, async (c) => c.json(await merchantDashboard(c.get('wallet'))))

// ---------------- testnet faucet (disabled on mainnet) ----------------
app.post('/api/faucet', requireSession, async (c) => {
  if (net.name !== 'testnet') throw new UserError('faucet is testnet-only', 404)
  const hashes = await Actions.faucet.fund(publicClient as any, { account: c.get('wallet') })
  return c.json({ ok: true, hashes })
})

// ---------------- operator ----------------
const requireAdmin = async (c: any, next: any) => {
  if (!env.ADMIN_TOKEN || c.req.header('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return c.json({ error: 'forbidden' }, 403)
  await next()
}

// Self verification diagnostics: what arrived and why it was accepted/rejected (no nullifiers, no personal data)
app.get('/api/admin/self-debug', requireAdmin, async (c) => {
  const sessions = await sql`
    SELECT id, left(wallet, 10) AS wallet, role, status, flow_id AS expected_flow, created_at, updated_at,
           raw->>'type' AS event_type, raw->>'flow_id' AS event_flow, raw->>'status' AS event_status,
           raw->>'reason' AS event_reason, raw->>'environment' AS event_env, (raw->>'nullifier') IS NOT NULL AS has_nullifier
    FROM self_sessions ORDER BY created_at DESC LIMIT 15`
  const events = await sql`
    SELECT action, detail, created_at FROM audit_log
    WHERE action LIKE 'self.%' OR action LIKE 'identity.%' ORDER BY created_at DESC LIMIT 20`
  const [att] = await sql`SELECT count(*) AS n FROM attestations`
  return c.json({ attestations: Number(att.n), sessions, events })
})

app.post('/api/admin/cards/:address/release', requireAdmin, async (c) => c.json(await releaseCard(addr.parse(c.req.param('address')))))

app.get('/api/admin/lines', requireAdmin, async (c) => {
  const rows = await sql`SELECT id FROM lines ORDER BY created_at DESC LIMIT 200`
  return c.json(await Promise.all(rows.map((r) => lineView(r.id))))
})

app.post('/api/admin/lines/:id/freeze', requireAdmin, async (c) => {
  const [row] = await sql`SELECT * FROM lines WHERE id=${c.req.param('id')}`
  if (!row) throw new UserError('not found', 404)
  await freezeLine(row, 'Manual')
  return c.json(await lineView(row.id))
})

app.post('/api/admin/merchants', requireAdmin, async (c) => {
  const b = z
    .object({ address: addr, label: z.string().min(2), url: z.string().url().optional(), kind: z.enum(['merchant', 'mpp']).default('merchant') })
    .parse(await c.req.json())
  await sql`INSERT INTO merchants (address, label, url, kind) VALUES (${b.address}, ${b.label}, ${b.url ?? null}, ${b.kind})
            ON CONFLICT (address) DO UPDATE SET label=EXCLUDED.label, url=EXCLUDED.url, kind=EXCLUDED.kind, active=true`
  await audit({ actor: 'admin', action: 'merchant.upsert', detail: b })
  return c.json({ ok: true, note: 'new lines include this merchant; run syncMerchants for existing lines' })
})
