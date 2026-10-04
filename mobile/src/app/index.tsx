import { useState } from 'react'
import { Go } from '@/ui/Go'
import { ActivityIndicator, View } from 'react-native'
import { getToken } from '@/lib/api'
import { homeFor, useSession } from '@/lib/session'
import { Button, Screen, Text } from '@/ui/kit'
import { color } from '@/ui/theme'

/** Launch gate: signed in → the right home; signed out → welcome; signed in but offline → retry. */
export default function Index() {
  const { loading, signedIn, me, refresh } = useSession()
  const [retrying, setRetrying] = useState(false)
  if (loading) return <View style={{ flex: 1, backgroundColor: color.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={color.accent} /></View>
  if (signedIn && !me && getToken()) {
    return (
      <Screen scroll={false} style={{ justifyContent: 'center' }}>
        <Text v="h1">Can’t reach KEYKARD</Text>
        <Text style={{ marginTop: 10 }}>Check your internet connection. Your card and money are safe; nothing is lost.</Text>
        <Button title="Try again" busy={retrying} style={{ marginTop: 24 }} onPress={async () => {
          setRetrying(true)
          await refresh()
          setRetrying(false)
        }} />
      </Screen>
    )
  }
  if (!signedIn || !me) return <Go href="/welcome" />
  return <Go href={homeFor(me) as any} />
}
