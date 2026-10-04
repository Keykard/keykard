import { Pressable, View } from 'react-native'
import { Go } from '@/ui/Go'
import { router } from 'expo-router'
import { short, usd } from '@/lib/format'
import { homeFor, useSession } from '@/lib/session'
import { Panel, Row, Screen, Text } from '@/ui/kit'
import { KeyMark } from '@/ui/KeykardCard'
import { color } from '@/ui/theme'

const LINE: Record<string, [string, string]> = {
  active: ['On track', color.ok], grace: ['Overdue: they have a few days to pay', color.warn], frozen: ['Card frozen', color.ice],
  defaulted: ['Defaulted', color.bad], settled: ['Settled', color.text], preparing: ['Setting up', color.text3],
}

/** Home for family backups: who you back, for how much, and how they're doing. */
export default function Backing() {
  const { me, loading } = useSession()
  if (!loading && (!me?.user || me.user.role !== 'guarantor' || !me.identity.verified)) return <Go href={homeFor(me) as any} />
  const list = me?.guaranteeing ?? []
  return (
    <Screen>
      <Row between style={{ marginTop: 6 }}>
        <Row><KeyMark /><Text v="h3" style={{ letterSpacing: 3, fontSize: 13 }}>KEYKARD</Text></Row>
        <Pressable accessibilityLabel="Settings" onPress={() => router.push('/settings')} hitSlop={12}><Text style={{ fontSize: 18, color: color.text }}>⚙︎</Text></Pressable>
      </Row>
      <Text v="eyebrow" style={{ marginTop: 22 }}>Family backup</Text>
      <Text v="h1" style={{ marginTop: 8 }}>People you back</Text>
      <Text style={{ marginTop: 6 }}>You’re only ever charged if they miss a bill and don’t fix it in time, and never more than you agreed.</Text>
      {list.length === 0 ? (
        <Panel><Text v="small">You’re not backing anyone yet. When someone sends you an invite link, open it on this phone.</Text></Panel>
      ) : (
        list.map((g: any) => {
          const [label, c] = LINE[g.line_status] ?? [g.line_status, color.text2]
          return (
            <Panel key={g.invite_id}>
              <Row between>
                <Text v="h3">{short(g.borrower_wallet)}</Text>
                <Text v="small" style={{ color: c }}>● {label}</Text>
              </Row>
              <Text v="small" style={{ marginTop: 6 }}>You back up to {usd(g.guaranteed ?? g.cap ?? '0')}. Invite {g.status}.</Text>
            </Panel>
          )
        })
      )}
      <View style={{ height: 20 }} />
    </Screen>
  )
}
