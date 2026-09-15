import { useState } from 'react'
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { api } from '@/lib/api'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { Input } from '@/components/input'

/**
 * Asking for a reset link.
 *
 * The screen deliberately does NOT tell you whether the address has an account,
 * because the server deliberately does not either. A yard-work marketplace
 * knows where people live; a public form that confirms which addresses are
 * customers is a stalking tool.
 *
 * So the confirmation is written to be true either way — "if that address has
 * an account" — rather than the friendlier, leakier "check your inbox". The
 * friendlier wording is how this protection usually dies: not in the API, but
 * in a UI written by someone who did not know it was load-bearing.
 */
export default function ForgotPasswordScreen() {
  const c = useColors()
  const insets = useSafeAreaInsets()

  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.forgotPassword(email.trim())
      setSent(true)
    } catch {
      // Only a transport failure can land here — the server answers 202 for
      // every address it accepts. Anything else would be a network problem.
      setError('Could not reach GrassAssassin. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const ready = email.includes('@') && !busy

  if (sent) {
    return (
      <View
        style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + space[6] }]}
      >
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Check your email</Text>
        <Text style={[textStyles.body, { color: c.textSecondary, marginTop: space[3] }]}>
          If <Text style={{ fontWeight: '700' }}>{email.trim()}</Text> has a GrassAssassin
          account, a link to choose a new password is on its way. It works once, and stops
          working in an hour.
        </Text>
        <Text style={[textStyles.caption, { color: c.textTertiary, marginTop: space[4] }]}>
          Nothing arrived? Check the spam folder, then try again — it is also possible this
          address was never signed up.
        </Text>

        <Pressable
          onPress={() => router.replace('/(auth)/reset-password')}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: pressed ? c.brandHover : c.brand },
          ]}
        >
          <Text style={{ color: c.onBrand, fontWeight: '800', fontSize: 15 }}>
            I HAVE THE LINK
          </Text>
        </Pressable>

        <Pressable
          onPress={() => router.replace('/(auth)/sign-in')}
          accessibilityRole="button"
          style={styles.link}
        >
          <Text style={{ color: c.brandInk, fontWeight: '600' }}>Back to sign in</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + space[6] }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={[textStyles.title, { color: c.textPrimary }]}>Forgot your password</Text>
      <Text style={[textStyles.body, { color: c.textSecondary, marginTop: space[2] }]}>
        Tell us the address you signed up with and we will send a link to choose a new one.
      </Text>

      <View style={{ marginTop: space[5] }}>
        <Input
          label="Email" value={email} onChangeText={setEmail}
          keyboardType="email-address" autoCapitalize="none" autoComplete="email"
          placeholder="you@example.com"
        />
      </View>

      {error ? <Text style={[styles.error, { color: c.dangerInk }]}>{error}</Text> : null}

      <Pressable
        onPress={() => void submit()}
        disabled={!ready}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.primary,
          { backgroundColor: ready ? (pressed ? c.brandHover : c.brand) : c.surfaceSunken },
        ]}
      >
        {busy ? <ActivityIndicator color={c.onBrand} /> : (
          <Text style={{
            color: ready ? c.onBrand : c.textSecondary, fontWeight: '800', fontSize: 15,
          }}>
            SEND THE LINK
          </Text>
        )}
      </Pressable>

      <Pressable
        onPress={() => router.replace('/(auth)/sign-in')}
        accessibilityRole="button"
        style={styles.link}
      >
        <Text style={{ color: c.brandInk, fontWeight: '600' }}>Back to sign in</Text>
      </Pressable>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space[5] },
  error: { marginTop: space[3], fontSize: 14, fontWeight: '600' },
  primary: {
    marginTop: space[5], minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  link: {
    marginTop: space[4], alignItems: 'center',
    minHeight: minTouchTarget, justifyContent: 'center',
  },
})
