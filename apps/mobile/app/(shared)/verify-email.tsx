import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'

/**
 * Entering the six-digit code from the signup email.
 *
 * Reached two ways: from the banner after signing up, and by being sent here
 * when posting or claiming is refused. The second is the common one, so the
 * screen says WHY it is being asked rather than just asking — arriving at a
 * code box with no explanation, having just tapped "Post a job", is how this
 * reads as a bug.
 *
 * `next` carries where the person was going, so finishing here puts them back
 * rather than at a dead end.
 */
export default function VerifyEmailScreen() {
  const c = useColors()
  const layout = useLayout()
  const { user, refresh } = useAuth()
  const params = useLocalSearchParams<{ next?: string; reason?: string }>()

  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    // The keyboard should already be up: there is one field and the person is
    // holding a phone with the code on the screen behind this one.
    const timer = setTimeout(() => inputRef.current?.focus(), 350)
    return () => clearTimeout(timer)
  }, [])

  const submit = useCallback(async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.verifyEmail(value)
      await refresh().catch(() => undefined)
      // Back where they were headed, or home if they came here on purpose.
      if (params.next) router.replace(params.next as never)
      else router.back()
    } catch (caught) {
      /*
       * Show the server's message verbatim. It counts down the remaining tries
       * and distinguishes expired from wrong, which is information the person
       * needs and which — unlike the password reset flow — costs nothing here,
       * because they are already signed in and verifying their own address.
       */
      setError(caught instanceof ApiError ? caught.message : 'Could not check that code.')
      setCode('')
    } finally {
      setBusy(false)
    }
  }, [params.next, refresh])

  const onChange = useCallback((text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6)
    setCode(digits)
    setError(null)
    // Submit on the sixth digit. Nobody types six digits and then hunts for a
    // button.
    if (digits.length === 6) void submit(digits)
  }, [submit])

  const resend = useCallback(async () => {
    setError(null)
    setResent(true)
    await api.resendVerification().catch(() => undefined)
  }, [])

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[
        styles.content,
        { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
      ]}>
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Check your email</Text>

        {params.reason ? (
          <View style={[styles.reason, { backgroundColor: c.infoSubtle }]}>
            <Text style={[textStyles.body, { color: c.infoInk }]}>
              {params.reason}
            </Text>
          </View>
        ) : null}

        <Text style={[textStyles.body, { color: c.textSecondary, marginTop: space[3] }]}>
          We sent a six-digit code to{' '}
          <Text style={{ fontWeight: '700', color: c.textPrimary }}>{user?.email}</Text>.
        </Text>

        <TextInput
          ref={inputRef}
          value={code}
          onChangeText={onChange}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={6}
          editable={!busy}
          accessibilityLabel="Six-digit verification code"
          style={[
            styles.code,
            { backgroundColor: c.surface, borderColor: error ? c.danger : c.border, color: c.textPrimary },
          ]}
        />

        {busy ? <ActivityIndicator color={c.brand} style={{ marginTop: space[3] }} /> : null}

        {error ? (
          <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
            <Text style={[textStyles.caption, { color: c.dangerInk }]}>{error}</Text>
          </View>
        ) : null}

        <Pressable onPress={() => void resend()} accessibilityRole="button" style={styles.link}>
          <Text style={{ color: c.brandInk, fontWeight: '600' }}>
            {resent ? 'Sent — check your inbox again' : 'Send me another code'}
          </Text>
        </Pressable>

        <Text style={[textStyles.caption, { color: c.textTertiary, textAlign: 'center' }]}>
          Nothing arrives? Check the spam folder. The code expires in 30 minutes.
        </Text>

        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.link}>
          <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Not now</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { flex: 1, padding: space[5] },
  reason: { marginTop: space[4], padding: space[3], borderRadius: radius.md },
  code: {
    marginTop: space[5], borderWidth: 2, borderRadius: radius.md,
    minHeight: minTouchTarget + 14, textAlign: 'center',
    // Wide tracking so six digits read as six digits rather than a number.
    fontSize: 30, fontWeight: '700', letterSpacing: 10,
  },
  notice: { marginTop: space[3], padding: space[3], borderRadius: radius.md },
  link: {
    marginTop: space[3], alignItems: 'center',
    minHeight: minTouchTarget, justifyContent: 'center',
  },
})
