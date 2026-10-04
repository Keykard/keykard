import { useEffect, useRef } from 'react'
import { ActivityIndicator, Modal, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import Animated, { Easing, FadeIn, ZoomIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import Svg, { Path } from 'react-native-svg'
import type { CardStep } from '@/lib/wallet'
import { Button, Link, Text } from './kit'
import { CheckIcon } from './Icons'
import { KeyMark } from './KeykardCard'
import { color, font } from './theme'

export type FlowState = CardStep | 'done' | 'error'
type Mode = 'charge' | 'link' | 'pay'

const STEPS: Record<Mode, { label: string; at: CardStep[] }[]> = {
  charge: [
    { label: 'Card tapped', at: ['reading'] },
    { label: 'Card checked', at: ['checking'] },
    { label: 'Signed by the card', at: ['signing'] },
    { label: 'Confirmed on Tempo', at: ['confirming'] },
  ],
  pay: [
    { label: 'Approved by you', at: ['signing'] },
    { label: 'Confirmed on Tempo', at: ['confirming'] },
    { label: 'Paid to the merchant', at: [] },
  ],
  link: [
    { label: 'Card tapped', at: ['signing'] },
    { label: 'Card proved it’s yours', at: ['linking'] },
    { label: 'Linked to your KEYKARD', at: [] },
  ],
}

function stepIndex(mode: Mode, s: FlowState) {
  if (s === 'done') return STEPS[mode].length
  if (s === 'hold' || s === 'error') return -1
  return STEPS[mode].findIndex((x) => x.at.includes(s as CardStep))
}

function XIcon() {
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24" fill="none">
      <Path d="M7 7l10 10M17 7L7 17" stroke={color.bad} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  )
}

/** A small card being tapped against the phone: pulsing rings while waiting, a steady glow while working. */
function TapVisual({ waiting }: { waiting: boolean }) {
  const p = useSharedValue(0)
  useEffect(() => {
    p.value = 0
    p.value = withRepeat(withTiming(1, { duration: waiting ? 1500 : 900, easing: Easing.out(Easing.quad) }), -1)
  }, [waiting, p])
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: 0.55 + p.value * 0.9 }], opacity: (1 - p.value) * (waiting ? 1 : 0.5) }))
  const ring2 = useAnimatedStyle(() => ({ transform: [{ scale: 0.55 + ((p.value + 0.5) % 1) * 0.9 }], opacity: (1 - ((p.value + 0.5) % 1)) * (waiting ? 0.7 : 0.3) }))
  return (
    <View style={{ width: 200, height: 200, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[st.ring, ring]} />
      <Animated.View style={[st.ring, ring2]} />
      <View style={st.mini}>
        <KeyMark size={22} stroke="#F5F5F7" />
        <View style={st.miniChip} />
      </View>
    </View>
  )
}

export function CardFlowSheet(p: {
  visible: boolean
  mode: Mode
  state: FlowState
  title: string
  error?: string | null
  done?: { headline: string; amount?: string; lines: string[]; receiptUrl?: string }
  onCancel: () => void
  onClose: () => void
  onRetry?: () => void
  onReceipt?: (url: string) => void
  approveHint?: string
}) {
  const steps = STEPS[p.mode]
  const idx = stepIndex(p.mode, p.state)
  const prev = useRef<FlowState | null>(null)

  // haptics mark the moments that matter: card can come off, success, failure
  useEffect(() => {
    if (prev.current === p.state) return
    prev.current = p.state
    if (p.state === 'reading' || (p.mode === 'link' && p.state === 'signing') || (p.mode === 'pay' && p.state === 'confirming')) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {})
    if (p.state === 'confirming' || p.state === 'linking') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    if (p.state === 'done') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
    if (p.state === 'error') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {})
  }, [p.state, p.mode])

  const working = idx >= 0 && idx < steps.length
  const cardFree = p.mode !== 'pay' && (p.state === 'confirming' || p.state === 'linking')
  const headline =
    p.mode === 'pay'
      ? p.state === 'signing' ? (p.approveHint ?? 'Approve the payment…') : p.state === 'confirming' ? 'Sending to Tempo…' : ''
      : p.state === 'hold' ? 'Hold the card flat against the back of the phone'
      : cardFree ? 'You can remove the card'
      : working ? 'Keep holding the card…'
      : ''
  const progress = p.state === 'done' ? 1 : Math.max(0, idx) / steps.length + (working ? 0.5 / steps.length : 0)

  return (
    <Modal visible={p.visible} animationType="slide" onRequestClose={p.state === 'done' || p.state === 'error' ? p.onClose : p.onCancel}>
      <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }}>
        <View style={st.bar}><View style={[st.barFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: p.state === 'error' ? color.bad : p.state === 'done' ? color.ok : color.accent }]} /></View>
        <View style={{ flex: 1, padding: 24 }}>
          <Text v="eyebrow">{p.mode === 'charge' ? 'Tap to charge' : p.mode === 'pay' ? 'Pay with KEYKARD' : 'Link a physical card'}</Text>
          <Text v="h1" style={{ marginTop: 8 }}>
            {p.state === 'done' ? (p.mode === 'link' ? 'Card linked' : 'Payment complete') : p.state === 'error' ? (p.mode === 'charge' ? 'Charge didn’t go through' : p.mode === 'pay' ? 'Payment didn’t go through' : 'Card not linked') : p.title}
          </Text>

          {p.state === 'done' && p.done ? (
            <Animated.View entering={FadeIn.duration(300)} style={{ flex: 1, justifyContent: 'center' }}>
              <View style={st.doneCard}>
                <Animated.View entering={ZoomIn.springify().damping(13)} style={st.doneIcon}><CheckIcon size={40} /></Animated.View>
                <Text v="eyebrow" style={{ color: color.ok, marginTop: 18 }}>{p.done.headline}</Text>
                {p.done.amount && <Text v="amount" style={{ marginTop: 6, fontSize: 52, lineHeight: 58 }}>{p.done.amount}</Text>}
                {p.done.lines.map((l) => (
                  <Text key={l} v="small" style={{ marginTop: 6, textAlign: 'center', color: color.text2 }}>{l}</Text>
                ))}
                {p.done.receiptUrl && <Link title="View receipt on Tempo ↗" style={{ marginTop: 16 }} onPress={() => p.onReceipt?.(p.done!.receiptUrl!)} />}
              </View>
              <Button testID="flow-done" title="Done" style={{ marginTop: 24 }} onPress={p.onClose} />
            </Animated.View>
          ) : p.state === 'error' ? (
            <Animated.View entering={FadeIn.duration(250)} style={{ flex: 1, justifyContent: 'center' }}>
              <View style={[st.doneCard, { borderColor: 'rgba(255,92,92,0.4)' }]}>
                <View style={[st.doneIcon, { backgroundColor: 'rgba(255,92,92,0.12)', borderColor: color.bad }]}><XIcon /></View>
                <Text v="h3" style={{ marginTop: 16, textAlign: 'center' }}>That didn’t go through</Text>
                <Text testID="flow-error" v="small" style={{ marginTop: 8, textAlign: 'center' }}>{p.error}</Text>
              </View>
              {p.onRetry && <Button title="Try again" style={{ marginTop: 24 }} onPress={p.onRetry} />}
              <Button title="Close" kind="ghost" style={{ marginTop: 10 }} onPress={p.onClose} />
            </Animated.View>
          ) : (
            <View style={{ flex: 1 }}>
              <View style={{ alignItems: 'center', marginTop: 24 }}>
                <TapVisual waiting={p.state === 'hold'} />
                <Text v="h2" style={{ textAlign: 'center', marginTop: 18, color: cardFree ? color.ok : color.text }}>{headline}</Text>
              </View>
              <View style={{ marginTop: 28, gap: 14 }}>
                {steps.map((s, i) => {
                  const done = i < idx
                  const active = i === idx
                  return (
                    <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <View style={[st.dot, done && { backgroundColor: color.ok, borderColor: color.ok }, active && { borderColor: color.accent }]}>
                        {done ? <CheckIcon size={14} stroke={color.bg} /> : active ? <ActivityIndicator size="small" color={color.accent} style={{ transform: [{ scale: 0.7 }] }} /> : null}
                      </View>
                      <Text style={{ fontFamily: font.medium, fontSize: 15, color: done ? color.text : active ? color.text : color.text3 }}>{s.label}</Text>
                    </View>
                  )
                })}
              </View>
              <View style={{ flex: 1 }} />
              {p.state === 'hold' && <Button testID="flow-cancel" title="Cancel" kind="ghost" onPress={p.onCancel} />}
              {working && !cardFree && p.mode !== 'pay' && <Text v="small" style={{ textAlign: 'center', color: color.text3 }}>Don’t move the card until the phone vibrates.</Text>}
            </View>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  )
}

const st = StyleSheet.create({
  bar: { height: 3, backgroundColor: 'rgba(255,255,255,0.06)' },
  barFill: { height: 3 },
  ring: { position: 'absolute', width: 200, height: 200, borderRadius: 100, borderWidth: 2, borderColor: color.accentHi },
  mini: { width: 132, height: 84, borderRadius: 14, backgroundColor: '#1b1538', borderWidth: 1, borderColor: color.accentHi, padding: 12, justifyContent: 'space-between' },
  miniChip: { width: 26, height: 20, borderRadius: 5, backgroundColor: '#B3A9FF', opacity: 0.85 },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  doneCard: { alignItems: 'center', padding: 28, borderRadius: 24, backgroundColor: color.surface1, borderWidth: 1, borderColor: 'rgba(61,220,151,0.3)' },
  doneIcon: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(61,220,151,0.12)', borderWidth: 2, borderColor: color.ok },
})
