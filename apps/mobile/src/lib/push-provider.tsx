import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { router } from 'expo-router'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { api } from './api'
import { useAuth } from './auth'
import { routeForNotification, timezoneOffsetMinutes, type Audience } from './push'

/**
 * The bridge between Expo's notification API and the app.
 *
 * All the decisions live in ./push, which is testable. What is left here is
 * effects: asking the OS, handing the token to the server, and taking somebody
 * to the right screen when they tap.
 *
 * Nothing here is allowed to throw. Push is a convenience on top of a
 * marketplace that works without it; a simulator with no push support, a user
 * who said no, or an Expo outage must leave the app entirely usable.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // Shown even when the app is open. The push that matters most — "someone
    // claimed your job" — arrives while a customer is staring at the screen
    // waiting for exactly that.
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

function audienceFor(roles: readonly string[] | undefined): Audience {
  return roles?.includes('WORKER') ? 'worker' : 'customer'
}

export function PushProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const registeredFor = useRef<string | null>(null)
  const registeredToken = useRef<string | null>(null)

  const audience = audienceFor(user?.roles)

  /** Asks the OS, then hands the token to the server. Safe to call repeatedly. */
  const register = useCallback(async (): Promise<void> => {
    // A simulator has no push token to give. Asking anyway throws, and on
    // Android an emulator without Play Services fails in a different way again.
    if (!Device.isDevice) return

    try {
      const existing = await Notifications.getPermissionsAsync()
      let granted = existing.granted
      if (!granted && existing.canAskAgain) {
        granted = (await Notifications.requestPermissionsAsync()).granted
      }
      if (!granted) return

      if (Platform.OS === 'android') {
        // Without a channel, Android 8+ silently drops every notification.
        await Notifications.setNotificationChannelAsync('default', {
          name: 'Job alerts',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#0F833B',
        })
      }

      // The project id is required by the new push service. Without it the
      // call throws at runtime on a real build, which is precisely where it is
      // hardest to notice.
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId

      const { data: pushToken } = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      )

      await api.registerDevice({
        pushToken,
        platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        appVersion: Constants.expoConfig?.version ?? undefined,
        tzOffsetMinutes: timezoneOffsetMinutes(),
      })

      registeredToken.current = pushToken
    } catch {
      // Denied, unsupported, offline, Expo down. None of those is a reason to
      // interrupt someone who opened the app to find work.
    }
  }, [])

  // Register once per signed-in person. Re-registering on every render would
  // write a devices row on every focus change for no benefit.
  useEffect(() => {
    if (!user) {
      registeredFor.current = null
      return
    }
    if (registeredFor.current === user.id) return
    registeredFor.current = user.id
    void register()
  }, [user, register])

  /*
   * Hand the token back when someone signs out.
   *
   * Skipping this is how the next person to sign in on the same phone keeps
   * receiving the previous person's job alerts — which name addresses. The
   * server also re-points a token on registration, but that only helps once the
   * next person signs in; between sign-out and sign-in the phone would keep
   * buzzing with somebody else's jobs.
   */
  const previousUserId = useRef<string | null>(null)
  useEffect(() => {
    const wasSignedIn = previousUserId.current
    previousUserId.current = user?.id ?? null
    if (wasSignedIn && !user && registeredToken.current) {
      const token = registeredToken.current
      registeredToken.current = null
      void api.deregisterDevice(token).catch(() => undefined)
    }
  }, [user])

  // Taps, both while running and from a cold start.
  useEffect(() => {
    const open = (data: unknown) => {
      const route = routeForNotification(data as Record<string, unknown>, audience)
      if (route) router.push(route as never)
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      open(response.notification.request.content.data)
    })

    // A tap that launched the app from cold does not fire the listener above.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response.notification.request.content.data)
    }).catch(() => undefined)

    return () => subscription.remove()
  }, [audience])

  return <>{children}</>
}
