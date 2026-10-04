import { useState } from 'react'
import { resetTo } from '@/lib/nav'
import { View } from 'react-native'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { deriveAuthProof, deviceVault, importVaultAndUnlock, unlockDeviceKey } from '@/lib/devicekey'
import { PasskeyCancelled, passkeysSupported } from '@/lib/passkey'
import { useSession } from '@/lib/session'
import { restorePasskey, signIn } from '@/lib/wallet'
import { Banner, Button, Field, Link, Panel, Row, Screen, Text } from '@/ui/kit'
import { color } from '@/ui/theme'

export default function SignIn() {
  const { refresh } = useSession()
  const vault = deviceVault()
  const [username, setUsername] = useState('')
  const [pw, setPw] = useState('')
  const [devicePw, setDevicePw] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = (label: string, fn: () => Promise<void>) => async () => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      await refresh()
      resetTo('/')
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled)) setErr(e.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const withPasskey = run('passkey', async () => {
    const cred = await restorePasskey()
    const r = await api<{ wallet: Address }>(`/api/passkeys/${encodeURIComponent(cred.id)}`, { auth: false })
    await signIn({ kind: 'passkey', cred }, r.wallet)
  })

  const withPassword = run('password', async () => {
    const u = username.trim().toLowerCase()
    const authProof = await deriveAuthProof(u, pw)
    const r = await api<{ wallet: Address; vault: any }>('/api/auth/password', { auth: false, body: { username: u, authProof } })
    const k = await importVaultAndUnlock(r.vault, pw)
    if (k.address.toLowerCase() !== r.wallet.toLowerCase()) throw new Error('This wallet doesn’t match the account. Contact KEYKARD.')
    await signIn({ kind: 'password', address: k.address, pk: k.pk }, k.address)
  })

  const withDevice = run('device', async () => {
    const k = await unlockDeviceKey(devicePw)
    await signIn({ kind: 'password', address: k.address, pk: k.pk }, k.address)
  })

  return (
    <Screen>
      <Link title="‹ Back" style={{ marginTop: 6 }} onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))} />
      <Text v="h1" style={{ marginTop: 18 }}>Sign in</Text>
      <Text style={{ marginTop: 6 }}>Cardholders, merchants and family backups all sign in here.</Text>
      {err && <Banner kind="error">{err}</Banner>}

      {vault && (
        <Panel>
          <Text v="eyebrow">This phone</Text>
          <Text v="h3" style={{ marginTop: 8 }}>Unlock the wallet saved here</Text>
          <Text v="mono" style={{ marginTop: 4 }}>{vault.address.slice(0, 8)}…{vault.address.slice(-6)}</Text>
          <Field testID="signin-device-password" secureTextEntry autoCapitalize="none" placeholder="Password" value={devicePw} onChangeText={setDevicePw} onSubmitEditing={() => devicePw && withDevice()} />
          <Button testID="signin-device" title="Unlock & sign in" busy={busy === 'device'} disabled={!devicePw || !!busy} style={{ marginTop: 14 }} onPress={withDevice} />
        </Panel>
      )}

      {passkeysSupported() && (
        <Panel>
          <Text v="h3">Passkey</Text>
          <Text v="small" style={{ marginTop: 4 }}>Use the fingerprint or screen lock you created your account with, including passkeys from the KEYKARD website.</Text>
          <Button testID="signin-passkey" title="Sign in with passkey" busy={busy === 'passkey'} disabled={!!busy} style={{ marginTop: 14 }} onPress={withPasskey} />
        </Panel>
      )}

      <Panel>
        <Text v="h3">Password</Text>
        <Text v="small" style={{ marginTop: 4 }}>Works on any phone. Your wallet is stored encrypted; KEYKARD can’t open it.</Text>
        <Field testID="signin-username" label="Username" autoCapitalize="none" autoCorrect={false} autoComplete="username" value={username} onChangeText={(t) => setUsername(t.replace(/\s/g, ''))} />
        <Field testID="signin-password" label="Password" secureTextEntry autoCapitalize="none" autoComplete="current-password" value={pw} onChangeText={setPw} onSubmitEditing={() => username && pw && withPassword()} />
        <Button testID="signin-password-go" title={busy === 'password' ? 'Signing in…' : 'Sign in'} busy={busy === 'password'} disabled={!username || !pw || !!busy} style={{ marginTop: 16 }} onPress={withPassword} />
      </Panel>

      <View style={{ alignItems: 'center', marginTop: 20 }}>
        <Row>
          <Text v="small">New here?</Text>
          <Link title="Get your card" onPress={() => router.replace('/onboard?role=borrower')} />
          <Text v="small" style={{ color: color.text3 }}>·</Text>
          <Link title="Merchant" onPress={() => router.replace('/onboard?role=merchant')} />
        </Row>
      </View>
    </Screen>
  )
}
