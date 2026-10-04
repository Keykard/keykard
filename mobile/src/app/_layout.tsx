import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Stack, usePathname } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as SystemUI from 'expo-system-ui'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useFonts, Geist_300Light, Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from '@expo-google-fonts/geist'
import { GeistMono_400Regular, GeistMono_500Medium } from '@expo-google-fonts/geist-mono'
import { load } from '@/lib/storage'
import { SessionProvider } from '@/lib/session'
import { PasswordPromptHost } from '@/ui/PasswordPrompt'
import { color } from '@/ui/theme'

SplashScreen.preventAutoHideAsync().catch(() => {})
SystemUI.setBackgroundColorAsync(color.bg).catch(() => {})

/** One log line per screen change (visible in `adb logcat`): proves navigation isn't looping. */
function NavLog() {
  const pathname = usePathname()
  useEffect(() => {
    console.log('[nav] screen', pathname)
  }, [pathname])
  return null
}

export default function Root() {
  const [fonts] = useFonts({ Geist_300Light, Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold, GeistMono_400Regular, GeistMono_500Medium })
  const [store, setStore] = useState(false)
  useEffect(() => {
    load().finally(() => setStore(true))
  }, [])
  const ready = fonts && store
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {})
  }, [ready])
  if (!ready) return <View style={{ flex: 1, backgroundColor: color.bg }} />
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: color.bg },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="pay" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
        </Stack>
        <PasswordPromptHost />
        <NavLog />
      </SessionProvider>
    </SafeAreaProvider>
  )
}
