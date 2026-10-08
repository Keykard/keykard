import { Alert, View } from 'react-native'
import { resetTo } from '@/lib/nav'
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import Constants from 'expo-constants'
import { API_URL } from '@/lib/api'
import { short } from '@/lib/format'
import { useSession } from '@/lib/session'
import { signOut, signerKind, startOver } from '@/lib/wallet'
import { Button, Link, ListRow, Panel, Row, Screen, Text } from '@/ui/kit'
import { RolePill, displayName } from '@/ui/Account'
import { SecureNudge, SecurityPanel } from '@/ui/Security'
import { CreditFileShare } from '@/ui/CreditFileShare'
import { color } from '@/ui/theme'

export default function Settings() {
  const { me, cfg, refresh } = useSession()
  const kind = signerKind()
  const web = cfg?.publicWebOrigin ?? 'https://www.keykard.xyz'
  const out = async () => {
    await signOut()
    await refresh()
    resetTo('/welcome')
  }
  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => router.back()} />
      <Text v="h1" style={{ marginTop: 18 }}>Settings</Text>

      <Panel>
        <Row between>
          <Text v="h2">{displayName(me)}</Text>
          <RolePill role={me?.user?.role} />
        </Row>
        <Text v="mono" selectable style={{ marginTop: 6 }}>{me?.user?.wallet}</Text>
        <Text v="small" style={{ marginTop: 10 }}>
          This phone signs with: {kind === 'passkey' ? 'your passkey (fingerprint / screen lock)' : kind === 'password' ? 'your password' : '—'}
        </Text>
        <Text v="small">Identity: {me?.identity.verified ? '✓ Verified human (Self)' : 'Not verified yet'}</Text>
      </Panel>

      <SecureNudge username={me?.user?.username} sec={me?.security} onChange={() => void refresh()} />
      <SecurityPanel username={me?.user?.username} sec={me?.security} onChange={() => void refresh()} />
      {me?.user?.role === 'borrower' && me.user.username && (
        <CreditFileShare username={me.user.username} on={Boolean(me.user.public_profile)} web={web} onChange={() => void refresh()} />
      )}

      <Panel>
        <ListRow icon="◆" title="KEYKARD, live" sub="Network-wide numbers, every event on-chain" onPress={() => WebBrowser.openBrowserAsync(`${web}/stats`)} />
        {me?.line?.creditAccount && cfg && (
          <ListRow icon="◈" title="Your card on the explorer" sub={short(me.line.creditAccount)} onPress={() => WebBrowser.openBrowserAsync(`${cfg.explorerUrl}/address/${me.line!.creditAccount}`)} />
        )}
        <ListRow icon="↗" title="KEYKARD website" sub={web.replace('https://', '')} onPress={() => WebBrowser.openBrowserAsync(web)} />
      </Panel>

      <Button testID="settings-signout" title="Sign out" kind="ghost" style={{ marginTop: 18 }} onPress={out} />
      <Button
        title="Forget this phone"
        kind="danger"
        style={{ marginTop: 10 }}
        onPress={() =>
          Alert.alert(
            'Forget KEYKARD on this phone?',
            'This signs you out and removes the saved wallet from this phone. Your account and card are not deleted: sign in again with your passkey or password.',
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Forget', style: 'destructive', onPress: async () => { await startOver(); await refresh(); resetTo('/welcome') } }],
          )
        }
      />
      <View style={{ alignItems: 'center', marginTop: 26 }}>
        <Text v="small" style={{ color: color.text3 }}>KEYKARD {Constants.expoConfig?.version} · Tempo {cfg?.network ?? '—'}</Text>
        <Text v="small" style={{ color: color.text3 }}>{API_URL.replace(/^https?:\/\//, '')}</Text>
      </View>
    </Screen>
  )
}
