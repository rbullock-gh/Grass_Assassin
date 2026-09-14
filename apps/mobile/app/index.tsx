import { useEffect } from 'react'
import { View, ActivityIndicator, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { useAuth } from '@/lib/auth'
import { useColors } from '@/lib/theme'

/**
 * Entry point.
 *
 * Routes to the surface that matches the account rather than presenting a
 * chooser: a worker opening the app wants the map, and asking them which app
 * they meant every launch is friction for no benefit.
 */
export default function Index() {
  const { user, loading } = useAuth()
  const c = useColors()

  useEffect(() => {
    if (loading) return
    if (!user) { router.replace('/(auth)/welcome'); return }
    if (user.roles.includes('WORKER') && user.workerProfile) { router.replace('/(worker)/map'); return }
    router.replace('/(customer)/home')
  }, [user, loading])

  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <ActivityIndicator color={c.brand} size="large" />
    </View>
  )
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center' } })
