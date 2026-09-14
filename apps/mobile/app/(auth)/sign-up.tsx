import { useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { ApiError } from '@grassassassin/client'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { Input } from '@/components/input'

/** Passwords must be at least this long — matched to the server's rule. */
const MIN_PASSWORD_LENGTH = 10

export default function SignUpScreen() {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const { signUp } = useAuth()

  const [intent, setIntent] = useState<'CUSTOMER' | 'WORKER'>('CUSTOMER')
  const [firstName, setFirstName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const ready = firstName.trim().length > 0 && email.includes('@') && password.length >= MIN_PASSWORD_LENGTH

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await signUp({ email: email.trim(), password, firstName: firstName.trim(), intent })
      router.replace('/')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create your account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space[6] }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Create your account</Text>

        <View style={[styles.segmented, { backgroundColor: c.surfaceSunken }]}>
          {(['CUSTOMER', 'WORKER'] as const).map((option) => {
            const selected = intent === option
            return (
              <Pressable
                key={option}
                onPress={() => setIntent(option)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[styles.segment, selected ? { backgroundColor: c.surface } : null]}
              >
                <Text style={{ color: selected ? c.textPrimary : c.textSecondary, fontWeight: '700', fontSize: 13.5 }}>
                  {option === 'CUSTOMER' ? 'I need yard work' : 'I want to earn'}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <View style={{ gap: space[3], marginTop: space[4] }}>
          <Input label="First name" value={firstName} onChangeText={setFirstName} autoComplete="name" placeholder="Casey" />
          <Input label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" placeholder="you@example.com" />
          <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} />
          {passwordTooShort ? (
            <Text style={[textStyles.caption, { color: c.textTertiary }]}>
              {MIN_PASSWORD_LENGTH - password.length} more character
              {MIN_PASSWORD_LENGTH - password.length === 1 ? '' : 's'} needed
            </Text>
          ) : null}
        </View>

        {intent === 'WORKER' ? (
          <Text style={[textStyles.caption, { color: c.textSecondary, marginTop: space[3] }]}>
            You'll verify your phone, set your service area and complete a
            background check before you can claim jobs.
          </Text>
        ) : null}

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
            <Text style={{ color: ready ? c.onBrand : c.textSecondary, fontWeight: '800', fontSize: 15 }}>
              CREATE ACCOUNT
            </Text>
          )}
        </Pressable>

        <Pressable onPress={() => router.replace('/(auth)/sign-in')} style={styles.link}>
          <Text style={{ color: c.brand, fontWeight: '600' }}>I already have an account</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[5], paddingBottom: space[8] },
  segmented: { flexDirection: 'row', padding: 3, borderRadius: radius.md, marginTop: space[4], gap: 3 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 40, borderRadius: radius.sm },
  error: { marginTop: space[3], fontSize: 14, fontWeight: '600' },
  primary: {
    marginTop: space[5], minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  link: { marginTop: space[4], alignItems: 'center', minHeight: minTouchTarget, justifyContent: 'center' },
})
