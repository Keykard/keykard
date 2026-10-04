import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import { guardReader } from './halo'

/** Keep the NFC reader guarded while this screen is focused (see guardReader in halo.ts). */
export function useReaderGuard(enabled = true) {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return
      return guardReader()
    }, [enabled]),
  )
}
