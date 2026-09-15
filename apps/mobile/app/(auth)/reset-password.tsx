import { useState } from 'react'
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '@grassassassin/client'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { Input } from '@/components/input'
import { MIN_PASSWORD_LENGTH, describePasswordProblem } from '@/lib/password'

/**
 * Choosing a new password from a reset link.
 *
 * Reached two ways, and both have to work:
 *
 *  1. The link in the email, which carries the token in the URL. That is the
 *     path almost everybody takes.
 *  2. By hand, with the token pasted. Because people open mail on a laptop and
 *     then pick up their phone, and a flow that only works if you tap the link
 *     on the right device strands exactly the people who are already locked out.
 *
 * On success this does NOT sign the person in. The reset revoked every session
 * — including whoever else was in the account, which is usually the reason for
 * doing this — and quietly issuing a fresh one here would skip the only moment
 * where the person proves they know the password they just chose.
 */
export default function ResetPasswordScreen() {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ token?: string }>()

  const [token, setToken] = useState(params.token ?? '')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = describePasswordProblem(password)
  const mismatch = confirmation.length > 0 && confirmation !== password
  const ready = token.trim().length > 0 && problem === null && !mismatch
    && confirmation.length > 0 && !busy

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.resetPassword(token.trim(), password)
      showAlert(
        'Password changed',
        'You have been signed out everywhere. Sign in with your new password.',
        [{ text: 'Sign in', onPress: () => router.replace('/(auth)/sign-in') }],
      )
    } catch (caught) {
      /*
       * The server gives one message for every kind of bad link — unknown,
       * expired, already used — on purpose, so that a stolen token cannot be
       * used to learn which guesses were once real. Show it as given rather
       * than guessing at a more specific one.
       */
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach GrassAssassin. Check your connection and try again.',
      )
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
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Choose a new password</Text>

        <View style={{ gap: space[3], marginTop: space[5] }}>
          {/* Shown, not hidden, even when it arrived in the URL: somebody who
              needs to retype or re-paste it should be able to see what is
              there. It is single-use and about to be spent anyway. */}
          <Input
            label="Reset code" value={token} onChangeText={setToken}
            autoCapitalize="none"
            placeholder="From the link in your email"
          />
          <Input
            label="New password" value={password} onChangeText={setPassword}
            secureTextEntry autoComplete="new-password"
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />
          <Input
            label="New password again" value={confirmation} onChangeText={setConfirmation}
            secureTextEntry autoComplete="new-password"
            placeholder="Type it once more"
          />
        </View>

        {password.length > 0 && problem ? (
          <Text style={[styles.hint, { color: c.textTertiary }]}>{problem}</Text>
        ) : null}
        {mismatch ? (
          <Text style={[styles.error, { color: c.dangerInk }]}>
            Those two do not match.
          </Text>
        ) : null}
        {error ? (
          <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
            <Text style={[textStyles.caption, { color: c.dangerInk }]}>{error}</Text>
          </View>
        ) : null}

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
              SET MY PASSWORD
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => router.replace('/(auth)/forgot-password')}
          accessibilityRole="button"
          style={styles.link}
        >
          <Text style={{ color: c.brandInk, fontWeight: '600' }}>Send me a new link</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[5], paddingBottom: space[10] },
  hint: { marginTop: space[2], fontSize: 13 },
  error: { marginTop: space[2], fontSize: 14, fontWeight: '600' },
  notice: { marginTop: space[3], padding: space[3], borderRadius: radius.md },
  primary: {
    marginTop: space[5], minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  link: {
    marginTop: space[4], alignItems: 'center',
    minHeight: minTouchTarget, justifyContent: 'center',
  },
})
