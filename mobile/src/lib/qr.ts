import { MERCHANT_CODE_RE } from '@keycard/sdk'

/** Merchant QR codes are pay links (…/card?pay=CODE); a bare 6-character code works too. */
export function codeFromQr(data: string): string | null {
  const t = data.trim()
  const m = t.match(/[?&]pay=([A-Za-z0-9]{6})\b/)
  const code = (m?.[1] ?? t).toUpperCase()
  return MERCHANT_CODE_RE.test(code) ? code : null
}

/** A payment request link (…/card?pay=CODE&amount=12.50) carries the amount the shop asked for. */
export function amountFromQr(data: string): string | undefined {
  const m = data.trim().match(/[?&]amount=(\d{1,6}(?:\.\d{1,2})?)(?:&|$)/)
  return m && Number(m[1]) > 0 ? m[1] : undefined
}
