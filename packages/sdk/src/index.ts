export * from './networks'
export * from './memo'
export * from './policy'
export * from './abis'
export { keycardRegistryBytecode, lineBookBytecode } from './bytecode'

/** KeycardRegistry flag bits (must match the Solidity constants). */
export const Flags = {
  ADULT: 1,
  NOT_EXCLUDED_COUNTRY: 2,
  OFAC_CLEAR: 4,
  GUARANTOR: 8,
} as const
export const BORROWER_FLAGS = Flags.ADULT | Flags.NOT_EXCLUDED_COUNTRY | Flags.OFAC_CLEAR
export const GUARANTOR_FLAGS = BORROWER_FLAGS | Flags.GUARANTOR

/** LineBook.Status enum order (must match Solidity). */
export const LineStatus = ['None', 'Active', 'Grace', 'Frozen', 'Defaulted', 'Closed'] as const
export type LineStatusName = (typeof LineStatus)[number]

/** LineBook.FreezeReason enum order. */
export const FreezeReason = { None: 0, MandateRevoked: 1, MissedPayment: 2, Manual: 3, GuarantorWithdrawn: 4 } as const

/** Tempo AccountKeychain precompile (viem tempo/Addresses.ts). */
export const ACCOUNT_KEYCHAIN = '0xaAAAaaAA00000000000000000000000000000000' as const
export * from './selfStatus'
