import { useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { addPasskey, cancelRecovery, changePassword, passkeysSupported, removePasskey, resetPassword, setRecovery, type Security as Sec } from '@/lib/account'
import { KEYS, get, set } from '@/lib/storage'
import { PasskeyCancelled } from '@/lib/passkey'
import { passwordStrength } from '@/lib/devicekey'
import { getSigner, storedCredential } from '@/lib/wallet'
import { Banner, Button, Field, Panel, Row, Text } from './kit'
import { Strength } from './AuthFlow'
import { color, font } from './theme'

const friendly = (e: any): string | null => (e instanceof PasskeyCancelled || /cancelled/i.test(String(e?.message)) ? null : String(e?.message ?? e))
const when = (d: string) => new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

/** "Finish securing your account" (older accounts), and the alarm when a recovery is in progress (with Cancel). */
export function SecureNudge({ username, sec, onChange }: { username?: string | null; sec?: Sec | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [hideOffer, setHideOffer] = useState(get(KEYS.passkeyOfferDismissed) === '1')
  if (!sec || !username) return null
  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
      setPw('')
      onChange()
    } catch (e: any) {
      setErr(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  if (sec.openRecovery) {
    return (
      <Banner kind="error">
        <Text style={{ color: '#fff', fontFamily: font.semibold }}>Someone started recovering this account.</Text>
        <Text v="small" style={{ color: '#FFB3B3', marginTop: 4 }}>
          {sec.openRecovery.status === 'waiting' && sec.openRecovery.readyAt
            ? `If nothing is done, access moves to their new password at ${new Date(sec.openRecovery.readyAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`
            : 'They still have to verify with Self.'}{' '}
          If this wasn’t you, cancel it now.
        </Text>
        <Button testID="nudge-cancel-recovery" title={busy === 'cancel' ? 'Cancelling…' : 'It wasn’t me: cancel recovery'} busy={busy === 'cancel'} style={{ marginTop: 12 }} onPress={run('cancel', cancelRecovery)} />
        {err && <Text v="small" style={{ color: '#FFB3B3', marginTop: 8 }}>{err}</Text>}
      </Banner>
    )
  }
  if (!sec.hasPassword) {
    return (
      <Banner kind="info">
        <Text style={{ color: color.text, fontFamily: font.semibold }}>Set a password for your account</Text>
        <Text v="small" style={{ marginTop: 4 }}>You sign in with a passkey today. A password lets you sign in on any device, and either one can reset the other if you lose it.</Text>
        <Field testID="nudge-password" secureTextEntry autoCapitalize="none" autoComplete="new-password" placeholder="New password" value={pw} onChangeText={setPw} />
        <Strength pw={pw} />
        <Button testID="nudge-save-password" title={busy === 'pw' ? 'Confirm with your passkey…' : 'Save password'} busy={busy === 'pw'} disabled={passwordStrength(pw).score === 0} style={{ marginTop: 12 }} onPress={run('pw', () => resetPassword(username, pw))} />
        {err && <Text v="small" style={{ color: color.bad, marginTop: 8 }}>{err}</Text>}
      </Banner>
    )
  }
  if (!sec.recoveryOn && !sec.recoveryOptOut) {
    return (
      <Banner kind="info">
        <Text style={{ color: color.text, fontFamily: font.semibold }}>Turn on account recovery</Text>
        <Text v="small" style={{ marginTop: 4 }}>
          If you ever lose both your password and your passkey, verifying with Self again gets you back into this same account after a safety wait. KEYKARD can’t use it for anything else, and you can turn it off any time.
        </Text>
        <Button testID="nudge-recovery" title={busy === 'rec' ? 'Turning on…' : 'Turn on recovery'} busy={busy === 'rec'} style={{ marginTop: 12 }} onPress={run('rec', () => setRecovery(true))} />
        {err && <Text v="small" style={{ color: color.bad, marginTop: 8 }}>{err}</Text>}
      </Banner>
    )
  }
  if (passkeysSupported() && sec.passkeys.length === 0 && !hideOffer) {
    return (
      <Banner kind="info">
        <Text style={{ color: color.text, fontFamily: font.semibold }}>Sign in with one touch</Text>
        <Text v="small" style={{ marginTop: 4 }}>Add your fingerprint or face. It also lets you reset your password if you forget it.</Text>
        <Row style={{ marginTop: 12 }}>
          <Button testID="nudge-passkey" title={busy === 'pk' ? 'Follow the prompt…' : 'Add fingerprint'} busy={busy === 'pk'} small style={{ flex: 1 }} onPress={run('pk', () => addPasskey(username))} />
          <Button title="Not now" kind="ghost" small onPress={async () => (await set(KEYS.passkeyOfferDismissed, '1'), setHideOffer(true))} />
        </Row>
        {err && <Text v="small" style={{ color: color.bad, marginTop: 8 }}>{err}</Text>}
      </Banner>
    )
  }
  return null
}

export function Switch({ on, disabled, onPress, testID }: { on: boolean; disabled?: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="switch" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={onPress}
      style={{ width: 48, height: 28, borderRadius: 14, padding: 3, backgroundColor: on ? color.ok : 'rgba(255,255,255,0.16)', opacity: disabled ? 0.45 : 1 }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', transform: [{ translateX: on ? 20 : 0 }] }} />
    </Pressable>
  )
}

/** Settings → Sign-in & security. */
export function SecurityPanel({ username, sec, onChange }: { username?: string | null; sec?: Sec | null; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  if (!sec || !username) return null
  const mine = storedCredential()?.id
  const run = (label: string, fn: () => Promise<unknown>, done: string) => async () => {
    setErr(null)
    setMsg(null)
    setBusy(label)
    try {
      await fn()
      setMsg(done)
      setChanging(false)
      setCur('')
      setPw('')
      onChange()
    } catch (e: any) {
      setErr(friendly(e))
    } finally {
      setBusy(null)
    }
  }
  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: color.hairline }

  return (
    <Panel>
      <Text v="h3">Sign-in & security</Text>

      <View style={[row, { borderTopWidth: 0 }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: color.text, fontFamily: font.medium }}>Password</Text>
          <Text v="small">{sec.hasPassword ? 'Works on any device. Encrypts your wallet; KEYKARD never sees it.' : 'Not set yet.'}</Text>
        </View>
        {sec.hasPassword && !changing && <Button testID="sec-change-password" title="Change" kind="quiet" small onPress={() => setChanging(true)} />}
      </View>
      {changing && (
        <View style={{ paddingBottom: 14 }}>
          <Field testID="sec-current-password" label="Current password" secureTextEntry autoCapitalize="none" autoComplete="current-password" value={cur} onChangeText={setCur} />
          <Field testID="sec-new-password" label="New password" secureTextEntry autoCapitalize="none" autoComplete="new-password" value={pw} onChangeText={setPw} />
          <Strength pw={pw} />
          <Row style={{ marginTop: 12 }}>
            <Button title="Cancel" kind="ghost" small style={{ flex: 1 }} onPress={() => setChanging(false)} />
            <Button testID="sec-save-password" title={busy === 'pw' ? 'Saving…' : 'Save'} small busy={busy === 'pw'} disabled={!cur || passwordStrength(pw).score === 0} style={{ flex: 1 }} onPress={run('pw', () => changePassword(username, cur, pw), 'Password changed.')} />
          </Row>
        </View>
      )}

      <View style={row}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: color.text, fontFamily: font.medium }}>Passkeys</Text>
          <Text v="small">{sec.passkeys.length === 0 ? 'Fingerprint or face sign-in. Also resets your password if you forget it.' : `${sec.passkeys.length} on your account`}</Text>
        </View>
        {passkeysSupported() && (
          <Button testID="sec-add-passkey" title={busy === 'add' ? 'Follow the prompt…' : sec.passkeys.length ? 'Add' : 'Add'} kind="quiet" small busy={busy === 'add'} onPress={run('add', () => addPasskey(username), 'Passkey added.')} />
        )}
      </View>
      {sec.passkeys.map((p) => (
        <View key={p.id} style={[row, { paddingLeft: 12 }]}>
          <Text v="small" style={{ flex: 1 }}>{p.passkeyId === mine ? 'This phone' : 'Passkey'} · added {when(p.addedAt)}</Text>
          <Button
            title={busy === `rm${p.id}` ? 'Removing…' : 'Remove'}
            kind="danger"
            small
            busy={busy === `rm${p.id}`}
            disabled={!!busy || (!sec.hasPassword && sec.passkeys.length === 1)}
            onPress={() =>
              Alert.alert('Remove this passkey?', 'It stops working everywhere.', [
                { text: 'Keep it', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => void run(`rm${p.id}`, () => removePasskey(p.id), 'Passkey removed.')() },
              ])
            }
          />
        </View>
      ))}

      <View style={row}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: color.text, fontFamily: font.medium }}>Account recovery</Text>
          <Text v="small">
            {sec.recoveryOn
              ? 'On. Lost your password and passkey? Verify with Self again and you’re back in after a safety wait.'
              : 'Off. If you lose your password and every passkey, nobody can restore access, including KEYKARD.'}
          </Text>
        </View>
        <Switch
          testID="sec-recovery"
          on={sec.recoveryOn}
          disabled={!!busy}
          onPress={() => {
            const go = () => void run('rec', async () => setRecovery(!sec.recoveryOn, await getSigner()), sec.recoveryOn ? 'Account recovery is off.' : 'Account recovery is on.')()
            if (!sec.recoveryOn) return go()
            Alert.alert('Turn off account recovery?', 'If you lose your password and every passkey, your account can’t be restored.', [
              { text: 'Keep it on', style: 'cancel' },
              { text: 'Turn off', style: 'destructive', onPress: go },
            ])
          }}
        />
      </View>
      {err && <Banner kind="error">{err}</Banner>}
      {msg && <Banner kind="ok">{msg}</Banner>}
    </Panel>
  )
}
