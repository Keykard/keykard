import { useLocalSearchParams } from 'expo-router'
import { Go } from '@/ui/Go'
import { amountFromQr, codeFromQr } from '@/lib/qr'
import { homeFor, useSession } from '@/lib/session'

/** App Link target for https://…/card?pay=CODE[&amount=X] (merchant QR codes scanned with the phone camera). */
export default function CardLink() {
  const { pay, amount } = useLocalSearchParams<{ pay?: string; amount?: string }>()
  const { me, loading, signedIn } = useSession()
  if (loading) return null
  if (!signedIn || !me) return <Go href="/welcome" />
  const code = pay ? codeFromQr(String(pay)) : null
  const amt = amount ? amountFromQr(`?amount=${amount}`) : undefined
  if (code && me.user?.role === 'borrower' && me.line?.status === 'active') return <Go href={{ pathname: '/pay', params: amt ? { code, amount: amt } : { code } }} />
  return <Go href={homeFor(me) as any} />
}
