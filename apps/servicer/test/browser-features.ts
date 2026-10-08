/**
 * Real-browser check of card freeze, payment requests with an amount and the shareable credit file, with screenshots.
 *   servicer on :8799 (jobs may be off), web on :3000 with NEXT_PUBLIC_API_URL=http://localhost:8799.
 *   LINE_ID=<active line> MERCHANT=<code> npx tsx test/browser-features.ts
 */
import { createRequire } from 'node:module'
import { mintSession } from '../src/auth'
import { sql } from '../src/db'
const require = createRequire(import.meta.url)
const { chromium } = require('/downloads/World-Fair/keycard/apps/web/node_modules/playwright') as typeof import('playwright')

const WEB = 'http://localhost:3000'
const OUT = process.env.OUT ?? '/tmp/claude-1000/-downloads-World-Fair/8bb19613-6daf-4e09-b050-e78ca555fcd4/scratchpad/features'
let failed = 0
const check = (n: string, ok: boolean, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failed++ }

const [line] = await sql`SELECT l.borrower_wallet, u.username FROM lines l JOIN users u ON u.wallet=l.borrower_wallet WHERE l.id=${process.env.LINE_ID ?? 36}`
const [shop] = await sql`SELECT code, owner_wallet, label FROM merchants WHERE code=${process.env.MERCHANT ?? 'XLSU6F'}`
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('dialog', (d) => void d.accept())
const as = async (wallet: string) => { await page.goto(WEB + '/stats'); await page.evaluate((t) => localStorage.setItem('keycard.session', t), mintSession(wallet as any)) }

// payment request: merchant asks for an amount → link carries it
await as(shop.owner_wallet)
await page.goto(WEB + '/merchant')
await page.locator('#ask').waitFor({ timeout: 30_000 })
await page.fill('#ask', '3.25')
const link = await page.locator('.till .mono').first().textContent()
check('merchant link carries the amount', !!link?.endsWith(`/card?pay=${shop.code}&amount=3.25`), link ?? '')
check('till says what it asks for', (await page.locator('.till').textContent())!.includes('Asking for $3.25'))
await page.locator('.till').screenshot({ path: `${OUT}-request.png` })

// cardholder opens the link → amount and shop filled in
await as(line.borrower_wallet)
await page.goto(`${WEB}/card?pay=${shop.code}&amount=3.25`)
await page.locator('#a').waitFor({ timeout: 30_000 })
await page.waitForTimeout(1500)
check('card opens with the amount filled in', (await page.inputValue('#a')) === '3.25', await page.inputValue('#a'))
await page.goto(`${WEB}/card?pay=${shop.code}&amount=abc`)
await page.locator('#a').waitFor({ timeout: 30_000 })
await page.waitForTimeout(1000)
check('a junk amount is ignored', (await page.inputValue('#a')) === '')

// freeze from the card page
const freeze = page.getByRole('button', { name: 'Freeze card' })
await freeze.waitFor({ timeout: 30_000 })
await freeze.click()
await page.getByRole('button', { name: 'Unfreeze' }).waitFor({ timeout: 60_000 })
check('card shows FROZEN', (await page.locator('.badge').first().textContent())?.includes('FROZEN') ?? false)
await page.screenshot({ path: `${OUT}-frozen.png` })
await page.getByRole('button', { name: 'Unfreeze' }).click()
await freeze.waitFor({ timeout: 60_000 })
check('unfreeze restores the card', true)

// credit file: share → public page → hide
await sql`UPDATE users SET public_profile=false WHERE wallet=${line.borrower_wallet}`
await page.reload()
const sw = page.getByRole('switch', { name: 'Share my credit file' })
await sw.waitFor({ timeout: 30_000 })
await sw.click()
await page.waitForFunction(() => document.querySelector('[aria-label="Share my credit file"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 15_000 })
check('share link shown', (await page.locator('#credit-file').textContent())!.includes(`/u/${line.username}`))
await page.locator('#credit-file').screenshot({ path: `${OUT}-share.png` })
const pub = await browser.newPage({ viewport: { width: 400, height: 860 } })
await pub.goto(`${WEB}/u/${line.username}`)
await pub.getByText('bills paid on time').waitFor({ timeout: 30_000 })
check('public credit file renders', (await pub.locator('h1').textContent()) === `@${line.username}`)
await pub.screenshot({ path: `${OUT}-file-phone.png`, fullPage: true })
await pub.setViewportSize({ width: 1440, height: 900 })
await pub.screenshot({ path: `${OUT}-file-desktop.png`, fullPage: true })
await sw.click()
await page.waitForFunction(() => document.querySelector('[aria-label="Share my credit file"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 15_000 })
await pub.reload()
await pub.getByText('No credit file here').waitFor({ timeout: 30_000 })
check('hidden file shows "No credit file here"', true)
await pub.screenshot({ path: `${OUT}-file-hidden.png` })

await browser.close()
await sql.end()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
