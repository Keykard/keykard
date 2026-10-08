// Spike: can KEYKARD collateral earn inside a Tempo Earn vault, on testnet, end to end?
//   pnpm --filter @keycard/sdk exec tsx scripts/spike-earn.ts
// Uses a FRESH faucet-funded key (never the production treasury), deploys:
//   DemoYieldVenue (ERC-4626 over AlphaUSD, simulated yield) → Tempo Earn stack (viem deployErc4626StackSync)
//   → a CollateralVault whose token is the Earn share.
// Then: deposit into Earn, lock the shares as collateral, add simulated yield, check value grew, unlock, redeem.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, encodeFunctionData, erc20Abi, http, toHex, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { deployContract, readContract, sendTransactionSync, waitForTransactionReceipt } from 'viem/actions'
import { Account, Actions } from 'viem/tempo'
import { collateralVaultAbi, collateralVaultBytecode, getNetwork } from '../src/index'

const net = getNetwork('testnet')
const deployed = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../deployments/testnet.json'), 'utf8'))
const venueArt = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/out/DemoYieldVenue.sol/DemoYieldVenue.json'), 'utf8'))
const chain = net.chain.extend({ feeToken: net.feeToken })
const me = Account.fromSecp256k1(generatePrivateKey())
const client = createClient({ account: me, chain, transport: http(net.rpcUrl) })
const bal = async (token: Address, a: Address = me.address) => (await readContract(client, { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [a] })) as bigint
const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(6)
const send = async (label: string, to: Address, data: Hex) => {
  const r: any = await sendTransactionSync(client, { to, data } as any)
  console.log(`  ${label}: ${r.status} ${r.transactionHash}`)
  if (r.status !== 'success') throw new Error(label)
  return r
}

async function main() {
  console.log('spike key', me.address)
  await Actions.faucet.fund(client, { account: me.address })
  for (let i = 0; i < 40 && (await bal(net.token)) === 0n; i++) await new Promise((r) => setTimeout(r, 1500))
  console.log('funded', fmt(await bal(net.token)), 'AlphaUSD')

  // 1. venue
  const vh = await deployContract(client, { abi: venueArt.abi, bytecode: venueArt.bytecode.object, args: [net.token, 6, 'KEYKARD Demo Yield (testnet)', 'kdYIELD'] } as any)
  const venue = (await waitForTransactionReceipt(client, { hash: vh })).contractAddress as Address
  console.log('venue', venue)

  // 2. Earn stack over the venue
  const deploymentId = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const stack: any = await (Actions as any).earn.deployErc4626StackSync(client, { deploymentId, venue, name: 'KEYKARD Collateral Earn (testnet)', symbol: 'kcEARN' })
  console.log('earn stack', JSON.stringify({ vault: stack.vault, earnShare: stack.earnShare, engine: stack.engine, fees: stack.fees }))
  const earnVault = stack.vault as Address
  const share = stack.earnShare as Address

  // 3. deposit 10 AlphaUSD → Earn shares
  const { Abis } = await import('viem/tempo')
  void Abis
  const dep: any = await (Actions as any).earn.depositSync(client, { vault: earnVault, assetAmount: 10_000_000n, shareAmountMin: 1n })
  console.log('  earn deposit:', dep.receipt?.status ?? dep.status, dep.receipt?.transactionHash ?? dep.transactionHash)
  let pos: any = await (Actions as any).earn.getPosition(client, { account: me.address, vault: earnVault })
  console.log('position after deposit: shares', pos.shareBalance.toString(), 'value', fmt(pos.value))

  // 4. collateral vault holding Earn shares
  const ch = await deployContract(client, { abi: collateralVaultAbi, bytecode: collateralVaultBytecode, args: [me.address, me.address, share, deployed.lineBook] } as any)
  const cv = (await waitForTransactionReceipt(client, { hash: ch })).contractAddress as Address
  console.log('share-collateral vault', cv)
  const shares = pos.shareBalance as bigint
  const r: any = await sendTransactionSync(client, {
    calls: [
      { to: share, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cv, shares] }) },
      { to: cv, data: encodeFunctionData({ abi: collateralVaultAbi, functionName: 'deposit', args: [shares] }) },
    ],
  } as any)
  console.log('  lock shares as collateral (approve+deposit, one tx):', r.status, r.transactionHash)
  const held = await bal(share, cv)
  const valueOf = async (s: bigint) => (await readContract(client, { address: earnVault, abi: (await import('viem/tempo')).Abis.earnVault, functionName: 'previewRedeem', args: [s] })) as bigint
  const v0 = await valueOf(held)
  console.log('collateral value before yield', fmt(v0))

  // 5. simulated yield: +0.50 AlphaUSD into the venue
  await send('approve venue', net.token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [venue, 500_000n] }))
  await send('donate (simulated yield)', venue, encodeFunctionData({ abi: venueArt.abi, functionName: 'donate', args: [500_000n] }))
  const v1 = await valueOf(held)
  console.log('collateral value after yield ', fmt(v1), `(+${fmt(v1 - v0)})`)

  // 6. unlock and redeem
  await send('withdraw shares from collateral', cv, encodeFunctionData({ abi: collateralVaultAbi, functionName: 'withdraw', args: [shares] }))
  const before = await bal(net.token)
  const red: any = await (Actions as any).earn.redeemSync(client, { vault: earnVault, shareAmount: shares, slippageBps: 100 })
  console.log('  earn redeem:', red.receipt?.status ?? red.status, red.receipt?.transactionHash ?? red.transactionHash)
  console.log('AlphaUSD back', fmt((await bal(net.token)) - before), 'for 10.000000 deposited')
  pos = await (Actions as any).earn.getPosition(client, { account: me.address, vault: earnVault })
  console.log('shares left', pos.shareBalance.toString())
}
main().catch((e) => { console.error(e); process.exit(1) })
