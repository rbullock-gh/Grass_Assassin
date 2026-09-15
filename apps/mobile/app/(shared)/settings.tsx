import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, Switch, ActivityIndicator, } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import type { NotificationGroupState, BlockedPerson } from '@grassassassin/client'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'

/**
 * Settings.
 *
 * This screen did not exist, which meant three things shipped with no way to
 * reach them: you could not SIGN OUT of the app at all — the function was
 * written and called from nowhere — you could not mute a single notification
 * although the notifier checked your preferences on every send, and you could
 * not undo a block although the endpoint to do it was built and tested.
 *
 * Sign-out is last rather than first. It is the most destructive thing here and
 * the least frequently wanted, and a red button at the top of a settings screen
 * gets pressed by accident.
 */
export default function SettingsScreen() {
  const c = useColors()
  const layout = useLayout()
  const { user, signOut } = useAuth()

  const [groups, setGroups] = useState<NotificationGroupState[] | null>(null)
  const [blocks, setBlocks] = useState<BlockedPerson[] | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [preferences, blocked] = await Promise.all([
        api.notificationPreferences(),
        api.blocks(),
      ])
      setGroups(preferences.groups)
      setBlocks(blocked.blocks)
      setError(null)
    } catch {
      setError('Could not load your settings.')
    }
  }, [])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  /**
   * Optimistic, and put back on failure.
   *
   * A switch that waits for the network before moving feels broken, and a
   * switch that moves and silently did nothing is worse than either.
   */
  const toggle = useCallback(async (group: NotificationGroupState) => {
    const next = !group.enabled
    setGroups((current) => current?.map((g) => (g.key === group.key ? { ...g, enabled: next } : g)) ?? null)
    setSaving(group.key)
    try {
      await api.setNotificationPreferences({ [group.key]: next })
      setError(null)
    } catch {
      setGroups((current) => current?.map((g) => (g.key === group.key ? { ...g, enabled: !next } : g)) ?? null)
      setError('That did not save. Check your connection and try again.')
    } finally {
      setSaving(null)
    }
  }, [])

  const unblock = useCallback((person: BlockedPerson) => {
    showAlert(
      `Unblock ${person.blocked.firstName}?`,
      'You will start seeing each other’s jobs again, and either of you can message on a job you share.',
      [
        { text: 'Keep blocked', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: () => {
            setBlocks((current) => current?.filter((b) => b.id !== person.id) ?? null)
            void api.unblockUser(person.blocked.id).catch(() => {
              setBlocks((current) => (current ? [person, ...current] : [person]))
              setError('Could not unblock them. Try again.')
            })
          },
        },
      ],
    )
  }, [])

  const confirmSignOutEverywhere = useCallback(() => {
    showAlert(
      'Sign out everywhere?',
      'Every device signed in as you is signed out, including this one. Use this if a '
      + 'phone was lost or you signed in somewhere you should not have.',
      [
        { text: 'Never mind', style: 'cancel' },
        {
          text: 'Sign out everywhere',
          style: 'destructive',
          onPress: () => {
            void api.logoutEverywhere()
              .catch(() => undefined)
              // Local sign-out regardless: the server has revoked the tokens, so
              // staying "signed in" here would just fail at the next request.
              .then(() => signOut())
              .then(() => router.replace('/(auth)/welcome'))
          },
        },
      ],
    )
  }, [signOut])

  const confirmSignOut = useCallback(() => {
    showAlert(
      'Sign out?',
      'You will need your email and password to get back in. Notifications to this phone stop.',
      [
        { text: 'Stay signed in', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void signOut().then(() => router.replace('/(auth)/welcome'))
          },
        },
      ],
    )
  }, [signOut])

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
      ]}
    >
      {user ? (
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.captionStrong, { color: c.textTertiary }]}>SIGNED IN AS</Text>
          <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
            {user.firstName}
          </Text>
          <Text style={[textStyles.caption, { color: c.textSecondary }]}>{user.email}</Text>
        </View>
      ) : null}

      {error ? (
        <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
          <Text style={[textStyles.caption, { color: c.dangerInk }]}>{error}</Text>
        </View>
      ) : null}

      <Section title="NOTIFICATIONS">
        {groups === null ? (
          <ActivityIndicator color={c.brand} style={{ marginVertical: space[4] }} />
        ) : (
          groups.map((group) => (
            <Pressable
              key={group.key}
              onPress={() => void toggle(group)}
              accessibilityRole="switch"
              accessibilityState={{ checked: group.enabled, busy: saving === group.key }}
              accessibilityLabel={group.label}
              accessibilityHint={group.detail}
              style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{group.label}</Text>
                <Text style={[textStyles.caption, { color: c.textSecondary }]}>{group.detail}</Text>
                {/* Only when it is off, and only when losing it costs something.
                    A warning shown next to a switch that is already on is noise. */}
                {!group.enabled && group.cost ? (
                  <Text style={[textStyles.caption, { color: c.warningInk }]}>{group.cost}</Text>
                ) : null}
              </View>
              <Switch
                value={group.enabled}
                onValueChange={() => void toggle(group)}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                tabIndex={-1}
                trackColor={{ true: c.brand, false: c.borderStrong }}
              />
            </Pressable>
          ))
        )}
      </Section>

      <Section title="BLOCKED">
        {blocks === null ? (
          <ActivityIndicator color={c.brand} style={{ marginVertical: space[4] }} />
        ) : blocks.length === 0 ? (
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[textStyles.caption, { color: c.textSecondary }]}>
              Nobody. If you block someone, their jobs stop appearing for you and neither of
              you can message the other.
            </Text>
          </View>
        ) : (
          blocks.map((person) => (
            <View
              key={person.id}
              style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
                  {person.blocked.firstName}
                </Text>
                {person.reason ? (
                  <Text style={[textStyles.caption, { color: c.textTertiary }]}>{person.reason}</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => unblock(person)}
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${person.blocked.firstName}`}
                style={[styles.smallButton, { borderColor: c.border }]}
              >
                <Text style={{ color: c.textSecondary, fontWeight: '700', fontSize: 13 }}>
                  Unblock
                </Text>
              </Pressable>
            </View>
          ))
        )}
      </Section>

      <Section title="ACCOUNT">
        <Pressable
          onPress={() => router.push('/(shared)/change-password')}
          accessibilityRole="button"
          style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>Change password</Text>
            <Text style={[textStyles.caption, { color: c.textSecondary }]}>
              Signs out every device, including this one.
            </Text>
          </View>
        </Pressable>

        {/* For a phone left in a truck, or a shared computer. Distinct from
            signing out here, which only affects this device. */}
        <Pressable
          onPress={confirmSignOutEverywhere}
          accessibilityRole="button"
          style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>Sign out everywhere</Text>
            <Text style={[textStyles.caption, { color: c.textSecondary }]}>
              Ends every session on every device.
            </Text>
          </View>
        </Pressable>

        <Pressable
          onPress={confirmSignOut}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.signOut,
            { backgroundColor: pressed ? c.dangerSubtle : c.surface, borderColor: c.border },
          ]}
        >
          <Text style={{ color: c.dangerInk, fontWeight: '700', fontSize: 15 }}>Sign out</Text>
        </Pressable>
      </Section>
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const c = useColors()
  return (
    <View style={{ gap: space[2], marginTop: space[5] }}>
      <Text style={[textStyles.captionStrong, { color: c.textTertiary }]}>{title}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: space[5], paddingBottom: space[10] },
  card: { borderWidth: 1, borderRadius: radius.md, padding: space[4], gap: 3 },
  notice: { marginTop: space[4], padding: space[3], borderRadius: radius.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space[4],
    minHeight: minTouchTarget + 12,
  },
  smallButton: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: space[4],
    minHeight: minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signOut: {
    borderWidth: 1,
    borderRadius: radius.md,
    minHeight: minTouchTarget + 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
