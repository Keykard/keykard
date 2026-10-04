import { randomUUID } from 'node:crypto'
import type { Address } from 'viem'
import { SelfClient, SelfWebhooks } from '@selfxyz/enterprise-sdk'
import { BORROWER_FLAGS, GUARANTOR_FLAGS } from '@keycard/sdk'
import { env, publicWebOrigin } from './config'
import { attestWallet } from './attest'
import { audit, sql } from './db'
import { UserError } from './lines'

/**
 * Self Protocol (Enterprise SDK 0.4.1, verified against the installed package types 2026-09-28).
 * The Self dashboard flow enforces the rules (minimumAge 18, excludedCountries per EXCLUDED_COUNTRIES, ofac). A webhook
 * with status 'valid' from the flow configured for the user's role therefore proves all three facts,
 * which we record on-chain as flags in KeycardRegistry. We never receive or store the passport.
 */
const client = env.SELF_API_KEY ? new SelfClient({ apiKey: env.SELF_API_KEY }) : null
// merchants use the borrower rules (adult, not excluded, OFAC-clear). Guarantors use their own flow (which also
// reveals nationality) when configured, otherwise the borrower flow: same rules, nationality simply not disclosed.
const flowFor = (role: string) =>
  role === 'guarantor' ? env.SELF_FLOW_ID_GUARANTOR || env.SELF_FLOW_ID_BORROWER : env.SELF_FLOW_ID_BORROWER
const ATTESTATION_TTL_DAYS = 365

export const selfEnabled = () => Boolean(client && env.SELF_FLOW_ID_BORROWER && env.SELF_WEBHOOK_SECRET)

export async function startSelfSession(wallet: Address, role: string) {
  if (!client) throw new UserError('identity verification is not configured on this server', 503)
  const flowId = flowFor(role)
  if (!flowId) throw new UserError(`no Self flow configured for ${role}`, 503)
  const externalUuid = randomUUID()
  const base = publicWebOrigin
  let s: any
  try {
    s = await client.sessions.create({
      flowId,
      externalUuid,
      successUrl: `${base}/verify/done`,
      failureUrl: `${base}/verify/failed`,
    })
  } catch (e: any) {
    console.error('Self session create failed', e)
    throw new UserError(`identity provider error: ${e?.message ?? 'Self unavailable'}`, 502)
  }
  await sql`
    INSERT INTO self_sessions (id, wallet, role, status, external_uuid, flow_id, raw)
    VALUES (${s.id}, ${wallet}, ${role}, 'pending', ${externalUuid}, ${flowId}, ${sql.json(s as any)})`
  return { verificationUrl: (s as any).verificationUrl as string, expiresAt: (s as any).expiresAt as string, sessionId: s.id }
}

function pickNationality(attrs: Record<string, unknown>): string | null {
  for (const k of ['nationality', 'issuing_state', 'issuingState']) {
    const v = attrs[k]
    if (typeof v === 'string' && v.length >= 2) return v.toUpperCase()
  }
  return null
}

export async function handleSelfWebhook(rawBody: string, headers: Record<string, string>) {
  if (!env.SELF_WEBHOOK_SECRET) throw new UserError('webhook not configured', 503)
  let event
  try {
    event = SelfWebhooks.verify(rawBody, headers, env.SELF_WEBHOOK_SECRET)
  } catch (e: any) {
    console.error('[self] webhook signature verification FAILED (check SELF_WEBHOOK_SECRET):', e?.message)
    throw new UserError('invalid webhook signature', 401)
  }
  console.log('[self] webhook', event.type, (event as any).status ?? '', (event as any).flow_id ?? '', (event as any).environment ?? '')
  if (event.type !== 'verification.completed') return

  const [session] = await sql`SELECT * FROM self_sessions WHERE external_uuid=${event.external_uuid}`
  if (!session) {
    console.warn('[self] webhook for unknown session', event.external_uuid)
    await audit({ actor: 'servicer', action: 'self.unknown_session', detail: { external_uuid: event.external_uuid } })
    return
  }
  await sql`UPDATE self_sessions SET status=${event.status}, raw=${sql.json(event as any)}, updated_at=now() WHERE id=${session.id}`

  if (event.status !== 'valid' || !event.nullifier) {
    await audit({ actor: 'servicer', action: 'self.not_valid', detail: { wallet: session.wallet, status: event.status, reason: event.reason } })
    return
  }
  // The proof must come from the flow we configured for this role (not a weaker flow).
  // a valid proof that we can't use: record WHY on the session, so the app can tell the person exactly what to do
  const reject = (status: string) => sql`UPDATE self_sessions SET status=${status}, updated_at=now() WHERE id=${session.id}`
  if (event.flow_id !== session.flow_id) {
    await reject('flow_mismatch')
    await audit({ actor: 'servicer', action: 'self.flow_mismatch', detail: { wallet: session.wallet, got: event.flow_id } })
    return
  }
  if (env.TEMPO_NETWORK === 'mainnet' && event.environment !== 'live') {
    await reject('test_proof')
    await audit({ actor: 'servicer', action: 'self.test_proof_on_mainnet', detail: { wallet: session.wallet } })
    return
  }

  const flags = session.role === 'guarantor' ? GUARANTOR_FLAGS : BORROWER_FLAGS
  const nationality = session.role === 'guarantor' ? pickNationality(event.proof_attributes) : null
  try {
    await attestWallet({
      wallet: session.wallet as Address,
      nullifier: event.nullifier,
      flags,
      expiresAt: new Date(Date.now() + ATTESTATION_TTL_DAYS * 86400_000),
      nationality,
      selfSessionId: session.id,
    })
  } catch (e: any) {
    if (/already linked/i.test(String(e?.message))) {
      // one passport = one KEYKARD: final, not worth retrying
      await reject('duplicate')
      await audit({ actor: 'servicer', action: 'self.duplicate_identity', detail: { wallet: session.wallet } })
      return
    }
    // anything else (e.g. the chain was briefly unreachable): keep it retryable, Self redelivers the webhook
    console.error('[self] attestation failed, will retry on redelivery:', e?.message)
    throw e
  }
}

export const devVerifyEnabled = () => env.ALLOW_DEV_VERIFY === '1' && env.TEMPO_NETWORK === 'testnet'

/** TESTNET ONLY: attest a signed-in wallet without Self, so the team can test before Self is configured. */
export async function devVerify(wallet: Address, role: string) {
  if (!devVerifyEnabled()) throw new UserError('not available', 404)
  const flags = role === 'guarantor' ? GUARANTOR_FLAGS : BORROWER_FLAGS
  await attestWallet({
    wallet,
    nullifier: `dev-testnet-${wallet.toLowerCase()}`,
    flags,
    expiresAt: new Date(Date.now() + 30 * 86400_000),
    nationality: null,
    selfSessionId: null,
  })
  await audit({ actor: 'admin', action: 'identity.dev_verified', detail: { wallet, role } })
}
