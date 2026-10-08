import { useRef, useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import * as Haptics from 'expo-haptics'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { SafeAreaView } from 'react-native-safe-area-context'
import { amountFromQr, codeFromQr } from '@/lib/qr'
import { Button, Link, Text } from '@/ui/kit'
import { color } from '@/ui/theme'

export default function Scan() {
  const [perm, request] = useCameraPermissions()
  const [bad, setBad] = useState(false)
  const done = useRef(false)

  if (!perm) return <View style={{ flex: 1, backgroundColor: '#000' }} />
  if (!perm.granted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: color.bg, padding: 24, justifyContent: 'center' }}>
        <Text v="h1">Scan to pay</Text>
        <Text style={{ marginTop: 10 }}>KEYKARD needs the camera to read a merchant’s QR code. Nothing is recorded or stored.</Text>
        <Button title={perm.canAskAgain ? 'Allow camera' : 'Open settings'} style={{ marginTop: 24 }} onPress={() => (perm.canAskAgain ? request() : Linking.openSettings())} />
        <Button title="Type the code instead" kind="ghost" style={{ marginTop: 10 }} onPress={() => router.back()} />
      </SafeAreaView>
    )
  }
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return
          const code = codeFromQr(data)
          if (!code) {
            setBad(true)
            return
          }
          done.current = true
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
          const amount = amountFromQr(data)
          router.navigate({ pathname: '/pay', params: amount ? { code, amount } : { code } })
        }}
      />
      <SafeAreaView style={{ flex: 1, justifyContent: 'space-between', padding: 24 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text v="h2" style={{ color: '#fff' }}>Scan to pay</Text>
          <Link title="Close" style={{ color: '#fff' }} onPress={() => router.back()} />
        </View>
        <View style={{ alignSelf: 'center', width: 250, height: 250, borderRadius: 28, borderWidth: 3, borderColor: bad ? color.warn : color.accentHi }} />
        <Text style={{ color: '#fff', textAlign: 'center' }}>{bad ? 'That’s not a KEYKARD merchant code. Try another QR.' : 'Point at the merchant’s KEYKARD QR code'}</Text>
      </SafeAreaView>
    </View>
  )
}
