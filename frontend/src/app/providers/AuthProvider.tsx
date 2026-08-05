import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { environment } from '../config/environment'
import { GatewayRequestError } from '@/shared/lib/gatewayClient'
import { getCurrentUser, getGoogleClientId, signInWithGoogleCredential, signOutCurrentUser, type AuthUser } from './authApi'

export type { AuthUser } from './authApi'

interface AuthContextValue {
  user: AuthUser | null
  googleClientId: string
  isLoading: boolean
  accessDenied: boolean
  signInWithGoogle: (credential: string) => Promise<void>
  signOut: () => Promise<void>
  clearAccessDenied: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [accessDenied, setAccessDenied] = useState(false)
  const [googleClientId, setGoogleClientId] = useState(environment.googleClientId)

  useEffect(() => {
    let active = true
    void Promise.all([
      getCurrentUser().catch(() => null),
      getGoogleClientId().catch(() => environment.googleClientId),
    ])
      .then(([nextUser, configuredGoogleClientId]) => {
        if (!active) return
        setUser(nextUser)
        setGoogleClientId(configuredGoogleClientId || environment.googleClientId)
      })
      .finally(() => { if (active) setIsLoading(false) })
    return () => { active = false }
  }, [])

  const signInWithGoogle = useCallback(async (credential: string) => {
    setIsLoading(true)
    setAccessDenied(false)
    try {
      setUser(await signInWithGoogleCredential(credential))
    } catch (reason) {
      setUser(null)
      if (reason instanceof GatewayRequestError && reason.status === 403) setAccessDenied(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    try { await signOutCurrentUser() } finally {
      setUser(null)
      setAccessDenied(false)
    }
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    googleClientId,
    isLoading,
    accessDenied,
    signInWithGoogle,
    signOut,
    clearAccessDenied: () => setAccessDenied(false),
  }), [accessDenied, googleClientId, isLoading, signInWithGoogle, signOut, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
