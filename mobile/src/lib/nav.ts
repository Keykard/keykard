import { router } from 'expo-router'

/**
 * Start a fresh screen stack. Used whenever the signed-in account changes (sign in, sign out, switch, forget):
 * screens that belonged to the previous account must not survive underneath, or their background refreshes
 * try to "send you home" and rebuild the screen you're on.
 */
export function resetTo(href: string) {
  console.log('[nav] reset →', href)
  try {
    if (router.canDismiss()) router.dismissAll()
  } catch {}
  router.replace(href as any)
}
