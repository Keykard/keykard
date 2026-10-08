import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import type { Address } from 'viem'
import { api, getConfig, getToken, setSignedOutHandler, type AppConfig } from './api'

export type Role = 'borrower' | 'guarantor' | 'merchant'
export type Line = {
  id: number
  status: 'preparing' | 'active' | 'grace' | 'frozen' | 'defaulted' | 'settled' | 'closed'
  spendable: string
  limit: string
  owed: string
  amountDue: string
  creditAccount: Address
  mandateActive: boolean
  nextDue: string | null
  graceUntil: string | null
  freezeReason: string | null
  onTimeCount: number
  card: { address: string; limit: string; status: string } | null
  guarantorWallet: string | null
  guaranteed?: string
  repayKeyId?: Address
  feesDue?: string
  feesPaid?: string
  totalDue?: string
  repayAccount?: Address | null
  secured?: string
  unsecuredLimit?: string
  onTimeStreak?: number
  feeShields?: number
  userFrozen?: boolean
  securedEarn?: string
}
export type Me = {
  user: { wallet: Address; role: Role; username?: string | null; public_profile?: boolean } | null
  identity: { verified: boolean; attestationTx: string | null; selfStatus: string | null }
  line: Line | null
  collateral?: { vault: string; deposited: string; locked: string; available: string; max: string } | null
  earn?: import('@/ui/EarnCollateral').EarnPosition | null
  security?: import('./account').Security | null
  guaranteeing: any[]
}

type Ctx = {
  cfg: AppConfig | null
  cfgError: string | null
  me: Me | null
  loading: boolean
  signedIn: boolean
  refresh: () => Promise<Me | null>
  reloadConfig: () => void
}
const SessionCtx = createContext<Ctx>(null as any)
export const useSession = () => useContext(SessionCtx)

/** Who is signed in, their line, and the server config. Refreshes on focus and every 15s while the app is open. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [cfgError, setCfgError] = useState<string | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [signedIn, setSignedIn] = useState(Boolean(getToken()))
  const inflight = useRef<Promise<Me | null> | null>(null)

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null)
      setSignedIn(false)
      setLoading(false)
      return null
    }
    inflight.current ??= api<Me>('/api/me')
      .then((m) => {
        setMe(m)
        setSignedIn(true)
        return m
      })
      .catch((e) => {
        if (e?.status === 401) {
          setMe(null)
          setSignedIn(false)
        }
        return null
      })
      .finally(() => {
        inflight.current = null
        setLoading(false)
      })
    return inflight.current
  }, [])

  const reloadConfig = useCallback(() => {
    setCfgError(null)
    getConfig().then(setCfg).catch((e) => setCfgError(e.message))
  }, [])

  useEffect(() => {
    setSignedOutHandler(() => {
      setMe(null)
      setSignedIn(false)
    })
    reloadConfig()
    void refresh()
    const t = setInterval(() => AppState.currentState === 'active' && void refresh(), 15_000)
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void refresh())
    return () => {
      clearInterval(t)
      sub.remove()
    }
  }, [refresh, reloadConfig])

  const value = useMemo(() => ({ cfg, cfgError, me, loading, signedIn, refresh, reloadConfig }), [cfg, cfgError, me, loading, signedIn, refresh, reloadConfig])
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>
}

/** Where a signed-in account belongs. */
export function homeFor(me: Me | null): string {
  if (!me?.user) return '/welcome'
  if (!me.identity.verified) return `/onboard?role=${me.user.role}`
  if (me.user.role === 'merchant') return '/merchant'
  if (me.user.role === 'guarantor') return '/backing'
  if (!me.line || me.line.status === 'preparing') return '/onboard?role=borrower'
  return '/home'
}
