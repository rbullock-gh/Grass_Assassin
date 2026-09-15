import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { router } from 'expo-router'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { checkNewPassword, MIN_PASSWORD_LENGTH } from '@/lib/password'

/**
 * Changing a password.
 *
 * The endpoint has existed since authentication was built and nothing called
 * it, so an account's password was set once at sign-up and never again.
 *
 * Changing it revokes every session on the server, deliberately — that is what
 * you want when you are changing it because somebody else might know it. This
 * screen therefore signs out locally and sends the person to sign in, rather
 * than leaving them holding a token the server has already thrown away and
 * discovering it at the next request.
 */
export default function ChangePasswordScreen() {
  const c = useColors()
  const layout = useLayout()
  const { signOut } = useAuth()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = checkNewPassword({ current, next, confirm })

  const submit = useCallback(async () => {
    if (!check.ok) return
    setSaving(true)
    setError(null)
    try {
      await api.changePassword(current, next)
      // The server has already revoked everything. Match it locally rather
      // than holding a token that is no longer worth anything.
      await signOut().catch(() => undefined)
      showAlert(
        'Password changed',
        'Every device is signed out, including this one. Sign in again with your new password.',
        [{ text: 'Sign in', onPress: () => router.replace('/(auth)/sign-in') }],
      )
    } catch (caught) {
      setError(
        caught instanceof Error && /incorrect/i.test(caught.message)
          ? 'That is not your current password.'
          : caught instanceof Error ? caught.message : 'That did not work. Try again.',
      )
    } finally {
      setSaving(false)
    }
  }, [check.ok, current, next, signOut])

  const field = (
    label: string,
    value: string,
    onChangeText: (t: string) => void,
    autoComplete: 'current-password' | 'new-password',
  ) => (
    <View style={{ gap: space[1] }}>
      <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={(text) => { onChangeText(text); setError(null) }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={autoComplete}
        textContentType={autoComplete === 'current-password' ? 'password' : 'newPassword'}
        accessibilityLabel={label}
        style={[
          styles.input,
          { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary },
        ]}
      />
    </View>
  )

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[textStyles.body, { color: c.textSecondary }]}>
          At least {MIN_PASSWORD_LENGTH} characters. Changing it signs out every device,
          which is the point if you think somebody else knows it.
        </Text>

        <View style={{ gap: space[4], marginTop: space[5] }}>
          {field('CURRENT PASSWORD', current, setCurrent, 'current-password')}
          {field('NEW PASSWORD', next, setNext, 'new-password')}
          {field('NEW PASSWORD AGAIN', confirm, setConfirm, 'new-password')}
        </View>

        {check.problem ? (
          <Text style={[textStyles.caption, { color: c.textTertiary, marginTop: space[3] }]}>
            {check.problem}
          </Text>
        ) : null}

        {error ? (
          <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
            <Text style={[textStyles.caption, { color: c.dangerInk }]}>{error}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={() => void submit()}
          disabled={saving || !check.ok}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.submit,
            {
              backgroundColor: check.ok ? (pressed ? c.brandHover : c.brand) : c.surfaceSunken,
            },
          ]}
        >
          {saving ? <ActivityIndicator color={c.onBrand} /> : (
            <Text style={{
              color: check.ok ? c.onBrand : c.textSecondary, fontWeight: '800', fontSize: 15,
            }}>
              CHANGE PASSWORD
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { padding: space[5], paddingBottom: space[10] },
  input: {
    borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3],
    minHeight: minTouchTarget, fontSize: 16,
  },
  notice: { marginTop: space[3], padding: space[3], borderRadius: radius.md },
  submit: {
    marginTop: space[6], minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
})
