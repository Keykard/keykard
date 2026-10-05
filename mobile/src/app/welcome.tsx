import { router } from 'expo-router'
import { View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSession } from '@/lib/session'
import { Banner, Button, Link, Screen, Text } from '@/ui/kit'
import { KeykardCard, KeyMark } from '@/ui/KeykardCard'
import { color } from '@/ui/theme'

export default function Welcome() {
  const { cfg, cfgError, reloadConfig } = useSession()
  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <LinearGradient colors={['rgba(139,124,255,0.22)', 'rgba(10,10,11,0)']} start={{ x: 0.9, y: 0 }} end={{ x: 0.2, y: 0.6 }} style={{ position: 'absolute', inset: 0 } as any} />
      <Screen scroll={false} style={{ justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <KeyMark />
            <Text v="h3" style={{ letterSpacing: 3, fontSize: 13 }}>KEYKARD</Text>
          </View>
          {cfg && <Text v="mono" style={{ color: color.ok }}>● Tempo {cfg.network}</Text>}
        </View>

        <View>
          <View style={{ transform: [{ rotate: '-6deg' }], marginHorizontal: 8, marginBottom: 36 }}>
            <KeykardCard amount="$20.00" sub="Limit grows to $100" />
          </View>
          <Text v="eyebrow">Stablecoin credit · on Tempo</Text>
          <Text v="display" style={{ marginTop: 12 }}>Credit without{'\n'}the bank.</Text>
          <Text style={{ marginTop: 14 }}>
            A credit card for people no bank will score. No collateral needed. Free if you pay on time. Every rule enforced by the blockchain, not by us.
          </Text>
        </View>

        <View>
          {cfgError && (
            <Banner kind="error">
              <Text v="small" style={{ color: '#FFB3B3' }}>Can’t reach KEYKARD right now. <Link title="Retry" onPress={reloadConfig} /></Text>
            </Banner>
          )}
          <Button testID="welcome-get-card" title="Get your card" style={{ marginTop: 14 }} onPress={() => router.push('/onboard?role=borrower')} />
          <Button testID="welcome-merchant" title="I’m a merchant" kind="ghost" style={{ marginTop: 10 }} onPress={() => router.push('/onboard?role=merchant')} />
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 18 }}>
            <Text v="small">Already have an account?</Text>
            <Link testID="welcome-signin" title="Sign in" style={{ paddingVertical: 6 }} onPress={() => router.push('/signin')} />
          </View>
        </View>
      </Screen>
    </View>
  )
}
