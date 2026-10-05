'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Address } from 'viem'
import { api, getConfig, getToken, short, toBase, usd, type AppConfig } from '@/lib/api'
import { explainChainError, getSigner, payRawAddress, payWithCard, revokeKey, signOut, tokenBalance } from '@/lib/wallet'
import { AddMoney } from '@/components/AddMoney'
import { StartOver } from '@/components/StartOver'
import { PhysicalCard } from '@/components/PhysicalCard'
import { LineStatus } from '@/components/LineStatus'
import { UsernameBanner } from '@/components/UsernameBanner'
import { TermsNote } from '@/components/TermsNote'
import { Secured } from '@/components/Secured'
import { SecureNudge, SecurityPanel } from '@/components/Security'
import { MERCHANT_CODE_RE } from '@keycard/sdk'
import type { Me } from '@/components/Onboard'

const STATUS_LABEL: Record<string, string> = { active: 'Active', grace: 'Overdue', frozen: 'Frozen', defaulted: 'Defaulted', settled: 'Settled' }

export default function CardPage() {
  const router = useRouter()
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [walletBal, setWalletBal] = useState<bigint | null>(null)
  const [activity, setActivity] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [merchant, setMerchant] = useState('')
  const [merchantName, setMerchantName] = useState<string | null>(null)
  const [offer, setOffer] = useState<{ pctBps: number; maxPerPayment: string } | null>(null)
  const [amount, setAmount] = useState('')
  const [invite, setInvite] = useState<string | null>(null)
  const [guarAmount, setGuarAmount] = useState('30')

  const load = useCallback(async () => {
    if (!getToken()) return router.replace('/start')
    try {
      const [c, m] = await Promise.all([getConfig(), api<Me>('/api/me')])
      setCfg(c)
      setMe(m)
      if (!m.line || m.line.status === 'preparing') return router.replace('/start')
      if (m.user) setWalletBal(await tokenBalance(m.user.wallet))
      // the activity list is secondary: never let it break the card page
      api('/api/me/activity').then(setActivity).catch(() => setActivity({ spends: [], movements: [], events: [] }))
    } catch (e: any) {
      if (e.status === 401) router.replace('/start')
      else setErr(e.message)
    }
  }, [router])

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('pay')
    if (code) setMerchant(code.toUpperCase())
  }, [])

  useEffect(() => {
    setMerchantName(null)
    setOffer(null)
    if (!MERCHANT_CODE_RE.test(merchant)) return
    api<{ label: string }>(`/api/merchants/${merchant}`, { auth: false })
      .then((m: any) => {
        setMerchantName(m.label)
        setOffer(m.offer ?? null)
      })
      .catch(() => setMerchantName(''))
  }, [merchant])

  useEffect(() => {
    void load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  const line = me?.line
  const frozen = line && line.status !== 'active'

  const pay = async () => {
    setErr(null)
    setMsg(null)
    setBusy(true)
    try {
      const signer = await getSigner()
      const hash = await payWithCard(signer, line.creditAccount as Address, merchant, toBase(amount))
      setMsg(`Paid ${merchantName ?? merchant}. Transaction ${short(hash)} — settling to the merchant now.`)
      setAmount('')
      await load()
    } catch (e: any) {
      setErr(explainChainError(e))
    } finally {
      setBusy(false)
    }
  }

  const tryRawAddress = async () => {
    setErr(null)
    setMsg(null)
    const addr = prompt('Paste any wallet address to try paying $1 directly (the protocol should refuse):')
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return
    setBusy(true)
    try {
      const signer = await getSigner()
      await payRawAddress(signer, line.creditAccount as Address, addr as Address, 1_000_000n)
      setErr('Unexpected: the payment went through.')
    } catch (e: any) {
      setErr(explainChainError(e))
    } finally {
      setBusy(false)
    }
  }

  const inviteGuarantor = async () => {
    setErr(null)
    try {
      const r = await api<{ inviteId: string }>('/api/guarantee/invite', { body: { requested: toBase(guarAmount).toString() } })
      setInvite(`${window.location.origin}/g/${r.inviteId}`)
    } catch (e: any) {
      setErr(e.message)
    }
  }

  const revokeMandate = async () => {
    if (!confirm('Turning off auto-pay freezes your card immediately. Continue?')) return
    setBusy(true)
    setErr(null)
    try {
      const signer = await getSigner()
      const keyId = line.repayKeyId as Address | undefined
      if (!keyId) throw new Error('Auto-pay permission not found')
      await revokeKey(signer, keyId)
      setMsg('Auto-pay turned off. Your card will freeze within a few seconds.')
      await load()
    } catch (e: any) {
      setErr(explainChainError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!line || !cfg) return <main className="wrap"><p className="muted" style={{ marginTop: 40 }}>Loading your card…</p>{err && <p className="error">{err}</p>}</main>

  const spends = activity?.spends ?? []
  const repaid = (activity?.movements ?? []).filter((m: any) => m.status === 'confirmed' && ['INST', 'GUAR', 'EXT', 'SEIZE'].includes(m.kind))
  const charges = activity?.charges ?? []
  const REPAID: Record<string, [string, string]> = {
    INST: ['Auto-pay', 'Bill paid'],
    GUAR: ['Paid by your family backup', 'Covered a missed bill'],
    EXT: ['Repaid from another wallet', 'Applied to your bill'],
    SEIZE: ['Covered by your collateral', 'After the default, from the vault'],
  }
  const tierIdx = cfg.tiers.reduce((i: number, t: any, k: number) => (BigInt(line.unsecuredLimit ?? line.limit ?? '0') >= BigInt(t) ? k : i), 0)

  return (
    <main className="wrap">
      <UsernameBanner username={(me as any)?.user?.username} onSet={load} />
      {me?.user?.username && <SecureNudge username={me.user.username} sec={me.security ?? null} onChange={load} />}
      <div className={`card ${frozen ? 'frozen' : ''}`} data-status={line.status}>
        <span className="chip" aria-hidden />
        <div className="foot">
          <span className="mono">{short(line.creditAccount)}</span>
          <span className="badge">{(STATUS_LABEL[line.status] ?? line.status).toUpperCase()}</span>
        </div>
        <div className="label">Available to spend</div>
        <div className="big">{usd(line.spendable)}</div>
        <div className="small">
          Limit {usd(line.limit)} · owed {usd(line.owed)}{BigInt(line.feesDue ?? 0) > 0n ? ` + ${usd(line.feesDue)} fees` : ''}
        </div>
      </div>

      <nav className="actions" aria-label="Quick actions">
        <a href={frozen ? '#status' : '#pay'}><i aria-hidden>↗</i>Pay</a>
        <a href="#repay"><i aria-hidden>↺</i>Repay</a>
        <a href="#add"><i aria-hidden>+</i>Add money</a>
        <a href="#physical"><i aria-hidden>◈</i>Card</a>
      </nav>

      <div id="status">
        <LineStatus line={line} walletBal={walletBal} onChange={load} />
      </div>
      {err && <p className="error">{err}</p>}
      {msg && <p className="notice">{msg}</p>}

      {!frozen && (
        <section className="panel" id="pay">
          <h2>Pay</h2>
          <label htmlFor="m">Merchant code</label>
          <input id="m" list="merchant-list" autoCapitalize="characters" placeholder="e.g. 7QX2MD" value={merchant} onChange={(e) => setMerchant(e.target.value.toUpperCase().trim())} />
          <datalist id="merchant-list">
            {cfg.merchants.map((m) => (
              <option key={m.code} value={m.code}>{m.label}{m.offerPctBps ? ` · ${m.offerPctBps / 100}% back` : ''}</option>
            ))}
          </datalist>
          {merchantName && (
            <p className="small ok">
              Paying: {merchantName}
              {offer && <span className="pill-offer">{offer.pctBps / 100}% back</span>}
            </p>
          )}
          {merchantName && amount && (() => {
            let base = 0n
            try {
              base = toBase(amount)
            } catch {}
            if (base <= 0n) return null
            const r = cfg.rewards
            let back = r ? (base * BigInt(r.baseCashbackBps)) / 10_000n : 0n
            if (offer) {
              const o = (base * BigInt(offer.pctBps)) / 10_000n
              back += o < BigInt(offer.maxPerPayment) ? o : BigInt(offer.maxPerPayment)
            }
            return back > 0n ? <p className="small muted">You’ll get about {usd(back)} back, paid toward your bill.</p> : null
          })()}
          {merchantName === '' && <p className="small warn">No KEYKARD merchant with this code.</p>}
          <label htmlFor="a">Amount (USD)</label>
          <input id="a" className="amount-input" inputMode="decimal" placeholder="$0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button className="block" style={{ marginTop: 14 }} disabled={busy || !merchantName || !amount} onClick={pay}>
            {busy ? 'Confirming…' : 'Pay with KEYKARD'}
          </button>
          <p className="small muted" style={{ marginTop: 12 }}>
            Your card can only pay KEYKARD merchants. The blockchain enforces this, not us.{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), tryRawAddress())}>See it refuse a random wallet</a>
          </p>
        </section>
      )}

      <section className="panel" id="activity">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Activity</h2>
          <span className="small muted">Receipts are on-chain</span>
        </div>
        {!activity ? (
          <p className="empty">Loading…</p>
        ) : spends.length + repaid.length + charges.length === 0 ? (
          <p className="empty">No payments yet. Your first one shows up here.</p>
        ) : (
          <ul className="list">
            {[
              ...spends.map((s: any) => ({
                key: s.tx_hash, at: s.created_at ?? '', icon: '↗', title: s.label ?? s.merchant_code ?? 'Payment',
                sub: s.status === 'settled' ? 'Paid to merchant' : s.status === 'received' ? 'Settling to merchant…' : s.status.replace(/_/g, ' '),
                amt: `−${usd(s.amount)}`, tone: '', tx: s.tx_hash, link: 'Receipt',
              })),
              ...charges.map((c: any) => ({
                key: c.tx_hash, at: c.created_at ?? '', icon: '!', title: c.kind === 'late_fee' ? 'Late fee' : 'Overdue interest',
                sub: c.kind === 'late_fee' ? 'A bill was missed' : `On ${usd(c.overdue)} overdue`, amt: usd(c.amount), tone: 'warn', tx: c.tx_hash, link: 'Record',
              })),
              ...spends
                .filter((s: any) => s.cashback_status === 'paid' && BigInt(s.base_cashback ?? 0) + BigInt(s.offer_cashback ?? 0) > 0n)
                .map((s: any) => ({
                  key: `${s.tx_hash}-cb`, at: s.created_at ?? '', icon: '★', title: `Cashback · ${s.label ?? s.merchant_code ?? 'shop'}`,
                  sub: BigInt(s.offer_cashback ?? 0) > 0n ? (BigInt(s.base_cashback ?? 0) > 0n ? 'Shop offer + 0.5% back' : 'Shop offer') : '0.5% back on every payment',
                  amt: `+${usd(BigInt(s.base_cashback) + BigInt(s.offer_cashback))}`, tone: 'ok', tx: s.cashback_tx ?? s.tx_hash, link: 'Receipt', in: true,
                })),
              ...(activity?.events ?? [])
                .filter((e: any) => e.action === 'reward.shield_earned' || e.action === 'reward.shield_used')
                .map((e: any, i: number) => ({
                  key: `shield-${i}-${e.created_at}`, at: e.created_at ?? '', icon: '◆',
                  title: e.action === 'reward.shield_earned' ? 'Fee shield earned' : 'Fee shield used',
                  sub: e.action === 'reward.shield_earned' ? '3 on-time bills in a row' : 'Your late fee was cancelled',
                  amt: '', tone: 'ok', tx: null, link: '', in: true,
                })),
              ...repaid.map((m: any) => ({
                key: m.tx_hash, at: m.created_at ?? '', icon: '↺', title: REPAID[m.kind][0], sub: REPAID[m.kind][1],
                amt: `+${usd(m.amount)}`, tone: 'ok', tx: m.tx_hash, link: 'Receipt', in: true,
              })),
            ]
              .sort((a, b) => (b.at > a.at ? 1 : -1))
              .map((r: any) => (
                <li key={r.key}>
                  <span className={`ic ${r.in ? 'in' : ''}`} aria-hidden>{r.icon}</span>
                  <span className="grow">
                    <b>{r.title}</b>
                    <small>{r.sub}</small>
                  </span>
                  <span className={`amt ${r.tone}`}>
                    {r.amt}
                    {r.tx && <a href={`${cfg.explorerUrl}/tx/${r.tx}`} target="_blank" rel="noreferrer">{r.link} ↗</a>}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="panel" id="repay">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Auto-pay</h2>
          <span className={`small ${line.mandateActive ? 'ok' : 'warn'}`}>{line.mandateActive ? '● On' : '● Off'}</span>
        </div>
        <div className="chips">
          <div>Next bill<b>{line.nextDue ? new Date(line.nextDue).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</b></div>
          <div>Your wallet holds<b>{walletBal === null ? '—' : usd(walletBal)}</b></div>
        </div>
        <p className="small muted">
          Bills are paid from your KEYKARD wallet <span className="mono">{short(me?.user?.wallet)}</span>. Keep at least what you owe there.
        </p>
        <span className="eyebrow" style={{ marginTop: 16 }}>Your limit ladder · on-time streak {line.onTimeCount}</span>
        <div className="stepper" style={{ marginTop: 6 }}>
          {cfg.tiers.map((t: any, i: number) => (
            <div key={i} className={i < tierIdx ? 'done' : i === tierIdx ? 'on' : ''}>{usd(t)}</div>
          ))}
        </div>
        <p className="small muted">Two on-time bills in a row move you up a step.</p>
        <ShieldStatus line={line} every={cfg.rewards?.shieldEvery ?? 3} />
        <TermsNote cfg={cfg} />
      </section>

      <Secured line={line} collateral={me?.collateral} cfg={cfg} walletBal={walletBal} onChange={load} />

      {me?.user && (
        <div id="add">
          <AddMoney wallet={me.user.wallet} balance={walletBal} cfg={cfg} onFunded={load} />
        </div>
      )}

      <div id="physical">
        {(!frozen || ['active', 'frozen'].includes(line.card?.status)) && <PhysicalCard card={line.card} onChange={load} canLink={!frozen} />}
      </div>

      <section className="panel" id="family">
        <h2>Family backup</h2>
        {line.guarantorWallet ? (
          <p className="small ok">
            Backed by <span className="mono">{short(line.guarantorWallet)}</span> for up to {usd(line.guaranteed)}.
          </p>
        ) : (
          <>
            <p className="small muted">
              A relative with income can back your line. They sign one capped permission on their own wallet, which is
              charged only if you miss a bill. A backup raises your limit a level.
            </p>
            <label htmlFor="g">Amount to ask for (USD)</label>
            <input id="g" inputMode="decimal" value={guarAmount} onChange={(e) => setGuarAmount(e.target.value)} />
            <button className="ghost block" style={{ marginTop: 12 }} onClick={inviteGuarantor}>
              Create invite link
            </button>
            {invite && (
              <div className="notice small">
                Send this to them: <span className="mono">{invite}</span>
              </div>
            )}
          </>
        )}
      </section>

      {me?.user?.username && <SecurityPanel username={me.user.username} sec={me.security ?? null} onChange={load} />}

      <section className="panel" id="settings">
        <h2>Settings</h2>
        <button className="danger block" disabled={busy || !line.mandateActive || ['defaulted', 'settled'].includes(line.status)} onClick={revokeMandate}>
          Turn off auto-pay
        </button>
        <p className="small muted">Turning off auto-pay freezes your card straight away. You can turn it back on.</p>
        <button className="ghost block" style={{ marginTop: 8 }} onClick={() => (signOut(), router.replace('/'))}>
          Sign out
        </button>
        <StartOver label="Use a different account on this browser" />
      </section>
      <p className="small muted center">
        Every line event is recorded on-chain. <Link href="/stats">See the public credit file</Link>
      </p>
    </main>
  )
}

/** Rewards: progress toward the next fee shield (3 on-time bills in a row cancel the next late fee). */
function ShieldStatus({ line, every }: { line: any; every: number }) {
  const streak = Number(line.onTimeStreak ?? 0)
  const shield = Number(line.feeShields ?? 0) > 0
  const step = streak % every
  return (
    <div className="shield">
      <div className="row between">
        <span className="small"><b>{shield ? 'Fee shield ready' : 'Fee shield'}</b></span>
        <span className="small muted">{shield ? 'Your next late fee is cancelled' : `${step} of ${every} on-time bills`}</span>
      </div>
      <div className="shield-dots" aria-hidden>
        {Array.from({ length: every }).map((_, i) => <i key={i} className={shield || i < step ? 'on' : ''} />)}
      </div>
    </div>
  )
}
