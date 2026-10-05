import { hexToString, stringToHex, type Hex } from 'viem'

/**
 * TIP-20 memos are 32 bytes. KEYKARD memos are short ASCII so they are readable on the explorer
 * and deterministic, which makes every pull idempotent: before retrying, the servicer checks
 * whether a transfer with this memo already landed.
 *
 *   KC:<kind>:<lineId>:<seq>     e.g. "KC:INST:12:3" = line 12, instalment #3
 */
export type MemoKind = 'FUND' | 'SPEND' | 'INST' | 'GUAR' | 'REFUND' | 'SETTLE' | 'REPAY'

export function encodeMemo(kind: MemoKind, lineId: number | bigint, seq: number | bigint = 0): Hex {
  const s = `KC:${kind}:${lineId}:${seq}`
  if (s.length > 32) throw new Error(`memo too long: ${s}`)
  return stringToHex(s, { size: 32 })
}

export function decodeMemo(memo: Hex): { kind: MemoKind; lineId: bigint; seq: bigint } | null {
  let s: string
  try {
    s = hexToString(memo, { size: 32 }).replace(/\0+$/, '')
  } catch {
    return null
  }
  const m = /^KC:(FUND|SPEND|INST|GUAR|REFUND|SETTLE|REPAY):(\d+):(\d+)$/.exec(s)
  if (!m) return null
  return { kind: m[1] as MemoKind, lineId: BigInt(m[2]), seq: BigInt(m[3]) }
}

/**
 * Card payment memo. The card pays the KEYKARD settlement address; the memo names the merchant.
 *   KCP:<MERCHANTCODE>:<nonce>     e.g. "KCP:7QX2MD:1727600000123"
 * This is the authorization message of the KEYKARD network. Settlement to the merchant happens
 * off the card key: in USDC today, in fiat through a card-network partner later.
 */
export const MERCHANT_CODE_RE = /^[A-Z2-9]{6}$/

export function encodePayMemo(merchantCode: string, nonce: number | bigint = Date.now()): Hex {
  if (!MERCHANT_CODE_RE.test(merchantCode)) throw new Error('invalid merchant code')
  const s = `KCP:${merchantCode}:${nonce}`
  if (s.length > 32) throw new Error('memo too long')
  return stringToHex(s, { size: 32 })
}

export function decodePayMemo(memo: Hex): { merchantCode: string; nonce: string } | null {
  let s: string
  try {
    s = hexToString(memo, { size: 32 }).replace(/\0+$/, '')
  } catch {
    return null
  }
  const m = /^KCP:([A-Z2-9]{6}):(\d+)$/.exec(s)
  return m ? { merchantCode: m[1], nonce: m[2] } : null
}
