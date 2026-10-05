import Link from 'next/link'
import { Nav } from '@/components/site/Nav'
import { Reveal, Rise } from '@/components/site/Reveal'
import { Magnetic } from '@/components/site/Magnetic'
import { LiveStats } from '@/components/site/LiveStats'
import { CssCard } from '@/components/site/CssCard'
import { StatesTrack } from '@/components/site/StatesTrack'
import { PhoneMock } from '@/components/site/PhoneMock'

const K = ({ k }: { k: string }) => <i data-k={k} className="kc-marker" aria-hidden />

const STEPS = [
  { k: 'how-1', n: '01', title: 'Get a limit.', body: 'Verified in minutes, your first line starts at $20. No collateral, no deposit, no credit history needed.', extra: 'how-1b' },
  { k: 'how-2', n: '02', title: 'Tap to pay.', body: 'Pay any KEYKARD merchant with Face ID, a password on any device, or by tapping a physical NFC card.' },
  { k: 'how-3', n: '03', title: 'Auto-pay, capped by the chain.', body: 'You sign one permission: at most one bill per period, and only to KEYKARD. Tempo enforces the cap, so we physically can’t take more. Revoke it any time.' },
  { k: 'how-4', n: '04', title: 'Pay on time, grow.', body: 'Two on-time bills in a row raise your limit: $20 → $50 → $100. Need more now? Lock stablecoins as collateral and your limit grows 1:1. Every payment builds a credit file that belongs to you.' },
]

/** After the hackathon: from stablecoin credit to everyday money. Plans, not shipped features. */
const ROADMAP = [
  ['Now', 'Live on Tempo testnet', 'Stablecoin credit lines, KEYKARD merchants, a tap-to-pay NFC card, family backup, 1:1 secured limits and repayment from any wallet or exchange.'],
  ['Next', 'Mainnet, real dollars', 'USDC on Tempo mainnet with small, capped limits. Repay from exchanges that already support Tempo, or from any wallet.'],
  ['Soon', 'Collateral that earns', 'Collateral behind a bigger limit goes into a Tempo Earn vault instead of sitting idle, so it keeps earning while you spend. On Tempo mainnet, an Earn vault for the USDC KEYKARD uses is already live.'],
  ['Then', 'Crypto in, cash out', 'Licensed on- and off-ramp partners: top up and repay from a bank account or cash, and merchants are paid out in their local currency.'],
  ['After', 'Any card terminal', 'A virtual and physical KEYKARD on a global card network through an issuing partner, so it works wherever cards do, with the same on-chain limits.'],
]

const FAQ = [
  ['Is this real money?', 'KEYKARD runs on Tempo with real stablecoins. The pilot is live on Tempo testnet with small limits while we finish mainnet launch.'],
  ['Can KEYKARD take more than I agreed?', 'No. The auto-pay permission is scoped on-chain: one bill per period, capped, and payable only to KEYKARD. The Tempo protocol rejects anything else, even from us.'],
  ['How do you verify who I am (KYC)?', 'With Self. You verify your passport or ID card in the Self app, and Self proves, with zero knowledge, that the document is genuine and government-issued, that you are over 18, not on a sanctions list, and one unique person. We receive the proof, never the document. That check is what lets us lend without a bank account or a credit score.'],
  ['What happens if I miss a payment?', 'Your card pauses and the app shows exactly what’s due and the deadline. A missed bill costs a $1 late fee, then 2% of the overdue amount each billing period, never more than 25% of it in total; family backups never pay fees. Past the deadline it’s recorded on your public credit file, and paying it settles your record. The terms are published on-chain.'],
  ['Can I borrow more?', 'Yes. Pay on time and your limit climbs on its own. To go higher straight away, lock stablecoins as collateral and your limit grows 1:1. The collateral sits in an on-chain vault; KEYKARD can only take it after a default, and only what you owe. Next: that collateral will earn yield in a Tempo Earn vault while it backs your card.'],
  ['Can I repay from an exchange or another wallet?', 'Yes. Send stablecoins on Tempo to your KEYKARD wallet from an exchange, any wallet or a family member. Auto-pay pays your bill from it, and if a bill is overdue it’s collected as soon as the money arrives.'],
  ['Where can I pay?', 'Today: any KEYKARD merchant, and anyone can become one in a minute. Next: any card terminal, through a card-network partner, with the shop paid in local currency.'],
  ['Do I get rewards?', 'Yes. Every card payment gives 0.5% back, and shops can run their own offers like “10% back”. Cashback pays down your bill first. Pay 3 bills on time in a row and your next late fee is cancelled. Shops pay for it, like with any card, but KEYKARD’s 1% fee is far below the 2–3% card networks charge.'],
  ['Are there fees?', 'Not if you pay on time. KEYKARD sponsors every network fee, so your card never pays gas. Only a missed bill costs anything, and the cap is published on-chain.'],
]

export default function Home() {
  return (
    <>
      <Nav />
      <main className="kc-main">
        {/* 1 · Hero */}
        <section className="kc-hero kc-scene" aria-labelledby="hero-title">
          <K k="hero" />
          <div className="kc-hero__copy">
            <Reveal as="p" className="kc-kicker" onLoad>Stablecoin credit · on Tempo</Reveal>
            <Reveal as="h1" className="kc-h1" onLoad delay={0.1} id="hero-title">Credit without the bank.</Reveal>
            <Reveal as="p" className="kc-lede" onLoad delay={0.25}>
              A credit card for people no bank will score. No collateral needed. Free if you pay on time. Every rule enforced by the blockchain, not by us.
            </Reveal>
            <Rise className="kc-cta" delay={0.4}>
              <Magnetic href="/start">Get your card</Magnetic>
              <Magnetic href="/merchant" variant="ghost">I’m a merchant</Magnetic>
            </Rise>
            <Rise delay={0.5}>
              <a className="kc-link" href="https://github.com/Keykard/keykard/releases/latest/download/KEYKARD-android.apk" style={{ marginTop: 0, marginBottom: 32 }}>Get the Android app ↓</a>
            </Rise>
            <Rise delay={0.55}>
              <LiveStats compact />
            </Rise>
          </div>
          <div className="kc-hero__card kc-only-fallback">
            <CssCard />
          </div>
          <a href="#verify" className="kc-scroll-hint" aria-label="Scroll to learn more"><span /></a>
        </section>

        {/* 2 · Verify */}
        <section id="verify" className="kc-split kc-split--right kc-scene" aria-labelledby="verify-title">
          <K k="verify" />
          <div className="kc-copy">
            <Reveal as="p" className="kc-kicker">01 · Identity · KYC</Reveal>
            <Reveal as="h2" className="kc-h2" id="verify-title">Prove you’re human. Not who you are.</Reveal>
            <Reveal as="p" className="kc-body">
              Our KYC is a zero-knowledge ID check with Self. Verify your passport or ID card in the Self app and it proves the document is genuine and government-issued, that you’re over 18, not on a sanctions list, and one unique person. No documents stored, no face on our servers, one line per human.
            </Reveal>
          </div>
        </section>

        {/* 3 · How it works */}
        <section id="how" className="kc-how" aria-labelledby="how-title">
          <div className="kc-how__head">
            <Reveal as="p" className="kc-kicker">02 · How it works</Reveal>
            <Reveal as="h2" className="kc-h2" id="how-title">A credit line in four moves.</Reveal>
          </div>
          {STEPS.map((s) => (
            <div key={s.k} className="kc-step kc-scene">
              <K k={s.k} />
              <div className="kc-copy">
                <span className="kc-step__n" aria-hidden>{s.n}</span>
                <Reveal as="h3" className="kc-h3">{s.title}</Reveal>
                <Reveal as="p" className="kc-body">{s.body}</Reveal>
              </div>
              {s.extra && <i data-k={s.extra} className="kc-marker kc-marker--low" aria-hidden />}
            </div>
          ))}
        </section>

        {/* 4 · Enforced */}
        <section className="kc-enforced kc-scene" aria-labelledby="enforced-title">
          <K k="enforced" />
          <div className="kc-copy">
            <Reveal as="p" className="kc-kicker">03 · Protocol</Reveal>
            <Reveal as="h2" className="kc-h2" id="enforced-title">Enforced by the chain, not by us.</Reveal>
            <Reveal as="p" className="kc-body">
              Your card’s permission is scoped on Tempo itself. Try to pay a random wallet and the protocol refuses before any server sees it. Try it yourself in the app.
            </Reveal>
            <div className="kc-refused" aria-hidden>
              <K k="enforced-hit" />
              <span>Payment to 0x7f3a…c21e</span>
              <strong>Refused by Tempo</strong>
            </div>
          </div>
          <i data-k="enforced-out" className="kc-marker kc-marker--low" aria-hidden />
        </section>

        {/* 5 · States */}
        <StatesTrack />

        {/* 6 · Family */}
        <section id="family" className="kc-split kc-scene" aria-labelledby="family-title">
          <K k="family" />
          <div className="kc-copy">
            <Reveal as="p" className="kc-kicker">05 · Family backup</Reveal>
            <Reveal as="h2" className="kc-h2" id="family-title">Backed by family, from anywhere.</Reveal>
            <Reveal as="p" className="kc-body">
              A relative with income can back your line. They sign one capped permission on their own wallet. It’s charged only if you miss, never more than they agreed, and they’re told before you’re late, not after. A backup raises your limit a level.
            </Reveal>
          </div>
          <i data-k="family-out" className="kc-marker kc-marker--low" aria-hidden />
        </section>

        {/* 7 · Merchants */}
        <section id="merchants" className="kc-merchants kc-scene" aria-labelledby="merchants-title">
          <K k="merchants" />
          <div className="kc-copy">
            <Reveal as="p" className="kc-kicker">06 · Merchants</Reveal>
            <Reveal as="h2" className="kc-h2" id="merchants-title">Anyone can accept KEYKARD.</Reveal>
            <Reveal as="p" className="kc-body">
              Register in a minute with any wallet. Customers scan your code or tap their card, and you’re paid in USDC on Tempo within seconds.
            </Reveal>
            <div className="kc-rails">
              <Rise className="kc-rail">
                <span className="kc-rail__tag">Today</span>
                <h3>USDC on Tempo</h3>
                <p>Settled to your wallet in seconds, with every payment on-chain.</p>
              </Rise>
              <Rise className="kc-rail kc-rail--next" delay={0.1}>
                <span className="kc-rail__tag">Next</span>
                <h3>Any card terminal</h3>
                <p>Through a card-network partner, your credit line authorises on Tempo and the shop receives local currency. They never touch crypto.</p>
              </Rise>
            </div>
            <Link href="/merchant" className="kc-link">Accept KEYKARD →</Link>
            <i data-k="merchants-out" className="kc-marker kc-marker--low" aria-hidden />
            <ul className="kc-sr">
              <li>Coffee</li><li>Groceries</li><li>Books</li><li>Transit</li><li>Street food</li><li>Pharmacy</li><li>Freelancers</li><li>Online stores</li><li>Tuition</li><li>Mobile top-up</li>
            </ul>
          </div>
        </section>

        {/* 8 · Demo */}
        <section className="kc-demo" aria-labelledby="demo-title">
          <K k="demo" />
          <div className="kc-copy">
            <Reveal as="p" className="kc-kicker">07 · The app</Reveal>
            <Reveal as="h2" className="kc-h2" id="demo-title">Everything on one screen.</Reveal>
            <Reveal as="p" className="kc-body">
              What you can spend, what you owe, when auto-pay runs, and a receipt for every payment. Plain words, no wallet jargon.
            </Reveal>
            <Rise className="kc-cta">
              <Magnetic href="/start">Try it live</Magnetic>
              <Magnetic href="https://github.com/Keykard/keykard/releases/latest/download/KEYKARD-android.apk" variant="ghost">Get the Android app</Magnetic>
            </Rise>
            <p className="kc-muted" style={{ marginTop: 14 }}>Android 9+ · 97 MB · iPhone: open this site in Safari and add it to your home screen.</p>
          </div>
          <Rise className="kc-demo__phone">
            <PhoneMock />
          </Rise>
        </section>

        {/* 9 · No fees */}
        <section className="kc-fees" aria-labelledby="fees-title">
          <Reveal as="h2" className="kc-mega" id="fees-title">Pay on time, pay nothing. Not even gas.</Reveal>
          <div className="kc-marquee" aria-hidden>
            <div>
              {Array.from({ length: 2 }).map((_, j) => (
                <span key={j}>
                  Sponsored gas <i /> 0.5% back on every payment <i /> Public credit file <i /> Zero-knowledge KYC <i /> Face ID or password <i /> No collateral needed <i /> 1:1 secured limits <i /> Repay from any wallet <i /> Auto-pay you can revoke <i /> Family backup <i /> Tap-to-pay NFC card <i />
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* 10 · Live */}
        <section id="live" className="kc-live" aria-labelledby="live-title">
          <Reveal as="p" className="kc-kicker">Live on Tempo</Reveal>
          <Reveal as="h2" className="kc-h2" id="live-title">Every number here is on-chain.</Reveal>
          <Rise>
            <LiveStats />
          </Rise>
          <Link href="/stats" className="kc-link">See the public credit file →</Link>
        </section>

        {/* 10b · Roadmap */}
        <section id="roadmap" className="kc-road" aria-labelledby="road-title">
          <K k="road" />
          <Reveal as="p" className="kc-kicker">After the hackathon</Reveal>
          <Reveal as="h2" className="kc-h2" id="road-title">From stablecoins to everyday money.</Reveal>
          <ol className="kc-road__list">
            {ROADMAP.map(([when, title, body]) => (
              <li key={when}>
                <span className="kc-road__when">{when}</span>
                <h3 className="kc-h3">{title}</h3>
                <p className="kc-body">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* 11 · FAQ */}
        <section id="faq" className="kc-faq" aria-labelledby="faq-title">
          <Reveal as="h2" className="kc-h2" id="faq-title">Questions.</Reveal>
          <div className="kc-faq__list">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* 12 · Final */}
        <section className="kc-final kc-scene" aria-labelledby="final-title">
          <K k="final" />
          <Reveal as="h2" className="kc-mega" id="final-title">Your first line is a minute away.</Reveal>
          <Rise className="kc-cta kc-cta--center">
            <Magnetic href="/start">Get your card</Magnetic>
            <Magnetic href="/card" variant="ghost">I have a KEYKARD</Magnetic>
          </Rise>
        </section>
      </main>
      <footer className="kc-footer">
        <span>KEYKARD · a pilot credit programme with small limits</span>
        <span>
          Built on <a href="https://tempo.xyz" target="_blank" rel="noreferrer">Tempo</a> · Identity by <a href="https://self.xyz" target="_blank" rel="noreferrer">Self</a>
        </span>
      </footer>
    </>
  )
}
