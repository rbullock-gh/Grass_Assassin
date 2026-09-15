import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import type { DeletionBlocker } from '@grassassassin/client'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'

/**
 * Deleting an account.
 *
 * Required by Apple (5.1.1(v)) and Google Play to be reachable IN the app, not
 * by writing to support — which is the rule's whole point, since "email us to
 * delete" is how an account becomes impossible to leave.
 *
 * It says what goes and what stays before asking for anything, because the
 * honest answer is not "everything". A job somebody else worked, and the money
 * that moved for it, are their record too and do not disappear because one side
 * left. Discovering that afterwards is worse than being told now.
 *
 * Blockers are loaded first and shown as a list. A person owed money, or
 * holding a job somebody is waiting on, is told before they type a password
 * rather than after.
 */
export default function DeleteAccountScreen() {
  const c = useColors()
  const layout = useLayout()
  const { signOut } = useAuth()

  const [blockers, setBlockers] = useState<DeletionBlocker[] | null>(null)
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setBlockers((await api.deletionBlockers()).blockers)
    } catch {
      setError('Could not check your account. Try again in a moment.')
    }
  }, [])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  const confirm = useCallback(() => {
    showAlert(
      'Delete your account?',
      'This cannot be undone. Your details are removed and you are signed out everywhere.',
      [
        { text: 'Keep my account', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setWorking(true)
            setError(null)
            void api.deleteAccount(password)
              .then(async () => {
                await signOut().catch(() => undefined)
                showAlert(
                  'Your account is deleted',
                  'Thanks for trying GrassAssassin. You are welcome back any time.',
                  [{ text: 'OK', onPress: () => router.replace('/(auth)/welcome') }],
                )
              })
              .catch((caught: unknown) => {
                setError(
                  caught instanceof Error && /password/i.test(caught.message)
                    ? 'That is not your password.'
                    : caught instanceof Error ? caught.message : 'That did not work.',
                )
                void load()
              })
              .finally(() => setWorking(false))
          },
        },
      ],
    )
  }, [password, signOut, load])

  const blocked = (blockers?.length ?? 0) > 0
  const ready = blockers !== null && !blocked && password.length > 0 && !working

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
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Delete your account</Text>

        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>WHAT GOES</Text>
          {[
            'Your name, email, phone and photo.',
            'Your saved properties and their addresses.',
            'Notifications to your phone, immediately.',
            'Every device you are signed in on.',
          ].map((line) => (
            <Text key={line} style={[textStyles.body, { color: c.textPrimary }]}>• {line}</Text>
          ))}
        </View>

        {/* Said plainly and before anything is asked for. Finding this out
            afterwards is how somebody feels lied to. */}
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>WHAT STAYS</Text>
          <Text style={[textStyles.body, { color: c.textSecondary }]}>
            Jobs you were part of, and the payment records for them, stay — they are the other
            person’s record too, and we are required to keep what money did. Your name is
            removed from all of it.
          </Text>
        </View>

        {blockers === null ? (
          <ActivityIndicator color={c.brand} style={{ marginTop: space[5] }} />
        ) : blocked ? (
          <View style={[styles.blockers, { backgroundColor: c.warningSubtle }]}>
            <Text style={[textStyles.captionStrong, { color: c.warningInk }]}>
              NOT YET — {blockers.length === 1 ? 'ONE THING FIRST' : `${blockers.length} THINGS FIRST`}
            </Text>
            {blockers.map((blocker) => (
              <Text key={blocker.code} style={[textStyles.body, { color: c.warningInk }]}>
                • {blocker.message}
              </Text>
            ))}
          </View>
        ) : (
          <View style={{ gap: space[1], marginTop: space[5] }}>
            <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>
              YOUR PASSWORD
            </Text>
            <TextInput
              value={password}
              onChangeText={(text) => { setPassword(text); setError(null) }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              accessibilityLabel="Your password"
              style={[
                styles.input,
                { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary },
              ]}
            />
            <Text style={[textStyles.caption, { color: c.textTertiary }]}>
              Asked for because an account should not be destroyable by whoever picks up
              your phone.
            </Text>
          </View>
        )}

        {error ? (
          <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
            <Text style={[textStyles.caption, { color: c.dangerInk }]}>{error}</Text>
          </View>
        ) : null}

        {!blocked && blockers !== null ? (
          <Pressable
            onPress={confirm}
            disabled={!ready}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.submit,
              {
                backgroundColor: ready ? (pressed ? c.dangerSubtle : c.surface) : c.surfaceSunken,
                borderColor: ready ? c.danger : c.border,
              },
            ]}
          >
            {working ? <ActivityIndicator color={c.dangerInk} /> : (
              <Text style={{
                color: ready ? c.dangerInk : c.textSecondary, fontWeight: '800', fontSize: 15,
              }}>
                DELETE MY ACCOUNT
              </Text>
            )}
          </Pressable>
        ) : null}

        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.cancel}>
          <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Keep my account</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { padding: space[5], paddingBottom: space[10] },
  card: {
    borderWidth: 1, borderRadius: radius.md, padding: space[4],
    gap: space[1], marginTop: space[4],
  },
  blockers: { borderRadius: radius.md, padding: space[4], gap: space[2], marginTop: space[5] },
  input: {
    borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3],
    minHeight: minTouchTarget, fontSize: 16,
  },
  notice: { marginTop: space[3], padding: space[3], borderRadius: radius.md },
  submit: {
    marginTop: space[6], minHeight: minTouchTarget + 6, borderRadius: radius.md,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  cancel: {
    marginTop: space[3], minHeight: minTouchTarget,
    alignItems: 'center', justifyContent: 'center',
  },
})
