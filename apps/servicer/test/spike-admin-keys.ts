// Spike (TIP-1049 admin keys): can a passkey added as an ADMIN key on a password wallet replace the password key,
// and can the password key replace a lost passkey? Real transactions on Tempo testnet.
import { createClient, http, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Account, Actions } from 'viem/tempo'
import { P256 } from 'ox'
import { net } from '../src/config'

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

// 1. password wallet = secp256k1 root
const rootPk = generatePrivateKey()
const root = Account.fromSecp256k1(rootPk)
await rl(() => Actions.faucet.fund(pub, { account: root.address }))
for (let i = 0; i < 40 && (await bal(root.address)) === 0n; i++) await sleep(1.5)
ok('password wallet funded', (await bal(root.address)) > 0n, root.address)

// 2. add a passkey (headless WebAuthn P256) as an ADMIN key, signed by the password key
const passPk = P256.randomPrivateKey()
const passkeyAsRoot = Account.fromHeadlessWebAuthn(passPk, { rpId: 'localhost', origin: 'http://localhost:3000' } as any)
const passkey = Account.fromHeadlessWebAuthn(passPk, { access: root.address, rpId: 'localhost', origin: 'http://localhost:3000' } as any)
const rootClient = createClient({ account: root, chain, transport: http(net.rpcUrl) })
await rl(() => Actions.accessKey.authorizeSync(rootClient, { accessKey: { publicKey: (passkeyAsRoot as any).publicKey, type: 'webAuthn' }, admin: true } as any))
ok('passkey authorised as admin on the password wallet', await isAdmin(root.address, (passkey as any).accessKeyAddress))

// 3. FORGOT PASSWORD: the passkey alone authorises a brand-new password key as admin
const newPwPk = generatePrivateKey()
const newPw = Account.fromSecp256k1(newPwPk, { access: root.address })
const passClient = createClient({ account: passkey, chain, transport: http(net.rpcUrl) })
await rl(() => Actions.accessKey.authorizeSync(passClient, { accessKey: { address: newPw.accessKeyAddress, type: 'secp256k1' }, admin: true } as any))
ok('forgot password: passkey added a NEW password key as admin', await isAdmin(root.address, newPw.accessKeyAddress))

// the new password key can move money and manage keys
const npClient = createClient({ account: newPw, chain, transport: http(net.rpcUrl) })
const t = (await rl(() => Actions.token.transferSync(npClient, { token: net.token, to: privateKeyToAccount(generatePrivateKey()).address, amount: 1_000_000n } as any))) as any
ok('new password key can spend from the same wallet', t.receipt.status === 'success')

// 4. LOST PASSKEY: the password key revokes the passkey and adds a new one
await rl(() => Actions.accessKey.revokeSync(npClient, { accessKey: (passkey as any).accessKeyAddress } as any))
const k = await (Actions.accessKey as any).getMetadata?.(pub, { account: root.address, accessKey: (passkey as any).accessKeyAddress }).catch(() => null)
ok('lost passkey: password key revoked the old passkey', !(await isAdmin(root.address, (passkey as any).accessKeyAddress)), JSON.stringify(k ?? {}, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 120))
const pass2Pk = P256.randomPrivateKey()
const pass2AsRoot = Account.fromHeadlessWebAuthn(pass2Pk, { rpId: 'localhost', origin: 'http://localhost:3000' } as any)
const pass2 = Account.fromHeadlessWebAuthn(pass2Pk, { access: root.address, rpId: 'localhost', origin: 'http://localhost:3000' } as any)
await rl(() => Actions.accessKey.authorizeSync(npClient, { accessKey: { publicKey: (pass2AsRoot as any).publicKey, type: 'webAuthn' }, admin: true } as any))
ok('password key added a NEW passkey as admin', await isAdmin(root.address, (pass2 as any).accessKeyAddress))

// 5. revoked passkey really can't sign any more
let refused = false
try { await Actions.token.transferSync(passClient, { token: net.token, to: root.address, amount: 1n } as any) } catch { refused = true }
ok('old passkey is refused on-chain', refused)
process.exit(0)
