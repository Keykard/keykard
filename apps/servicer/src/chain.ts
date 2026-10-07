import { createClient, http, type Address, type Hex } from 'viem'
import { getBlockNumber, getLogs, readContract, waitForTransactionReceipt, writeContract } from 'viem/actions'
import { parseAbiItem } from 'viem'
import { Abis, Account, Actions } from 'viem/tempo'
import { ACCOUNT_KEYCHAIN, collateralVaultAbi, creditTermsAbi, keycardRegistryAbi, lineBookAbi } from '@keycard/sdk'
import { keys, net } from './config'

export const chain = net.chain.extend({ feeToken: net.feeToken })
/** Reads may retry; WRITES must never be auto-retried by the transport (double-send hazard). */
export const transport = http(net.rpcUrl, { retryCount: 6, retryDelay: 400 })
const writeTransport = http(net.rpcUrl, { retryCount: 0 })

/** Treasury: owns contracts, funds credit accounts, receives repayments, sponsors every fee. */
export const treasury = Account.fromSecp256k1(keys.treasury)
export const attester = Account.fromSecp256k1(keys.attester)
export const servicer = Account.fromSecp256k1(keys.servicer)
/** KEYKARD network settlement address: every card payment goes here, memo names the merchant. */
export const settlement = Account.fromSecp256k1(keys.settlement)

export const publicClient = createClient({ chain, transport })
export const clientFor = (account: any) => createClient({ account, chain, transport: writeTransport })
export const treasuryClient = clientFor(treasury)

export async function tokenBalance(owner: Address): Promise<bigint> {
  const r = (await Actions.token.getBalance(publicClient, { account: owner, token: net.token } as any)) as any
  return r.amount as bigint
}

/**
 * Sponsored TIP-20 transfer. Fees are ALWAYS paid by the treasury: the spike proved that fees paid by
 * a limited key's account count against its limit (spike S9), and sponsored pulls are exact (spike P2).
 */
export async function sponsoredTransfer(p: { account: any; to: Address; amount: bigint; memo?: Hex }) {
  // rate-limited sends are rejected before broadcast, so they're retried here (merchant payouts, cashback, pulls)
  const r = await sendWithBackoff(() =>
    Actions.token.transferSync(clientFor(p.account), {
      token: net.token,
      to: p.to,
      amount: p.amount,
      memo: p.memo,
      // a sender cannot be its own fee payer ("fee payer cannot resolve to sender")
      ...(p.account.address.toLowerCase() === treasury.address.toLowerCase() ? {} : { feePayer: treasury }),
    } as any),
  )
  const receipt = (r as any).receipt
  if (receipt.status !== 'success') throw new Error(`transfer reverted: ${receipt.transactionHash}`)
  return receipt.transactionHash as Hex
}

// ---------------- AccountKeychain reads ----------------

export type KeyInfo = { exists: boolean; revoked: boolean; expiry: bigint; raw: unknown }

export async function getKey(account: Address, keyId: Address): Promise<KeyInfo> {
  const raw = (await readContract(publicClient, {
    address: ACCOUNT_KEYCHAIN,
    abi: Abis.accountKeychain,
    functionName: 'getKey',
    args: [account, keyId],
  } as any)) as any
  // KeyInfo tuple: field names per ABI; treat zero expiry / zero keyId as "not found"
  const expiry = BigInt(raw?.expiry ?? 0)
  const revoked = Boolean(raw?.isRevoked ?? raw?.revoked ?? false)
  const keyIdOut = (raw?.keyId ?? raw?.publicKey ?? '0x0000000000000000000000000000000000000000') as string
  return { exists: expiry > 0n && !/^0x0+$/.test(keyIdOut), revoked, expiry, raw }
}

export async function remainingLimit(account: Address, keyId: Address) {
  const [remaining, periodEnd] = (await readContract(publicClient, {
    address: ACCOUNT_KEYCHAIN,
    abi: Abis.accountKeychain,
    functionName: 'getRemainingLimitWithPeriod',
    args: [account, keyId, net.token],
  } as any)) as [bigint, bigint]
  return { remaining, periodEnd }
}

export async function allowedCalls(account: Address, keyId: Address) {
  const [isScoped, scopes] = (await readContract(publicClient, {
    address: ACCOUNT_KEYCHAIN,
    abi: Abis.accountKeychain,
    functionName: 'getAllowedCalls',
    args: [account, keyId],
  } as any)) as [boolean, { target: Address; selectorRules: { selector: Hex; recipients: Address[] }[] }[]]
  return { isScoped, scopes }
}

/**
 * Verifies a key on-chain matches exactly the policy KEYKARD expects: live, only token transfers,
 * only to `recipients`, limit >= `minLimit` remaining capacity semantics checked by caller.
 */
export async function verifyKeyPolicy(p: {
  account: Address
  keyId: Address
  recipients: Address[]
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const k = await getKey(p.account, p.keyId)
  if (!k.exists) return { ok: false, reason: 'key not found on-chain' }
  if (k.revoked) return { ok: false, reason: 'key revoked' }
  const { isScoped, scopes } = await allowedCalls(p.account, p.keyId)
  if (!isScoped) return { ok: false, reason: 'key is not call-scoped (allowAnyCalls)' }
  const want = new Set(p.recipients.map((r) => r.toLowerCase()))
  for (const s of scopes) {
    if (s.target.toLowerCase() !== net.token.toLowerCase()) return { ok: false, reason: `scope targets ${s.target}` }
    for (const rule of s.selectorRules) {
      if (rule.recipients.length === 0) return { ok: false, reason: 'selector without recipient allow-list' }
      for (const r of rule.recipients) if (!want.has(r.toLowerCase())) return { ok: false, reason: `unexpected recipient ${r}` }
    }
  }
  return { ok: true }
}

// ---------------- KEYKARD contracts ----------------

/** RPC rate limits reject a write BEFORE it is broadcast, so only those are retried (never a sent tx). */
const rateLimited = (e: any) => /rate limit|429|exceeds defined limit/i.test(String(e?.details ?? e?.shortMessage ?? e?.message ?? e))
export async function sendWithBackoff<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send()
    } catch (e) {
      if (!rateLimited(e) || attempt >= 6) throw e
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt))
    }
  }
}

export async function lineBookWrite(functionName: string, args: readonly unknown[]) {
  const hash = await sendWithBackoff(() => writeContract(clientFor(servicer), {
    address: net.lineBook!,
    abi: lineBookAbi,
    functionName,
    args,
    feePayer: treasury,
  } as any))
  const receipt = await waitForTransactionReceipt(publicClient, { hash })
  if (receipt.status !== 'success') throw new Error(`LineBook.${functionName} reverted ${hash}`)
  return receipt
}

export async function registryWrite(functionName: string, args: readonly unknown[], as: 'attester' | 'owner' = 'attester') {
  const hash = await sendWithBackoff(() => writeContract(clientFor(as === 'attester' ? attester : treasury), {
    address: net.registry!,
    abi: keycardRegistryAbi,
    functionName,
    args,
    ...(as === 'attester' ? { feePayer: treasury } : {}),
  } as any))
  const receipt = await waitForTransactionReceipt(publicClient, { hash })
  if (receipt.status !== 'success') throw new Error(`KeycardRegistry.${functionName} reverted ${hash}`)
  return receipt
}

export async function registryRead<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  return (await readContract(publicClient, { address: net.registry!, abi: keycardRegistryAbi, functionName, args } as any)) as T
}

const transferWithMemoEvent = parseAbiItem(
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
)

/**
 * Reconciliation: has a transfer with this exact memo from `from` to `to` already landed?
 * Every KEYKARD money movement carries a unique memo, so this is the source of truth before any retry.
 */
export async function findMemoTransfer(p: { from: Address; to: Address; memo: Hex; lookbackBlocks?: bigint }) {
  const head = await getBlockNumber(publicClient)
  const lookback = p.lookbackBlocks ?? 200_000n
  const floor = net.deployBlock ?? 0n
  let fromBlock = head > lookback ? head - lookback : 0n
  if (fromBlock < floor) fromBlock = floor
  const step = 20_000n
  for (let start = fromBlock; start <= head; start += step) {
    const end = start + step - 1n > head ? head : start + step - 1n
    const logs = (await getLogs(publicClient, {
      address: net.token,
      event: transferWithMemoEvent,
      args: { from: p.from, to: p.to, memo: p.memo },
      fromBlock: start,
      toBlock: end,
    } as any)) as any[]
    if (logs.length > 0) return { txHash: logs[0].transactionHash as Hex, amount: BigInt(logs[0].args.amount) }
  }
  return null
}

export async function lineBookRead<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  return (await readContract(publicClient, { address: net.lineBook!, abi: lineBookAbi, functionName, args } as any)) as T
}

// ---------------- CreditTerms (pricing for missed payments) + CollateralVault (secured lines) ----------------

export async function termsWrite(functionName: string, args: readonly unknown[]) {
  if (!net.creditTerms) throw new Error('CreditTerms not deployed')
  const hash = await sendWithBackoff(() => writeContract(clientFor(servicer), { address: net.creditTerms!, abi: creditTermsAbi, functionName, args, feePayer: treasury } as any))
  const receipt = await waitForTransactionReceipt(publicClient, { hash })
  if (receipt.status !== 'success') throw new Error(`CreditTerms.${functionName} reverted ${hash}`)
  return receipt
}

export async function termsRead<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await readContract(publicClient, { address: net.creditTerms!, abi: creditTermsAbi, functionName, args } as any)) as T
}

export async function vaultWrite(functionName: string, args: readonly unknown[]) {
  if (!net.collateralVault) throw new Error('CollateralVault not deployed')
  const hash = await sendWithBackoff(() => writeContract(clientFor(servicer), { address: net.collateralVault!, abi: collateralVaultAbi, functionName, args, feePayer: treasury } as any))
  const receipt = await waitForTransactionReceipt(publicClient, { hash })
  if (receipt.status !== 'success') throw new Error(`CollateralVault.${functionName} reverted ${hash}`)
  return receipt
}

export async function vaultRead<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await readContract(publicClient, { address: net.collateralVault!, abi: collateralVaultAbi, functionName, args } as any)) as T
}
