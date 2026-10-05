import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Modal, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { getToken } from '@/lib/api'
import { confirmWithPasskey, PasskeyCancelled } from '@/lib/passkey'
import { resetTo } from '@/lib/nav'
import { useSession } from '@/lib/session'
import { rpId, signOut, storedCredential } from '@/lib/wallet'
import { Banner, Button, Text } from './kit'
import { KeyMark } from './KeykardCard'
import { color } from './theme'

/** Back after this long in the background (or a fresh start): ask for the fingerprint before showing the account. */
const LOCK_AFTER_MS = 5 * 60_000

/**
 * App lock for phones with a KEYKARD passkey: a local fingerprint / face check (nothing is sent anywhere). Phones
 * that only have a password aren't locked here: every payment already asks for the password once per session.
 */
export function AppLock() {
  const { signedIn } = useSession()
  const [locked, setLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const away = useRef<number | null>(null)
  const started = useRef(false)

  const shouldLock = () => Boolean(getToken() && storedCredential()?.wallet)

  // fresh start with a saved session
  useEffect(() => {
    if (started.current || !signedIn) return
    started.current = true
    if (shouldLock()) setLocked(true)
  }, [signedIn])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') away.current = Date.now()
      if (s === 'active' && away.current && Date.now() - away.current >= LOCK_AFTER_MS && shouldLock()) setLocked(true)
      if (s === 'active') away.current = null
    })
    return () => sub.remove()
  }, [])

  const unlock = useCallback(async () => {
    const cred = storedCredential()
    if (!cred) return setLocked(false)
    setErr(null)
    setBusy(true)
    try {
      await confirmWithPasskey(await rpId(), [cred.id])
      setLocked(false)
    } catch (e: any) {
      if (!(e instanceof PasskeyCancelled)) setErr(e.message)
    } finally {
      setBusy(false)
    }
  }, [])

  // ask straight away when the lock appears
  useEffect(() => {
    if (locked) void unlock()
  }, [locked, unlock])

  return (
    <Modal visible={locked} animationType="fade" onRequestClose={() => {}}>
      <SafeAreaView style={{ flex: 1, backgroundColor: color.bg, padding: 24, justifyContent: 'space-between' }}>
        <View />
        <View style={{ alignItems: 'center' }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(139,124,255,0.12)', borderWidth: 1, borderColor: 'rgba(139,124,255,0.35)' }}>
            <KeyMark />
          </View>
          <Text v="h1" style={{ marginTop: 20 }}>KEYKARD is locked</Text>
          <Text style={{ marginTop: 8, textAlign: 'center' }}>Use your fingerprint or face to open your account.</Text>
          {err && <Banner kind="error">{err}</Banner>}
        </View>
        <View>
          <Button testID="applock-unlock" title={busy ? 'Waiting…' : 'Unlock'} busy={busy} onPress={unlock} />
          <Button
            testID="applock-signout"
            title="Sign out"
            kind="ghost"
            style={{ marginTop: 10 }}
            onPress={async () => {
              await signOut()
              setLocked(false)
              resetTo('/welcome')
            }}
          />
        </View>
      </SafeAreaView>
    </Modal>
  )
}
