import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useColorScheme } from 'react-native'
import { AuthProvider } from '@/lib/auth'
import { PushProvider } from '@/lib/push-provider'
import { colorsFor } from '@/lib/theme'

export default function RootLayout() {
  const scheme = useColorScheme()
  const colors = colorsFor(scheme)

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          {/* Inside AuthProvider: which screen a tapped notification opens
              depends on whether the person holding the phone is the worker or
              the customer on that job. */}
          <PushProvider>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.textPrimary,
              headerTitleStyle: { fontWeight: '700' },
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />

            {/* Signed out. No header: a back arrow to nowhere is worse than none. */}
            <Stack.Screen name="(auth)/welcome" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)/sign-in" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)/sign-up" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)/forgot-password" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)/reset-password" options={{ headerShown: false }} />
            <Stack.Screen name="(shared)/verify-email" options={{ title: 'Verify your email' }} />

            <Stack.Screen name="(worker)/map" options={{ headerShown: false }} />
            <Stack.Screen name="(worker)/job/[id]" options={{ title: 'Job details' }} />
            <Stack.Screen name="(worker)/earnings" options={{ title: 'Earnings' }} />
            <Stack.Screen name="(worker)/payouts" options={{ title: 'Payouts' }} />
            <Stack.Screen name="(worker)/profile/[id]" options={{ title: 'Pro' }} />
            <Stack.Screen name="(worker)/leaderboard" options={{ title: 'Leaderboard' }} />
            {/* No header: setup is a one-way door into the app, and a back
                arrow out of it leads to a map with nothing on it. */}
            <Stack.Screen name="(worker)/setup" options={{ headerShown: false }} />

            <Stack.Screen name="(customer)/home" options={{ headerShown: false }} />
            <Stack.Screen name="(customer)/post" options={{ title: 'Post a job' }} />
            <Stack.Screen name="(customer)/payment-methods" options={{ title: 'How you pay' }} />
            {/* Where a standing arrangement can be stopped. Until this existed,
                it could be started and not stopped. */}
            <Stack.Screen name="(customer)/recurring" options={{ title: 'Regular services' }} />
            <Stack.Screen name="(customer)/jobs/[id]" options={{ title: 'Your job' }} />
            <Stack.Screen name="(customer)/properties/new" options={{ title: 'Add a property' }} />
            <Stack.Screen name="(customer)/report/[id]" options={{ title: 'Report a problem' }} />
            {/* About a PERSON, not a job — a different queue with different
                consequences, so a different screen. */}
            <Stack.Screen name="(shared)/report-person/[userId]" options={{ title: 'Report someone' }} />
            <Stack.Screen name="(shared)/settings" options={{ title: 'Settings' }} />
            <Stack.Screen name="(shared)/change-password" options={{ title: 'Change password' }} />
            {/* Apple 5.1.1(v) and Google Play both require this to be reachable
                in the app, not by writing to support. */}
            <Stack.Screen name="(shared)/delete-account" options={{ title: 'Delete account' }} />

            {/* One thread per job, reachable from either side. */}
            <Stack.Screen name="(shared)/messages/index" options={{ title: 'Messages' }} />
            <Stack.Screen name="(shared)/messages/[jobId]" options={{ title: 'Messages' }} />
          </Stack>
          </PushProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
