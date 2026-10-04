import { router } from 'expo-router'
import { resetTo } from '@/lib/nav'
import { View } from 'react-native'
import type { Me } from '@/lib/session'
import { signOut } from '@/lib/wallet'
import { Button, Panel, Text } from './kit'
import { color, font } from './theme'

export const ROLE: Record<string, string> = { borrower: 'Cardholder', merchant: 'Merchant', guarantor: 'Family backup' }
export const displayName = (me: Me | null) => (me?.user?.username ? `@${me.user.username}` : me?.user?.wallet ? `${me.user.wallet.slice(0, 6)}…${me.user.wallet.slice(-4)}` : '')

export async function switchAccount(after = '/welcome') {
  await signOut()
  resetTo(after)
}

/** Shown when the signed-in account is the wrong kind for this flow. */
export function WrongAccount({ me, want, here }: { me: Me; want: string; here: string }) {
  const role = me.user?.role
  return (
    <Panel>
      <Text v="h2">This is a {ROLE[role ?? ''] ?? role} account</Text>
      <Text v="small" style={{ marginTop: 6 }}>
        {displayName(me)} is signed in. {here} needs a {want} account. Accounts are separate, so one person can have both.
      </Text>
      <Button title="Switch account" style={{ marginTop: 16 }} onPress={() => switchAccount()} />
      <Button title={role === 'merchant' ? 'Back to my shop' : role === 'borrower' ? 'Back to my card' : 'Back'} kind="ghost" style={{ marginTop: 8 }} onPress={() => router.replace('/')} />
    </Panel>
  )
}

export function RolePill({ role }: { role?: string }) {
  if (!role) return null
  return (
    <View style={{ borderWidth: 1, borderColor: 'rgba(179,169,255,0.35)', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontFamily: font.monoMedium, fontSize: 10, letterSpacing: 1.2, color: color.accentHi }}>{(ROLE[role] ?? role).toUpperCase()}</Text>
    </View>
  )
}
