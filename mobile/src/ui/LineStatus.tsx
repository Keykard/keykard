import { useEffect, useState } from 'react'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import { api } from '@/lib/api'
import { until, usd } from '@/lib/format'
import type { Line } from '@/lib/session'
import { explainChainError, renewMandateFlow } from '@/lib/wallet'
import { PasskeyCancelled } from '@/lib/passkey'
import { Banner, Button, Text } from './kit'
import { color } from './theme'

function useNow() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * One clear banner per line state, with the one action that fixes it:
 *   active → next bill · grace → overdue + Pay now · frozen → why + fix · defaulted → Pay to settle · settled → new line
 */
export function LineStatus({ line, walletBal, onChange }: { line: Line; walletBal: bigint | null; onChange: () => void }) {
  const now = useNow()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const owed = BigInt(line.owed ?? '0')
  const due = BigInt(line.amountDue ?? '0')
  const fees = BigInt(line.feesDue ?? '0')
  // the borrowed amount, plus any fees from a missed bill (paid in that order)
  const payable = (line.status === 'defaulted' ? due : owed > due ? owed : due) + fees
  const feeNote = fees > 0n ? ` (includes ${usd(fees)} in late fees)` : ''
  const short = walletBal !== null && payable > walletBal ? payable - walletBal : 0n

  const act = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      setMsg(done)
      onChange()
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled) && !/cancelled/i.test(e?.message)) setErr(explainChainError(e))
    } finally {
      setBusy(null)
    }
  }
  const payNow = act('pay', () => api('/api/lines/pay-now', { method: 'POST' }), 'Payment collected.')
  const renew = act('renew', () => renewMandateFlow(), 'Auto-pay is back on.')

  const PayBtn = ({ label }: { label: string }) => (
    <Button testID="status-pay-now" title={busy === 'pay' ? 'Collecting…' : label} busy={busy === 'pay'} disabled={!!busy || payable === 0n || !line.mandateActive} style={{ marginTop: 12 }} onPress={payNow} />
  )
  const RenewBtn = () => <Button testID="status-renew" title={busy === 'renew' ? 'Confirm in your wallet…' : 'Turn auto-pay back on'} busy={busy === 'renew'} disabled={!!busy} style={{ marginTop: 12 }} onPress={renew} />
  const Low = () =>
    short > 0n ? (
      <Text v="small" style={{ color: color.warn, marginTop: 8 }}>
        Your wallet has {usd(walletBal)}. Add at least {usd(short)}. <Text v="small" style={{ color: color.accentHi }} onPress={() => router.push('/add-money')}>Add money ›</Text>
      </Text>
    ) : null

  const Elsewhere = () =>
    line.repayAccount && payable > 0n ? (
      <Text v="small" style={{ marginTop: 10 }}>
        Or send it from any wallet or exchange: <Text v="small" style={{ color: color.accentHi }} onPress={() => router.push('/repay')}>your repayment address ›</Text>
      </Text>
    ) : null

  const nextIn = until(line.nextDue, now)
  const graceIn = until(line.graceUntil, now)
  let body: React.ReactNode = null
  if (line.status === 'active') {
    body =
      owed + fees > 0n ? (
        <Banner kind="info">
          <Text v="small" style={{ color: color.text }}>
            Next bill in <Text v="small" style={{ color: color.text, fontFamily: 'Geist_600SemiBold' }}>{nextIn ?? '—'}</Text>: {usd(owed + fees)}{feeNote} will be paid automatically from your wallet.
          </Text>
          <Low />
          {line.mandateActive && <Button testID="status-pay-early" title={busy === 'pay' ? 'Collecting…' : `Pay ${usd(owed + fees)} now`} kind="ghost" small busy={busy === 'pay'} disabled={!!busy} style={{ marginTop: 12 }} onPress={payNow} />}
        </Banner>
      ) : null
  } else if (line.status === 'grace') {
    body = (
      <Banner kind="error">
        <Text v="small" style={{ color: '#FFB3B3' }}>
          <Text v="small" style={{ color: '#fff', fontFamily: 'Geist_600SemiBold' }}>{usd(due)} is overdue.</Text> Your card is paused until it’s paid. Deadline: {graceIn}
          {line.guarantorWallet ? ', then your family backup is charged.' : BigInt(line.secured ?? '0') > 0n ? ', then your line defaults and your collateral covers it.' : ', then your line defaults.'}
          {fees > 0n ? ` A late fee applies, and interest is added each period it stays overdue: you now owe ${usd(payable)}.` : ''}
        </Text>
        <Low />
        {line.mandateActive ? <PayBtn label={`Pay ${usd(payable)} now`} /> : <RenewBtn />}
        <Elsewhere />
      </Banner>
    )
  } else if (line.status === 'frozen') {
    const why =
      line.freezeReason === 'MandateRevoked' ? 'you turned off auto-pay'
      : line.freezeReason === 'MissedPayment' ? 'a missed bill was covered by your family backup'
      : line.freezeReason === 'Manual' ? 'KEYKARD froze it'
      : 'it is frozen'
    body = (
      <Banner kind="error">
        <Text v="small" style={{ color: '#FFB3B3' }}>
          <Text v="small" style={{ color: '#fff', fontFamily: 'Geist_600SemiBold' }}>Card frozen</Text> because {why}. Tempo refuses any payment from it until that’s fixed.
          {due > 0n ? ` ${usd(due)} is overdue${line.graceUntil ? ` (deadline ${graceIn})` : ''}.` : ''}
        </Text>
        <Low />
        {line.freezeReason === 'MandateRevoked' && !line.mandateActive && <RenewBtn />}
        {line.mandateActive && payable > 0n && <PayBtn label={`Pay ${usd(payable)} now`} />}
        {line.freezeReason === 'MissedPayment' && <Text v="small" style={{ marginTop: 8 }}>Settle with your family backup, then contact KEYKARD to reopen.</Text>}
        <Elsewhere />
      </Banner>
    )
  } else if (line.status === 'defaulted') {
    body = (
      <Banner kind="error">
        <Text v="small" style={{ color: '#FFB3B3' }}>
          <Text v="small" style={{ color: '#fff', fontFamily: 'Geist_600SemiBold' }}>Line defaulted.</Text> You owe {usd(payable)}{feeNote}. It’s on your public
          credit file and interest is added each period until it’s paid (capped). Paying it settles your record and lets you open a new line.
        </Text>
        <Low />
        {line.mandateActive ? <PayBtn label={`Pay ${usd(payable)} to settle`} /> : <RenewBtn />}
        <Elsewhere />
      </Banner>
    )
  } else if (line.status === 'settled') {
    body = (
      <Banner kind="ok">
        <Text v="small" style={{ color: color.text }}>Settled. Your defaulted line was repaid in full.</Text>
        <Button title="Open a new line" style={{ marginTop: 12 }} onPress={() => router.push('/onboard?role=borrower')} />
      </Banner>
    )
  }
  return (
    <>
      {body}
      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
    </>
  )
}
