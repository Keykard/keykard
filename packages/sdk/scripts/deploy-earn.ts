// Collateral that earns (testnet): deploys DemoYieldVenue (ERC-4626 over AlphaUSD, SIMULATED yield), a Tempo Earn
// stack over it (viem deployErc4626StackSync), and a second CollateralVault whose token is the Earn share.
//   pnpm --filter @keycard/sdk exec tsx scripts/deploy-earn.ts
// Signs with a dedicated Earn admin key kept OUTSIDE the repo (../keykard-secrets/earn-admin.key, created on first
// run), never with the production treasury: the new CollateralVault is constructed with the existing treasury as owner
// and the existing servicer as servicer, so nothing the running backend uses is touched. Resumable.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, erc20Abi, http, toHex, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { deployContract, readContract, waitForTransactionReceipt } from 'viem/actions'
import { Account, Actions } from 'viem/tempo'
import { collateralVaultAbi, collateralVaultBytecode, getNetwork } from '../src/index'

const root = resolve(import.meta.dirname, '../../..')
const file = resolve(root, 'deployments/testnet.json')
const keyFile = resolve(root, '../keykard-secrets/earn-admin.key')
const venueArt = JSON.parse(readFileSync(resolve(root, 'contracts/out/DemoYieldVenue.sol/DemoYieldVenue.json'), 'utf8'))
const net = getNetwork('testnet')
const chain = net.chain.extend({ feeToken: net.feeToken })

if (!existsSync(keyFile)) writeFileSync(keyFile, generatePrivateKey() + '\n', { mode: 0o600 })
const admin = Account.fromSecp256k1(readFileSync(keyFile, 'utf8').trim() as Hex)
const client = createClient({ account: admin, chain, transport: http(net.rpcUrl) })
const save = (d: any) => writeFileSync(file, JSON.stringify(d, null, 2) + '\n')

async function deploy(label: string, abi: any, bytecode: Hex, args: any[]) {
  const hash = await deployContract(client, { abi, bytecode, args } as any)
  const r = await waitForTransactionReceipt(client, { hash })
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`${label} deploy failed`)
  console.log(label, r.contractAddress, hash)
  return { address: r.contractAddress.toLowerCase() as Address, hash }
}

async function main() {
  const d = JSON.parse(readFileSync(file, 'utf8'))
  d.txs ??= {}
  console.log('earn admin', admin.address)
  const bal = async () => (await readContract(client, { address: net.token, abi: erc20Abi, functionName: 'balanceOf', args: [admin.address] })) as bigint
  if ((await bal()) < 1_000_000n) {
    await Actions.faucet.fund(client, { account: admin.address })
    for (let i = 0; i < 40 && (await bal()) < 1_000_000n; i++) await new Promise((r) => setTimeout(r, 1500))
  }

  if (!d.yieldVenue) {
    const v = await deploy('DemoYieldVenue', venueArt.abi, venueArt.bytecode.object, [net.token, 6, 'KEYKARD Demo Yield (testnet)', 'kdYIELD'])
    d.yieldVenue = v.address
    d.txs.yieldVenue = v.hash
    save(d)
  }
  if (!d.earnVault) {
    d.earnDeploymentId ??= toHex(crypto.getRandomValues(new Uint8Array(32)))
    save(d)
    const s: any = await (Actions as any).earn.deployErc4626StackSync(client, {
      deploymentId: d.earnDeploymentId, venue: d.yieldVenue, name: 'KEYKARD Collateral Earn (testnet)', symbol: 'kcEARN',
    })
    if (!s.vault) throw new Error('Earn stack incomplete, run again to resume')
    Object.assign(d, { earnVault: s.vault.toLowerCase(), earnShare: s.earnShare.toLowerCase(), earnEngine: s.engine.toLowerCase(), earnAdmin: admin.address })
    console.log('Earn vault', s.vault, 'share', s.earnShare)
    save(d)
  }
  if (!d.earnCollateralVault) {
    const v = await deploy('CollateralVault (Earn shares)', collateralVaultAbi, collateralVaultBytecode, [d.owner, d.servicer, d.earnShare, d.lineBook])
    d.earnCollateralVault = v.address
    d.txs.earnCollateralVault = v.hash
    save(d)
  }
  const [owner, servicer, token] = await Promise.all(
    (['owner', 'servicer', 'token'] as const).map((f) => readContract(client, { address: d.earnCollateralVault, abi: collateralVaultAbi, functionName: f } as any)),
  )
  console.log('earn collateral vault', d.earnCollateralVault, { owner, servicer, token })
  if (String(owner).toLowerCase() !== d.owner.toLowerCase() || String(servicer).toLowerCase() !== d.servicer.toLowerCase() || String(token).toLowerCase() !== d.earnShare)
    throw new Error('earn collateral vault wired wrong')
}
main().catch((e) => { console.error(e); process.exit(1) })
