import { useCallback, useEffect, useState } from 'react'
import { Share, View } from 'react-native'
import { router } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import QRCode from 'react-native-qrcode-svg'
import { api } from '@/lib/api'
import { usd } from '@/lib/format'
import { useSession } from '@/lib/session'
import { tokenBalance } from '@/lib/wallet'
import { Banner, Button, Link, Panel, Row, Screen, Text } from '@/ui/kit'
import { color } from '@/ui/theme'

export default function AddMoney() {
  const { me, cfg } = useSession()
  const wallet = me?.user?.wallet
  const [bal, setBal] = useState<bigint | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(() => {
    if (wallet) tokenBalance(wallet).then(setBal).catch(() => {})
  }, [wallet])
  useEffect(() => {
    load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [load])

  if (!wallet || !cfg) return <Screen><Text>Loading…</Text></Screen>
  const testnet = cfg.network === 'testnet'

  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} />
      <Text v="h1" style={{ marginTop: 18 }}>Add money</Text>
      <Text style={{ marginTop: 6 }}>Your KEYKARD wallet: your money, and where your bills are paid from. Balance: <Text style={{ color: color.text, fontFamily: 'Geist_600SemiBold' }}>{bal === null ? '—' : usd(bal)}</Text></Text>
      <Text v="small" style={{ marginTop: 6 }}>To pay your bill, send money here from an exchange, another wallet or a family member. Anything overdue is paid as soon as it arrives (auto-pay must be on).</Text>

      <Panel style={{ alignItems: 'center' }}>
        <Text v="eyebrow">Send {cfg.tokenSymbol} on Tempo</Text>
        <View style={{ padding: 14, backgroundColor: '#fff', borderRadius: 20, marginTop: 16 }}>
          <QRCode value={wallet} size={196} backgroundColor="#fff" color="#0A0A0B" />
        </View>
        <Text v="mono" selectable style={{ marginTop: 16, textAlign: 'center', color: color.text }}>{wallet}</Text>
        <Row style={{ marginTop: 14 }}>
          <Button title={copied ? 'Copied' : 'Copy address'} small kind="quiet" onPress={async () => {
            await Clipboard.setStringAsync(wallet)
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }} />
          <Button title="Share" small kind="quiet" onPress={() => Share.share({ message: wallet })} />
        </Row>
      </Panel>

      <Panel>
        <Text v="h3">How to send</Text>
        {[
          `In your exchange or wallet, choose Send / Withdraw → ${cfg.tokenSymbol}.`,
          'Select the Tempo network. Other networks won’t arrive.',
          'Paste this address and send. It shows up here in seconds.',
        ].map((t, i) => (
          <Row key={i} style={{ alignItems: 'flex-start', marginTop: 10 }}>
            <Text style={{ color: color.accentHi, fontFamily: 'GeistMono_500Medium', width: 18 }}>{i + 1}</Text>
            <Text v="small" style={{ flex: 1, color: color.text }}>{t}</Text>
          </Row>
        ))}
      </Panel>

      {testnet && (
        <>
          <Button testID="add-faucet" title={busy ? 'Requesting…' : 'Get test dollars (testnet)'} kind="ghost" busy={busy} style={{ marginTop: 16 }} onPress={async () => {
            setBusy(true)
            setMsg(null)
            try {
              await api('/api/faucet', { method: 'POST' })
              setMsg({ kind: 'ok', text: 'Test dollars sent. Your balance updates in a few seconds.' })
              setTimeout(load, 4000)
            } catch (e: any) {
              setMsg({ kind: 'error', text: e.message })
            } finally {
              setBusy(false)
            }
          }} />
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        </>
      )}
    </Screen>
  )
}
