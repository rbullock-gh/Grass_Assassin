import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, onAuthExpired } from './api'
import type { MeResponse } from '@grassassassin/client'

/**
 * Session state.
 *
 * Kept deliberately small: the token store is the source of truth for
 * credentials, and this only caches the user profile so screens do not each
 * refetch it.
 */
interface AuthState {
  user: MeResponse | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (input: { email: string; password: string; firstName: string; intent: 'CUSTOMER' | 'WORKER' }) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me())
    } catch {
      // A failed /me on boot means no valid session — not an error worth
      // surfacing, since the signed-out state is a normal starting point.
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    onAuthExpired(() => setUser(null))
    void refresh()
  }, [refresh])

  const signIn = useCallback(async (email: string, password: string) => {
    await api.login({ email, password })
    await refresh()
  }, [refresh])

  const signUp = useCallback(async (input: {
    email: string; password: string; firstName: string; intent: 'CUSTOMER' | 'WORKER'
  }) => {
    await api.register(input)
    await refresh()
  }, [refresh])

  const signOut = useCallback(async () => {
    await api.logout()
    setUser(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, loading, signIn, signUp, signOut, refresh }),
    [user, loading, signIn, signUp, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
