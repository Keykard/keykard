/**
 * Real-browser check of the new sign-in (Chromium + CDP virtual authenticator = a real passkey), with screenshots.
 *   servicer on :8787 (ALLOW_DEV_VERIFY=1), web on :3000.   npx tsx test/browser-auth.ts
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('/downloads/World-Fair/keycard/apps/web/node_modules/playwright') as typeof import('playwright')

const WEB = 'http://localhost:3000'
const OUT = '/tmp/claude-1000/-downloads-World-Fair/67a1a873-e6e8-4753-8070-ce0b4b9bcd1c/scratchpad/auth'
const results: string[] = []
const check = (n: string, ok: boolean, d = '') => { const l = `${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`; console.log(l); results.push(l); if (!ok) process.exitCode = 1 }
let shot = 0

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200)) })
  page.on('response', async (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().replace(WEB, ''), (await r.text().catch(() => '')).slice(0, 200)) })
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const snap = async (name: string) => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true }) }
  const signOut = async (path = '/start') => { await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k === 'keycard.session' || k === 'keycard.passkey') localStorage.removeItem(k) }); await page.goto(WEB + path) }

  // ---- A. sign up (cardholder), add a passkey, verify ----
  const uname = 'ba' + Date.now().toString(36)
  const PW1 = 'Sunny-Harbor-2026!'
  await page.goto(`${WEB}/start`)
  await page.waitForSelector('#auth-user')
  await page.fill('#auth-user', '')
  await snap('username')
  await page.fill('#auth-user', uname)
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('text=Create your account')
  await page.fill('#auth-newpw', 'short')
  await snap('create-weak')
  await page.fill('#auth-newpw', PW1)
  await page.selectOption('#auth-country', 'PHL')
  await page.check('text=This is my country of residence')
  await snap('create-filled')
  await page.click('button:has-text("Create account")')
  await page.waitForSelector('text=Sign in faster next time', { timeout: 60_000 })
  check('sign-up → passkey offer', true)
  await snap('passkey-offer')
  await page.click('button:has-text("Add fingerprint sign-in")')
  await page.waitForSelector('text=Verify you’re a real, unique person', { timeout: 90_000 })
  check('passkey added → continue to Self verification', true)
  await snap('verify')
  const sec1 = await page.evaluate(() => fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('keycard.session') } }).then((r) => r.json()))
  check('account has password + passkey + recovery', sec1.security?.hasPassword && sec1.security?.passkeys.length === 1 && sec1.security?.recoveryOn, JSON.stringify(sec1.security).slice(0, 140))
  await page.click('button:has-text("Skip verification (testnet only)")')
  await page.waitForSelector('text=Your auto-pay', { timeout: 60_000 })
  check('verified → auto-pay step', true)

  // ---- B. sign in with the passkey (identifier-first, one prompt) ----
  await signOut()
  await page.waitForSelector('#auth-user')
  await page.fill('#auth-user', uname)
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('text=Welcome back')
  await snap('welcome-back')
  await page.click('button:has-text("Continue with passkey")')
  await page.waitForSelector('text=Your auto-pay', { timeout: 60_000 })
  check('sign in with passkey', true)

  // ---- C. forgot password → passkey → new password ----
  await signOut()
  await page.fill('#auth-user', uname)
  await page.click('button:has-text("Continue")')
  await page.waitForSelector('text=Forgot password?')
  await page.click('text=Forgot password?')
  await page.waitForSelector('text=Forgot your password?')
  await snap('forgot')
  await page.click('button:has-text("Continue with passkey")')
  await page.waitForSelector('text=Choose a new password', { timeout: 60_000 })
  const PW2 = 'Quiet-Lantern-7781#'
  await page.fill('#auth-resetpw', PW2)
  await snap('reset')
  await page.click('button:has-text("Save new password")')
  await page.waitForSelector('text=Your auto-pay', { timeout: 90_000 })
  check('forgot password: reset with passkey', true)

  // ---- D. the new password works, the old one doesn't ----
  await signOut()
  await page.fill('#auth-user', uname)
  await page.click('button:has-text("Continue")')
  await page.fill('#auth-pw', PW1)
  await page.click('button:has-text("Sign in")')
  await page.waitForSelector('text=That password isn’t right', { timeout: 30_000 })
  check('old password refused with a clear message', true)
  await snap('wrong-password')
  await page.fill('#auth-pw', PW2)
  await page.click('button:has-text("Sign in")')
  await page.waitForSelector('text=Your auto-pay', { timeout: 60_000 })
  check('new password signs in', true)

  // ---- E. merchant sign-up from the same screen, then security settings ----
  await signOut('/merchant')
  const m = 'bm' + Date.now().toString(36)
  await page.waitForSelector('#auth-user')
  await page.fill('#auth-user', m)
  await page.click('button:has-text("Continue")')
  await page.fill('#auth-newpw', 'Copper-Kettle-5530%')
  await page.selectOption('#auth-country', 'MEX')
  await page.check('text=This is my country of residence')
  await page.click('button:has-text("Create account")')
  await page.waitForSelector('text=Sign in faster next time', { timeout: 60_000 })
  await page.click('button:has-text("Not now")')
  await page.waitForSelector('button:has-text("Skip verification (testnet only)")', { timeout: 30_000 })
  await page.click('button:has-text("Skip verification (testnet only)")')
  await page.waitForSelector('#label', { timeout: 30_000 })
  await snap('merchant-shop')
  await page.fill('#label', 'Browser Bakery')
  await page.click('button:has-text("Get my merchant code")')
  await page.waitForSelector('text=Sign-in & security', { timeout: 60_000 })
  check('merchant signed up via the same screen and sees security settings', true)
  await snap('merchant-security')
  page.once('dialog', (d) => d.accept())
  await page.click('button[role=switch]')
  await page.waitForTimeout(500)
  await page.waitForSelector('text=Account recovery is off.', { timeout: 60_000 }).catch(() => {})
  await page.reload()
  await page.waitForSelector('text=Sign-in & security', { timeout: 30_000 })
  const offState = await page.locator('button[role=switch]').getAttribute('aria-checked')
  check('recovery switch turns off', offState === 'false', String(offState))
  await snap('recovery-off')
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed`)
  await browser.close()
}
main().catch((e) => { console.error('BROWSER FATAL', e); process.exitCode = 1; process.exit(1) })
