import { Passkey } from 'react-native-passkey'
import { Base64, Bytes, Cbor, CoseKey, Hex, PublicKey } from 'ox'
import { Authentication, Credential } from 'ox/webauthn'

/**
 * Android passkeys (Credential Manager) adapted to the browser WebAuthn shape, so ox runs the SAME code as the web
 * app: identical serialized registrations for the server and identical signature metadata for Tempo.
 * The relying party is the KEYKARD web domain; the website's /.well-known/assetlinks.json vouches for this app.
 * Android signs clientDataJSON with origin "android:apk-key-hash:…", which the server and Tempo both accept.
 */

const b64u = (b: Uint8Array) => Base64.fromBytes(b, { url: true, pad: false })
const fromB64u = (s: string) => Base64.toBytes(s)
const toBuf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
const bytesOf = (x: unknown): Uint8Array =>
  x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : typeof x === 'string' ? Bytes.fromHex(x as Hex.Hex) : new Uint8Array(x as ArrayBufferLike)

export const passkeysSupported = () => {
  try {
    return Passkey.isSupported()
  } catch {
    return false
  }
}

/** Raw P-256 public key from the attestation object's COSE key (authData: rpIdHash 32 · flags 1 · counter 4 · aaguid 16 · idLen 2 · id · COSE). */
function publicKeyFromAttestation(attestationObject: Uint8Array): PublicKey.PublicKey {
  const { authData } = Cbor.decode<{ authData: Uint8Array }>(attestationObject)
  const idLen = (authData[53] << 8) | authData[54]
  const cose = authData.slice(55 + idLen)
  return CoseKey.toPublicKey(Hex.fromBytes(cose))
}

export type NewPasskey = { id: string; publicKey: Hex.Hex; serialized: ReturnType<typeof Credential.serialize> }

export async function createPasskey(p: { username: string; challenge: Hex.Hex; rpId: string }): Promise<NewPasskey> {
  // user.id: keccak of the username, the same default ox uses on the web
  const { Hash } = await import('ox')
  const userId = Hash.keccak256(Bytes.fromString(p.username), { as: 'Bytes' })
  let r: any
  try {
    r = await Passkey.create({
      challenge: b64u(Bytes.fromHex(p.challenge)),
      rp: { id: p.rpId, name: 'KEYKARD' },
      user: { id: b64u(userId), name: p.username, displayName: p.username },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: 120_000,
    } as any)
  } catch (e) {
    throw friendlyPasskeyError(e)
  }
  const attestationObject = fromB64u(r.response.attestationObject)
  const clientDataJSON = fromB64u(r.response.clientDataJSON)
  const authenticatorData = r.response.authenticatorData ? fromB64u(r.response.authenticatorData) : undefined
  const publicKey = publicKeyFromAttestation(attestationObject)
  const raw = {
    id: r.id,
    type: 'public-key',
    authenticatorAttachment: r.authenticatorAttachment ?? 'platform',
    rawId: toBuf(fromB64u(r.rawId ?? r.id)),
    response: {
      clientDataJSON: toBuf(clientDataJSON),
      attestationObject: toBuf(attestationObject),
      ...(authenticatorData ? { authenticatorData: toBuf(authenticatorData) } : {}),
    },
  }
  const credential = { attestationObject: toBuf(attestationObject), clientDataJSON: toBuf(clientDataJSON), id: r.id, publicKey, raw } as any
  const serialized = Credential.serialize(credential)
  return { id: r.id, publicKey: serialized.publicKey as Hex.Hex, serialized }
}

/** The browser's navigator.credentials.get, implemented with Credential Manager. */
function getFn(opts: any) {
  const pk = opts.publicKey
  return Passkey.get({
    challenge: b64u(bytesOf(pk.challenge)),
    rpId: pk.rpId,
    ...(pk.allowCredentials?.length
      ? { allowCredentials: pk.allowCredentials.map((c: any) => ({ type: 'public-key', id: b64u(bytesOf(c.id)) })) }
      : {}),
    userVerification: pk.userVerification ?? 'required',
    timeout: 120_000,
  } as any).then((r: any) => ({
    id: r.id,
    type: 'public-key',
    rawId: toBuf(fromB64u(r.rawId ?? r.id)),
    response: {
      authenticatorData: toBuf(fromB64u(r.response.authenticatorData)),
      clientDataJSON: toBuf(fromB64u(r.response.clientDataJSON)),
      signature: toBuf(fromB64u(r.response.signature)),
      userHandle: r.response.userHandle ? toBuf(fromB64u(r.response.userHandle)) : null,
    },
  }))
}

/**
 * WebAuthn assertion over `challenge` with a known credential (or any of several: the phone shows the ones it has).
 * Same return shape as ox's WebAuthnP256.sign; `raw.id` says which passkey signed.
 */
export async function signWithPasskey(p: { challenge: Hex.Hex; credentialId: string | string[]; rpId: string }) {
  try {
    return await Authentication.sign({ challenge: p.challenge, credentialId: p.credentialId, rpId: p.rpId, userVerification: 'required', getFn } as any)
  } catch (e: any) {
    throw friendlyPasskeyError(e?.cause ?? e)
  }
}

/** "Sign in with passkey": let the user pick any KEYKARD passkey on this phone; returns its credential id. */
export async function discoverPasskey(rpId: string): Promise<string> {
  try {
    const r: any = await getFn({ publicKey: { challenge: Bytes.random(32), rpId, userVerification: 'required' } })
    return r.id as string
  } catch (e) {
    throw friendlyPasskeyError(e)
  }
}

/** App lock: a local fingerprint / face check with one of this account's passkeys (nothing is sent anywhere). */
export async function confirmWithPasskey(rpId: string, credentialIds: string[]) {
  try {
    await getFn({ publicKey: { challenge: Bytes.random(32), rpId, userVerification: 'required', allowCredentials: credentialIds.map((id) => ({ id: fromB64u(id) })) } })
  } catch (e) {
    throw friendlyPasskeyError(e)
  }
}

export class PasskeyCancelled extends Error {}

export function friendlyPasskeyError(e: any): Error {
  const code = String(e?.error ?? e?.code ?? e?.name ?? '')
  const msg = String(e?.message ?? e)
  if (/UserCancel|Cancel/i.test(code + msg)) return new PasskeyCancelled('Cancelled.')
  if (/NoCredentials|no credentials|NoCredential/i.test(code + msg))
    return new Error('No KEYKARD passkey on this phone. Create an account, or sign in with your password.')
  if (/NoCreateOption|no create option/i.test(code + msg))
    return new Error('This phone can’t save passkeys yet. Add a Google account and a screen lock in Settings, or use a password account.')
  if (/BadConfiguration|RP ID|rpId|domain|asset/i.test(code + msg))
    return new Error('Passkeys aren’t set up for this build of KEYKARD. Use a password account for now.')
  if (/NotSupported/i.test(code + msg)) return new Error('Passkeys need Android 9 or newer with Google Play services.')
  return new Error(msg.slice(0, 200) || 'Passkey request failed.')
}
