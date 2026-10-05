import type { Address } from 'viem'
import { tempo, tempoModerato } from 'viem/chains'

export type NetworkName = 'testnet' | 'mainnet'

export type Network = {
  name: NetworkName
  chain: typeof tempo | typeof tempoModerato
  chainId: number
  rpcUrl: string
  explorerUrl: string
  /** Stablecoin credit lines are denominated in. */
  token: Address
  tokenSymbol: string
  tokenDecimals: number
  /**
   * Fee token. MUST equal `token`: the spike showed a limited access key whose
   * fees are paid in a token it has no limit for fails every tx (SpendingLimitExceeded).
   * In production all fees are sponsored anyway.
   */
  feeToken: Address
  /** Deployed KEYKARD contracts (filled after deploy). */
  registry?: Address
  lineBook?: Address
  /** Published pricing for missed payments + the public record of every charge. */
  creditTerms?: Address
  /** Holds 1:1 stablecoin collateral for secured lines. */
  collateralVault?: Address
  deployBlock?: bigint
}

// Addresses verified 2026-09-28 against tokenlist.tempo.xyz and viem chain definitions.
const TESTNET_ALPHA_USD: Address = '0x20c0000000000000000000000000000000000001' // faucet-funded
const MAINNET_USDC_E: Address = '0x20c000000000000000000000b9537d11c60e8b50'

export const networks: Record<NetworkName, Network> = {
  testnet: {
    name: 'testnet',
    chain: tempoModerato,
    chainId: 42431,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
    token: TESTNET_ALPHA_USD,
    tokenSymbol: 'AlphaUSD',
    tokenDecimals: 6,
    feeToken: TESTNET_ALPHA_USD,
  },
  mainnet: {
    name: 'mainnet',
    chain: tempo,
    chainId: 4217,
    rpcUrl: 'https://rpc.tempo.xyz',
    explorerUrl: 'https://explore.tempo.xyz',
    token: MAINNET_USDC_E,
    tokenSymbol: 'USDC.e',
    tokenDecimals: 6,
    feeToken: MAINNET_USDC_E,
  },
}

export function getNetwork(name: string | undefined, deployed?: Partial<Network>): Network {
  const n = name === 'mainnet' ? networks.mainnet : networks.testnet
  return { ...n, ...deployed }
}

export const explorerTx = (n: Network, hash: string) => `${n.explorerUrl}/tx/${hash}`
export const explorerAddress = (n: Network, addr: string) => `${n.explorerUrl}/address/${addr}`
