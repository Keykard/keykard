import { useCallback, useRef } from 'react'
import { router, useFocusEffect, usePathname, type Href } from 'expo-router'

/**
 * A redirect that fires at most once per screen, only while that screen is focused, and never to the page you're
 * already on. (expo-router's <Redirect> re-fires on every re-render, so a background refresh could rebuild the
 * current screen.)
 */
export function Go({ href }: { href: Href }) {
  const pathname = usePathname()
  const fired = useRef(false)
  const target = typeof href === 'string' ? href.split('?')[0] : String((href as any).pathname ?? '')
  useFocusEffect(
    useCallback(() => {
      if (fired.current || target === pathname) return
      fired.current = true
      console.log('[nav] redirect', pathname, '→', target)
      router.replace(href)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target, pathname]),
  )
  return null
}
