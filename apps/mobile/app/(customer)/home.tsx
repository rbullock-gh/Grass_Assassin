import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import type { JobSummary } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { displayPrice, formatDeadline } from '@/lib/jobs'
import { customerStatus, isLiveForCustomer } from '@/lib/customer-jobs'

/**
 * The customer's home.
 *
 * Deliberately not a mirror of the worker map. A worker opens the app many
 * times a day to find work; a customer opens it a handful of times a season to
 * answer one question — "is my yard getting done?" — and then to post the next
 * job. So the screen answers that question first and puts posting one tap away,
 * rather than presenting a dashboard of things nobody asked about.
 */
export default function CustomerHomeScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()

  const [jobs, setJobs] = useState<JobSummary[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.myJobs('CUSTOMER')
      setJobs(result.jobs)
      setError(null)
    } catch {
      setError('Could not load your jobs. Pull to try again.')
    }
  }, [])

  // Reloads on focus rather than only on mount: coming back from posting a job
  // or approving one must not show stale state.
  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const live = jobs?.filter(isLiveForCustomer) ?? []
  const past = jobs?.filter((job) => !isLiveForCustomer(job)) ?? []

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + space[4],
          paddingBottom: insets.bottom + space[8],
          // Long lines are hard to read and a full-width card on a MacBook
          // looks like a stretched phone. The brief was explicit about this.
          maxWidth: layout.contentMaxWidth,
          alignSelf: 'center',
          width: '100%',
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.brand} />}
    >
      <Text style={[textStyles.title, { color: c.textPrimary }]}>
        {user?.firstName ? `Hi, ${user.firstName}` : 'Your yard'}
      </Text>

      <View style={styles.quickRow}>
        <Quick label="Messages" onPress={() => router.push('/(shared)/messages')} />
      </View>

      <Pressable
        onPress={() => router.push('/(customer)/post')}
        accessibilityRole="button"
        accessibilityLabel="Post a new job"
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: pressed ? c.brandHover : c.brand },
        ]}
      >
        <Text style={{ color: c.onBrand, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 }}>
          POST A JOB
        </Text>
      </Pressable>

      {error ? (
        <Text style={[textStyles.body, { color: c.danger, marginTop: space[4] }]}>{error}</Text>
      ) : null}

      {jobs === null ? (
        <ActivityIndicator color={c.brand} style={{ marginTop: space[7] }} />
      ) : (
        <>
          <Section title="Happening now" count={live.length}>
            {live.length === 0 ? (
              <Empty
                text="Nothing in progress. Post a job and pros nearby will see it within seconds."
              />
            ) : (
              live.map((job) => <JobCard key={job.id} job={job} />)
            )}
          </Section>

          {past.length > 0 ? (
            <Section title="Past jobs" count={past.length}>
              {past.slice(0, 20).map((job) => <JobCard key={job.id} job={job} />)}
            </Section>
          ) : null}
        </>
      )}
    </ScrollView>
  )
}

function Quick({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.quick,
        { borderColor: c.border, backgroundColor: pressed ? c.surfaceSunken : c.surface },
      ]}
    >
      <Text style={{ color: c.textPrimary, fontWeight: '700', fontSize: 13.5 }}>{label}</Text>
    </Pressable>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const c = useColors()
  return (
    <View style={{ marginTop: space[7], gap: space[3] }}>
      <View style={styles.sectionHeader}>
        <Text style={[textStyles.heading, { color: c.textPrimary }]}>{title}</Text>
        {count > 0 ? (
          <Text style={[textStyles.caption, { color: c.textTertiary }]}>{count}</Text>
        ) : null}
      </View>
      {children}
    </View>
  )
}

function Empty({ text }: { text: string }) {
  const c = useColors()
  return (
    <View style={[styles.empty, { borderColor: c.border, backgroundColor: c.surface }]}>
      <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>{text}</Text>
    </View>
  )
}

function JobCard({ job }: { job: JobSummary }) {
  const c = useColors()
  const status = customerStatus(job.status)

  return (
    <Pressable
      onPress={() => router.push(`/(customer)/jobs/${job.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${job.title}, ${status.label}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? c.surfaceSunken : c.surface,
          borderColor: c.border,
        },
      ]}
    >
      <View style={{ flex: 1, gap: space[1] }}>
        <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]} numberOfLines={1}>
          {job.category?.name ?? job.title}
        </Text>
        <Text style={[textStyles.caption, { color: c.textSecondary }]}>
          {status.needsYou ? status.label : `${status.label} · ${formatDeadline(job.dueAt)}`}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: space[1] }}>
        <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{displayPrice(job.priceCents)}</Text>
        <View
          style={[
            styles.pill,
            {
              backgroundColor: status.needsYou ? c.warningSubtle : c[status.tone === 'live' ? 'brandSubtle' : 'surfaceSunken'],
            },
          ]}
        >
          <Text
            style={{
              fontSize: 11,
              fontWeight: '800',
              letterSpacing: 0.3,
              color: status.needsYou ? c.warning : status.tone === 'live' ? c.brand : c.textTertiary,
            }}
          >
            {status.pill}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[5] },
  cta: {
    marginTop: space[5], minHeight: minTouchTarget + 8, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  quickRow: { flexDirection: 'row', gap: space[2], marginTop: space[4] },
  quick: {
    borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space[4],
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: space[3],
    borderWidth: 1, borderRadius: radius.md,
    paddingHorizontal: space[4], paddingVertical: space[3],
    minHeight: minTouchTarget + 12,
  },
  pill: { paddingHorizontal: space[2], paddingVertical: 3, borderRadius: radius.full },
  empty: {
    borderWidth: 1, borderRadius: radius.md, borderStyle: 'dashed',
    padding: space[5], alignItems: 'center',
  },
})
