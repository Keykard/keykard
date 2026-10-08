import { useState } from 'react'
import { Share, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import * as WebBrowser from 'expo-web-browser'
import { api } from '@/lib/api'
import { Banner, Button, Panel, Row, Text } from './kit'
import { Switch } from './Security'
import { color, font } from './theme'

/** Opt-in public credit file at <web>/u/<username>. Mirrors apps/web/components/CreditFileShare.tsx. */
export function CreditFileShare({ username, on, web, onChange }: { username: string; on: boolean; web: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const link = `${web}/u/${username}`
  const toggle = async () => {
    setErr(null)
    setBusy(true)
    try {
      await api('/api/me/profile', { body: { public: !on } })
      Haptics.selectionAsync().catch(() => {})
      onChange()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel>
      <Row between style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text v="h2">Your credit file</Text>
          <Text v="small" style={{ marginTop: 4 }}>
            {on
              ? 'Shared. Anyone with the link sees your on-time bills, missed bills and Self verification. Never your balance, spending or documents.'
              : 'Show a landlord, lender or employer that you pay on time. Every number is also recorded on Tempo.'}
          </Text>
        </View>
        <Switch testID="credit-file-share" on={on} disabled={busy} onPress={toggle} />
      </Row>
      {on && (
        <>
          <Text style={{ fontFamily: font.mono, color: color.text2, fontSize: 13, marginTop: 12 }} numberOfLines={1}>{link}</Text>
          <Row style={{ marginTop: 10 }}>
            <Button title="Share link" small style={{ flex: 1 }} onPress={() => Share.share({ message: `My KEYKARD credit file: ${link}` })} />
            <Button title="Preview" small kind="ghost" style={{ flex: 1 }} onPress={() => WebBrowser.openBrowserAsync(link)} />
          </Row>
        </>
      )}
      {err && <Banner kind="error">{err}</Banner>}
    </Panel>
  )
}
