import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './tokens.css'
import './globals.css'

const sans = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL('https://www.keykard.xyz'),
  twitter: { card: 'summary_large_image' },
  title: 'KEYKARD credit without the bank',
  description:
    'A stablecoin credit card on Tempo. No bank, no collateral needed, free if you pay on time. Your card can only pay KEYKARD merchants, repayment is an auto-pay capped by the blockchain, and family can back you.',
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0A0A0B' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
