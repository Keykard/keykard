// Spike 2 (TIP-1049 admin keys, the exact flows the new sign-in uses). Real transactions on Tempo testnet.
//   a) password wallet adds passkey + KEYKARD recovery key as admins in ONE batched transaction
//   b) the PASSKEY (admin, not root) signs a one-signature auto-pay permission that a new key then activates
//   c) the RECOVERY key alone adds a new password key and removes the old passkey (user lost both)
import { createClient, encodeFunctionData, http, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sendTransactionSync } from 'viem/actions'
import { Abis, Account, Actions } from 'viem/tempo'
import { P256 } from 'ox'
import { ACCOUNT_KEYCHAIN, mandateKeyPolicy } from '@keycard/sdk'
import { net } from '../src/config'
import { treasury } from '../src/chain'

const chain = net.chain.extend({ feeToken: net.feeToken })
const pub = createClient({ chain, transport: http(net.rpcUrl) })
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))
const bal = async (a: Address) => ((await Actions.token.getBalance(pub, { account: a, token: net.token } as any)) as any).amount as bigint
const ok = (n: string, v: boolean, d = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`)
async function rl<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e: any) {
      if (i > 6 || !/rate limit|exceeds defined limit|429/i.test(String(e?.details ?? e?.message ?? e))) throw e
      await sleep(0.4 * 2 ** i)
    }
  }
}
const isAdmin = (account: Address, key: Address) => (Actions.accessKey as any).isAdmin(pub, { account, accessKey: key }) as Promise<boolean>
const SIG = { secp256k1: 0, p256: 1, webAuthn: 2 } as const
const addAdmin = (keyId: Address, type: keyof typeof SIG) => ({
  to: ACCOUNT_KEYCHAIN, data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'authorizeAdminKey', args: [keyId, SIG[type], `0x${'0'.repeat(64)}`] } as any),
})
const revoke = (keyId: Address) => ({ to: ACCOUNT_KEYCHAIN, data: encodeFunctionData({ abi: Abis.accountKeychain, functionName: 'revokeKey', args: [keyId] } as any) })
const wa = { rpId: 'localhost', origin: 'http://localhost:3000' } as any

const root = Account.fromSecp256k1(generatePrivateKey())
await rl(() => Actions.faucet.fund(pub, { account: root.address }))
for (let i = 0; i < 40 && (await bal(root.address)) === 0n; i++) await sleep(1.5)
ok('password wallet funded', (await bal(root.address)) > 0n)

// a) one transaction: passkey + recovery key as admins
const passPk = P256.randomPrivateKey()
const passkey = Account.fromHeadlessWebAuthn(passPk, { ...wa, access: root.address })
const recoveryPk = generatePrivateKey()
const recovery = Account.fromSecp256k1(recoveryPk, { access: root.address })
const rootClient = createClient({ account: root, chain, transport: http(net.rpcUrl) })
const a = (await rl(() => sendTransactionSync(rootClient, { calls: [addAdmin((passkey as any).accessKeyAddress, 'webAuthn'), addAdmin(recovery.accessKeyAddress, 'secp256k1')] } as any))) as any
ok('a) one tx added passkey + recovery key', a.status === 'success')
ok('a) passkey is admin', await isAdmin(root.address, (passkey as any).accessKeyAddress))
ok('a) recovery key is admin', await isAdmin(root.address, recovery.accessKeyAddress))

// b) an ADMIN key (the passkey) grants auto-pay by sending the authorization itself (Tempo requires the admin
//    that signs a key authorization to also sign the transaction carrying it)
const mandatePk = generatePrivateKey()
const mandate = Account.fromSecp256k1(mandatePk, { access: root.address })
const passClient = createClient({ account: passkey, chain, transport: http(net.rpcUrl) })
const pol = mandateKeyPolicy({ token: net.token, instalment: 5_000_000n, period: 600, repayTo: treasury.address, expiry: Math.floor(Date.now() / 1000) + 86400 })
const act = (await rl(() => Actions.accessKey.authorizeSync(passClient, { accessKey: { address: mandate.accessKeyAddress, type: 'secp256k1' }, ...pol } as any))) as any
ok('b) auto-pay permission granted by the PASSKEY (self-submitted)', act.receipt?.status === 'success')
const mClient = createClient({ account: mandate, chain, transport: http(net.rpcUrl) })
const pull = (await rl(() => Actions.token.transferSync(mClient, { token: net.token, to: treasury.address, amount: 1_000_000n } as any))) as any
ok('b) the auto-pay key can pay KEYKARD', pull.receipt.status === 'success')
let scoped = false
try { await Actions.token.transferSync(mClient, { token: net.token, to: root.address, amount: 1n } as any) } catch { scoped = true }
ok('b) …and only KEYKARD', scoped)

// c) user lost both: the recovery key adds a new password key + removes the old passkey, in one tx
const newPw = Account.fromSecp256k1(generatePrivateKey(), { access: root.address })
const recClient = createClient({ account: recovery, chain, transport: http(net.rpcUrl) })
const c = (await rl(() => sendTransactionSync(recClient, { calls: [addAdmin(newPw.accessKeyAddress, 'secp256k1'), revoke((passkey as any).accessKeyAddress)] } as any))) as any
ok('c) recovery tx succeeded', c.status === 'success')
ok('c) new password key is admin', await isAdmin(root.address, newPw.accessKeyAddress))
ok('c) old passkey removed', !(await isAdmin(root.address, (passkey as any).accessKeyAddress)))
const spend = (await rl(() => Actions.token.transferSync(createClient({ account: newPw, chain, transport: http(net.rpcUrl) }), { token: net.token, to: treasury.address, amount: 1n } as any))) as any
ok('c) new password key controls the SAME wallet', spend.receipt.status === 'success', root.address)
process.exit(0)
