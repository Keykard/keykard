import NfcManager, { NfcAdapter, NfcTech } from 'react-native-nfc-manager'
import type { Address, Hex } from 'viem'
import { PublicKey, Signature } from 'ox'
import { Account } from 'viem/tempo'

/**
 * Physical KEYKARD: Burner card / Arx HaLo NFC chip, KEY SLOT 1 (factory secp256k1, no PIN, raw digests allowed).
 * Slots 8/9 (the Burner wallet key, PIN-locked) are never used. Android talks to the chip over ISO-DEP.
 *
 * ONE TAP per action: a single NFC session in reader mode covers every command (read the card, sign), and stays
 * open until the whole action is finished. While it is open the app owns the reader, so Android never hands the
 * card to the browser (Burner cards carry a web link), which used to interrupt the app between two taps.
 */
export const CARD_KEY_SLOT = 1

export async function nfcState(): Promise<'ok' | 'off' | 'none'> {
  if (process.env.EXPO_PUBLIC_FAKE_NFC === '1') return 'ok' // test builds only: exercise the tap UI on an emulator
  try {
    if (!(await NfcManager.isSupported())) return 'none'
    await NfcManager.start()
    return (await NfcManager.isEnabled()) ? 'ok' : 'off'
  } catch {
    return 'none'
  }
}
export const openNfcSettings = () => NfcManager.goToNfcSetting().catch(() => {})

/*
 * Reader guard. While a screen that takes cards is open, the app keeps Android's NFC reader in reader mode and
 * ignores any card that isn't part of a payment. Without it, a Burner card resting on the phone is re-detected
 * again and again and Android tries to open the link stored on it, pausing the app each time (a "blackout" that
 * also dismissed the payment sheet).
 */
const READER = {
  isReaderModeEnabled: true,
  readerModeFlags: NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
  readerModeDelay: 0,
}
let guards = 0
let registered = false

async function holdReader() {
  if (registered) return
  await NfcManager.start()
  await NfcManager.registerTagEvent(READER as any)
  registered = true
}
async function dropReader() {
  if (!registered) return
  registered = false
  await NfcManager.unregisterTagEvent().catch(() => {})
}

/** Call while a card-taking screen is focused; returns the release function. */
export function guardReader(): () => void {
  guards++
  nfcState().then((st) => {
    if (st === 'ok' && guards > 0) holdReader().catch(() => {})
  })
  let released = false
  return () => {
    if (released) return
    released = true
    guards = Math.max(0, guards - 1)
    if (guards === 0 && !busy) void dropReader()
  }
}

export type CardSession = {
  /** run a libhalo command on the card that is being held */
  exec: (cmd: any) => Promise<any>
}

function friendly(e: any): Error {
  const m = String(e?.message ?? e)
  if (/cancel/i.test(m)) return new Error('Cancelled.')
  if (/Tag was lost|TagLost|transceive|IOException/i.test(m)) return new Error('The card moved away too soon. Hold it flat against the back of the phone until it says done.')
  if (/no nfc support|not support/i.test(m)) return new Error('This phone can’t read NFC cards. Use a phone with NFC.')
  if (/nfc.*(disabled|not enabled|off)/i.test(m)) return new Error('NFC is turned off. Turn it on in Settings and try again.')
  return e instanceof Error ? e : new Error(m)
}

let busy = false
/**
 * Opens one NFC session, waits for a card, then runs `fn` with it. The reader stays reserved until `fn` finishes
 * (even after the card is no longer needed), then is always released.
 */
export async function withCard<T>(fn: (s: CardSession) => Promise<T>, onTapped?: () => void): Promise<T> {
  if (busy) throw new Error('Already waiting for a card.')
  busy = true
  let execHaloCmdRN: any
  try {
    ;({ execHaloCmdRN } = await import('@arx-research/libhalo/api/react-native'))
  } catch (e: any) {
    busy = false
    throw new Error(`Couldn’t start the card reader (${String(e?.message ?? e).slice(0, 80)}). Update the app and try again.`)
  }
  try {
    await NfcManager.start()
    // restart reader mode so a card that is already resting on the phone is picked up straight away
    await dropReader()
    await NfcManager.requestTechnology(NfcTech.IsoDep, { ...READER, alertMessage: 'Hold your KEYKARD near the phone' } as any)
    // keep the registration when this request ends: the reader stays guarded between payments
    ;(NfcManager as any).cleanUpTagRegistration = false
    registered = true
    onTapped?.()
    const session: CardSession = {
      exec: async (cmd) => {
        try {
          return await execHaloCmdRN(NfcManager as any, cmd)
        } catch (e) {
          throw friendly(e)
        }
      },
    }
    return await fn(session)
  } catch (e) {
    throw friendly(e)
  } finally {
    busy = false
    await NfcManager.cancelTechnologyRequest({ delayMsAndroid: 0 } as any).catch(() => {})
    if (guards === 0) await dropReader()
  }
}
export const cancelCardRead = () => NfcManager.cancelTechnologyRequest({ delayMsAndroid: 0 } as any).catch(() => {})

const hex0x = (s: string) => (s.startsWith('0x') ? s : `0x${s}`) as Hex

/** Which card is this? (public key + address of slot 1) */
export async function readCard(s: CardSession): Promise<{ address: Address; publicKey: Hex }> {
  const r: any = await s.exec({ name: 'get_pkeys' })
  return { address: String(r.etherAddresses[CARD_KEY_SLOT]).toLowerCase() as Address, publicKey: hex0x(String(r.publicKeys[CARD_KEY_SLOT])) }
}

/** The chip signs a raw 32-byte digest with slot 1 → 65-byte r‖s‖v signature + the card's address. */
export async function cardSignDigest(s: CardSession, digest: Hex): Promise<{ signature: Hex; address: Address; publicKey: Hex }> {
  const r: any = await s.exec({ name: 'sign', keyNo: CARD_KEY_SLOT, digest: digest.slice(2) })
  const raw = r.signature?.raw
  if (!raw) throw new Error('The card did not return a signature. Try again.')
  const signature = Signature.toHex({ r: BigInt(hex0x(raw.r)), s: BigInt(hex0x(raw.s)), yParity: raw.v - 27 } as any) as Hex
  return { signature, address: String(r.etherAddress).toLowerCase() as Address, publicKey: hex0x(String(r.publicKey)) }
}

/** The chip acting as an access key on the credit account: signs the Tempo transaction hash in the same session. */
export function cardAccessKeyAccount(s: CardSession, creditAccount: Address, cardPublicKey: Hex, onSigned?: () => void) {
  return Account.from({
    access: creditAccount,
    keyType: 'secp256k1',
    publicKey: PublicKey.fromHex(cardPublicKey),
    async sign({ hash }: { hash: Hex }) {
      const { signature } = await cardSignDigest(s, hash)
      onSigned?.()
      return signature
    },
  } as any)
}
