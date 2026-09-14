import { useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { ApiError } from '@grassassassin/client'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { Input } from '@/components/input'

export default function SignInScreen() {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const { signIn } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
      router.replace('/')
    } catch (caught) {
      // Show the server's message. "Incorrect email or password" is deliberately
      // identical for both cases so accounts cannot be enumerated — repeating
      // it verbatim keeps that property intact.
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  const ready = email.includes('@') && password.length > 0

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + space[6] }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={[textStyles.title, { color: c.textPrimary }]}>Welcome back</Text>

      <View style={{ gap: space[3], marginTop: space[5] }}>
        <Input
          label="Email" value={email} onChangeText={setEmail}
          keyboardType="email-address" autoCapitalize="none" autoComplete="email"
          placeholder="you@example.com"
        />
        <Input
          label="Password" value={password} onChangeText={setPassword}
          secureTextEntry autoComplete="current-password" placeholder="Your password"
        />
      </View>

      {error ? <Text style={[styles.error, { color: c.danger }]}>{error}</Text> : null}

      <Pressable
        onPress={() => void submit()}
        disabled={!ready || busy}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.primary,
          { backgroundColor: ready ? (pressed ? c.brandHover : c.brand) : c.surfaceSunken },
        ]}
      >
        {busy ? <ActivityIndicator color={c.onBrand} /> : (
          <Text style={{ color: ready ? c.onBrand : c.textTertiary, fontWeight: '800', fontSize: 15 }}>
            SIGN IN
          </Text>
        )}
      </Pressable>

      <Pressable onPress={() => router.replace('/(auth)/sign-up')} style={styles.link}>
        <Text style={{ color: c.brand, fontWeight: '600' }}>Create an account instead</Text>
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
  link: { marginTop: space[4], alignItems: 'center', minHeight: minTouchTarget, justifyContent: 'center' },
})
