import { useState } from 'react'
import { Share, View } from 'react-native'
import { router } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import QRCode from 'react-native-qrcode-svg'
import { usd } from '@/lib/format'
import { useSession } from '@/lib/session'
import { Button, Link, Panel, Row, Screen, Text } from '@/ui/kit'
import { color } from '@/ui/theme'

/**
 * Repay from anywhere: an exchange, another wallet, a family member. Whatever arrives at this line's own
 * repayment address is applied automatically (the borrowed amount first, then fees). Works with auto-pay off.
 */
export default function Repay() {
  const { me, cfg } = useSession()
  const [copied, setCopied] = useState(false)
  const line = me?.line
  const addr = line?.repayAccount
  if (!line || !cfg) return <Screen><Text>Loading…</Text></Screen>
  const owed = line.status === 'defaulted' ? BigInt(line.totalDue ?? '0') : BigInt(line.owed ?? '0') + BigInt(line.feesDue ?? '0')

  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} />
      <Text v="h1" style={{ marginTop: 18 }}>Repay from any wallet</Text>
      <Text style={{ marginTop: 6 }}>
        Send {cfg.tokenSymbol} on Tempo from an exchange, another wallet or a family member. It’s applied to your card within seconds, even with auto-pay off.
      </Text>
      <Row style={{ marginTop: 14 }}>
        <Text v="small">You owe now</Text>
        <Text style={{ color: color.text, fontFamily: 'Geist_600SemiBold' }}>{usd(owed)}</Text>
      </Row>

      {addr ? (
        <Panel style={{ alignItems: 'center' }}>
          <Text v="eyebrow">Your repayment address</Text>
          <View style={{ padding: 14, backgroundColor: '#fff', borderRadius: 20, marginTop: 16 }}>
            <QRCode value={addr} size={196} backgroundColor="#fff" color="#0A0A0B" />
          </View>
          <Text v="mono" selectable style={{ marginTop: 16, textAlign: 'center', color: color.text }}>{addr}</Text>
          <Row style={{ marginTop: 14 }}>
            <Button title={copied ? 'Copied' : 'Copy address'} small kind="quiet" onPress={async () => {
              await Clipboard.setStringAsync(addr)
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }} />
            <Button title="Share" small kind="quiet" onPress={() => Share.share({ message: `Repay my KEYKARD: send ${cfg.tokenSymbol} on the Tempo network to ${addr}` })} />
          </Row>
        </Panel>
      ) : (
        <Panel><Text v="small">Your repayment address appears once your card is open.</Text></Panel>
      )}

      <Panel>
        <Text v="h3">How it’s applied</Text>
        {[
          'What you borrowed is paid first, then any late fees.',
          'Sent more than you owe? The rest goes to your KEYKARD wallet.',
          `Only send ${cfg.tokenSymbol} on the Tempo network. This address only forwards to KEYKARD.`,
        ].map((t, i) => (
          <Row key={i} style={{ alignItems: 'flex-start', marginTop: 10 }}>
            <Text style={{ color: color.accentHi, fontFamily: 'GeistMono_500Medium', width: 18 }}>{i + 1}</Text>
            <Text v="small" style={{ flex: 1, color: color.text }}>{t}</Text>
          </Row>
        ))}
      </Panel>
    </Screen>
  )
}
