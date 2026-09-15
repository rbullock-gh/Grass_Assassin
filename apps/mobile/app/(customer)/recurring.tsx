import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl,
} from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { RecurringSubscription } from '@grassassassin/client'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import {
  INTERVALS, PAUSE_OPTIONS, intervalLabel, scheduleState, nextRunSentence, pauseUntil,
  cancelConsequence,
} from '@/lib/recurring'

/**
 * Standing arrangements, and how to stop them.
 *
 * The job screen has offered "set up regular service" since it was built, and
 * this screen did not exist — so a customer could start a weekly service that
 * posts and charges for a job forever, and had no way to see it, pause it,
 * change it or cancel it. The API supported all four the whole time.
 *
 * Cancel is a plain button on the card rather than something behind an edit
 * mode. A recurring charge that is hard to stop is the fastest way to lose
 * somebody permanently and earn a chargeback on the way out.
 */
export default function RecurringScreen() {
  const c = useColors()
  const layout = useLayout()

  const [subscriptions, setSubscriptions] = useState<RecurringSubscription[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.recurringJobs()
      setSubscriptions(result.subscriptions)
      setError(null)
    } catch {
      setError('Could not load your regular services.')
    }
  }, [])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const update = useCallback(async (
    id: string,
    input: Parameters<typeof api.updateRecurringJob>[1],
  ) => {
    setBusy(id)
    try {
      await api.updateRecurringJob(id, input)
      await load()
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.')
    } finally {
      setBusy(null)
    }
  }, [load])

  const confirmCancel = useCallback((subscription: RecurringSubscription) => {
    showAlert(
      `Stop ${subscription.category.name.toLowerCase()} at ${subscription.property.label}?`,
      cancelConsequence(subscription),
      [
        { text: 'Keep it going', style: 'cancel' },
        {
          text: 'Stop it',
          style: 'destructive',
          onPress: () => { void update(subscription.id, { active: false }) },
        },
      ],
    )
  }, [update])

  const choosePause = useCallback((subscription: RecurringSubscription) => {
    showAlert(
      'Pause this service',
      'Nothing gets booked while it is paused. It picks up on its own afterwards.',
      [
        { text: 'Never mind', style: 'cancel' },
        ...PAUSE_OPTIONS.map((option) => ({
          text: option.label,
          onPress: () => { void update(subscription.id, { pauseUntil: pauseUntil(option.days) }) },
        })),
      ],
    )
  }, [update])

  const changeInterval = useCallback((subscription: RecurringSubscription) => {
    showAlert(
      'How often?',
      `Currently ${intervalLabel(subscription.interval).toLowerCase()}.`,
      [
        { text: 'Never mind', style: 'cancel' },
        ...INTERVALS.filter((option) => option.key !== subscription.interval).map((option) => ({
          text: option.label,
          onPress: () => { void update(subscription.id, { interval: option.key }) },
        })),
      ],
    )
  }, [update])

  if (subscriptions === null) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.brand} />
      </View>
    )
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.brand} />}
    >
      {error ? (
        <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
          <Text style={[textStyles.caption, { color: c.dangerInk }]}>{error}</Text>
        </View>
      ) : null}

      {subscriptions.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.subheading, { color: c.textPrimary }]}>
            No regular services
          </Text>
          <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>
            After a job is done you can set it to repeat, and it will post itself on a
            schedule. Anything you set up shows here, and you can stop it from here.
          </Text>
        </View>
      ) : (
        subscriptions.map((subscription) => {
          const state = scheduleState(subscription)
          const working = busy === subscription.id

          return (
            <View
              key={subscription.id}
              style={[
                styles.card,
                {
                  backgroundColor: c.surface,
                  borderColor: state === 'active' ? c.brand : c.border,
                  borderWidth: state === 'active' ? 2 : 1,
                  opacity: state === 'cancelled' ? 0.65 : 1,
                },
              ]}
            >
              <View style={styles.cardHead}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
                    {subscription.category.name}
                  </Text>
                  <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                    {subscription.property.label} · {subscription.property.city}
                  </Text>
                </View>
                <View
                  style={[
                    styles.pill,
                    {
                      backgroundColor: state === 'active' ? c.brandSubtle
                        : state === 'paused' ? c.warningSubtle : c.surfaceSunken,
                    },
                  ]}
                >
                  <Text style={{
                    fontSize: 11.5,
                    fontWeight: '700',
                    color: state === 'active' ? c.brand
                      : state === 'paused' ? c.warningInk : c.textSecondary,
                  }}>
                    {state === 'active' ? intervalLabel(subscription.interval).toUpperCase()
                      : state === 'paused' ? 'PAUSED' : 'STOPPED'}
                  </Text>
                </View>
              </View>

              {/* The one line somebody actually came here to read. */}
              <Text style={[textStyles.body, { color: c.textPrimary }]}>
                {nextRunSentence(subscription)}
              </Text>

              {subscription._count.jobs > 0 ? (
                <Text style={[textStyles.caption, { color: c.textTertiary }]}>
                  {subscription._count.jobs} {subscription._count.jobs === 1 ? 'job' : 'jobs'} booked so far
                </Text>
              ) : null}

              {working ? (
                <ActivityIndicator color={c.brand} style={{ marginTop: space[2] }} />
              ) : state === 'cancelled' ? (
                <Pressable
                  onPress={() => void update(subscription.id, { active: true })}
                  accessibilityRole="button"
                  style={[styles.action, { borderColor: c.border }]}
                >
                  <Text style={{ color: c.brand, fontWeight: '700', fontSize: 13.5 }}>
                    Start it again
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.actions}>
                  {state === 'paused' ? (
                    <Pressable
                      onPress={() => void update(subscription.id, { pauseUntil: null })}
                      accessibilityRole="button"
                      accessibilityLabel="Resume this service"
                      style={[styles.action, { borderColor: c.border }]}
                    >
                      <Text style={{ color: c.brand, fontWeight: '700', fontSize: 13.5 }}>Resume</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => choosePause(subscription)}
                      accessibilityRole="button"
                      accessibilityLabel="Pause this service"
                      style={[styles.action, { borderColor: c.border }]}
                    >
                      <Text style={{ color: c.textSecondary, fontWeight: '700', fontSize: 13.5 }}>Pause</Text>
                    </Pressable>
                  )}

                  <Pressable
                    onPress={() => changeInterval(subscription)}
                    accessibilityRole="button"
                    accessibilityLabel="Change how often"
                    style={[styles.action, { borderColor: c.border }]}
                  >
                    <Text style={{ color: c.textSecondary, fontWeight: '700', fontSize: 13.5 }}>
                      How often
                    </Text>
                  </Pressable>

                  {/* Not behind an edit mode, not in a menu. */}
                  <Pressable
                    onPress={() => confirmCancel(subscription)}
                    accessibilityRole="button"
                    accessibilityLabel="Stop this service"
                    style={[styles.action, { borderColor: c.border }]}
                  >
                    <Text style={{ color: c.dangerInk, fontWeight: '700', fontSize: 13.5 }}>Stop</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )
        })
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space[5], paddingBottom: space[10], gap: space[3] },
  notice: { padding: space[3], borderRadius: radius.md },
  empty: {
    borderWidth: 1, borderRadius: radius.lg, padding: space[6],
    alignItems: 'center', gap: space[2],
  },
  card: { borderRadius: radius.lg, padding: space[4], gap: space[2] },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  pill: { borderRadius: radius.full, paddingHorizontal: space[3], paddingVertical: 4 },
  actions: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap', marginTop: space[1] },
  action: {
    borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space[4],
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
  },
})
