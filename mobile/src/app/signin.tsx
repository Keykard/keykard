import { router } from 'expo-router'
import { resetTo } from '@/lib/nav'
import { homeFor, useSession } from '@/lib/session'
import { Link, Screen, Text } from '@/ui/kit'
import { AuthFlow } from '@/ui/AuthFlow'

/** Sign in: the same flow as sign-up (username first), then straight to the right home for the account. */
export default function SignIn() {
  const { refresh } = useSession()
  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))} />
      <Text v="h1" style={{ marginTop: 18 }}>Welcome to KEYKARD</Text>
      <Text style={{ marginTop: 6 }}>Cardholders, merchants and family backups all sign in here.</Text>
      <AuthFlow
        role="borrower"
        onDone={async () => {
          const me = await refresh()
          resetTo(homeFor(me) as any)
        }}
      />
    </Screen>
  )
}
