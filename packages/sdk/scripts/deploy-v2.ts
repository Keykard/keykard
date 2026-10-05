// Deploys CreditTerms + CollateralVault next to the existing LineBook and adds them to deployments/<network>.json.
//   pnpm --filter @keycard/sdk exec tsx scripts/deploy-v2.ts testnet
// Then proves on-chain that a wallet can approve + deposit in ONE batched Tempo transaction, and withdraw.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, encodeFunctionData, erc20Abi, http, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { deployContract, readContract, sendTransactionSync, waitForTransactionReceipt } from 'viem/actions'
import { Account, Actions } from 'viem/tempo'
import { collateralVaultAbi, collateralVaultBytecode, creditTermsAbi, creditTermsBytecode, getNetwork } from '../src/index'

const networkName = process.argv[2] ?? 'testnet'
const env = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, `../../../.env.${networkName}`), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const file = resolve(import.meta.dirname, `../../../deployments/${networkName}.json`)
const deployed = JSON.parse(readFileSync(file, 'utf8'))
const net = getNetwork(networkName)
const chain = net.chain.extend({ feeToken: net.feeToken })
const treasury = Account.fromSecp256k1(env.TREASURY_PK as Hex)
const servicer = Account.fromSecp256k1(env.SERVICER_PK as Hex)
const client = createClient({ account: treasury, chain, transport: http(net.rpcUrl) })

// Published terms: $1 per missed bill, 2% of the overdue amount per period, all charges capped at 25% of it.
const TERMS = { lateFee: 1_000_000n, penaltyBps: 200, capBps: 2_500 }

const bal = async (a: Address) => ((await Actions.token.getBalance(client, { account: a, token: net.token } as any)) as any).amount as bigint

async function deploy(label: string, abi: any, bytecode: Hex, args: any[]) {
  const hash = await deployContract(client, { abi, bytecode, args } as any)
  const r = await waitForTransactionReceipt(client, { hash })
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`${label} deploy failed`)
  console.log(label, r.contractAddress, hash)
  return { address: r.contractAddress.toLowerCase() as Address, hash, block: r.blockNumber }
}

async function main() {
  const terms = deployed.creditTerms
    ? { address: deployed.creditTerms as Address, hash: deployed.txs.creditTerms }
    : await deploy('CreditTerms', creditTermsAbi, creditTermsBytecode, [treasury.address, servicer.address, deployed.lineBook, TERMS.lateFee, TERMS.penaltyBps, TERMS.capBps])
  const vault = deployed.collateralVault
    ? { address: deployed.collateralVault as Address, hash: deployed.txs.collateralVault }
    : await deploy('CollateralVault', collateralVaultAbi, collateralVaultBytecode, [treasury.address, servicer.address, net.token, deployed.lineBook])
  writeFileSync(file, JSON.stringify({ ...deployed, creditTerms: terms.address, collateralVault: vault.address, txs: { ...deployed.txs, creditTerms: terms.hash, collateralVault: vault.hash } }, null, 2))

  // ---- spike: a fresh wallet approves + deposits in one batched tx, then withdraws ----
  if (networkName !== 'testnet') return
  const user = Account.fromSecp256k1(generatePrivateKey())
  const uc = createClient({ account: user, chain, transport: http(net.rpcUrl) })
  await Actions.faucet.fund(client, { account: user.address })
  for (let i = 0; i < 30 && (await bal(user.address)) === 0n; i++) await new Promise((r) => setTimeout(r, 1500))
  const amount = 5_000_000n
  const r = await sendTransactionSync(uc, {
    calls: [
      { to: net.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault.address, amount] }) },
      { to: vault.address, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [amount] }) },
    ],
  } as any)
  console.log('batched approve+deposit', (r as any).transactionHash, (r as any).status)
  const dep = await readContract(client, { address: vault.address, abi: collateralVaultAbi, functionName: 'deposited', args: [user.address] })
  console.log('deposited', dep)
  const w = await sendTransactionSync(uc, {
    to: vault.address, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [amount] }),
  } as any)
  console.log('withdraw', (w as any).transactionHash, (w as any).status)
  console.log('vault holds for user after withdraw', await readContract(client, { address: vault.address, abi: collateralVaultAbi, functionName: 'deposited', args: [user.address] }))
  const t = await readContract(client, { address: terms.address, abi: creditTermsAbi, functionName: 'lateFee' })
  console.log('terms.lateFee', t)
}
main().catch((e) => { console.error(e); process.exit(1) })
