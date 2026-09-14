import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import type { Earnings } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, useIsDark, space, radius, textStyles, rankVisuals } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { displayMoney } from '@/lib/jobs'
import { payoutStatusLabel, progressToNextRank } from '@/lib/earnings'

/**
 * Earnings.
 *
 * The number a worker opens this screen for is "what can I withdraw right
 * now?", so that is the only thing in the largest type. Pending money sits
 * beside it with the reason it is pending — an unexplained gap between what
 * someone earned and what they can touch reads as the platform holding their
 * money, which is how trust in a marketplace dies.
 */
export default function EarningsScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()
  const isDark = useIsDark()

  const [earnings, setEarnings] = useState<Earnings | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setEarnings(await api.earnings())
      setError(null)
    } catch {
      setError('Could not load your earnings. Pull to try again.')
    }
  }, [])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const profile = user?.workerProfile ?? null
  const progress = profile ? progressToNextRank(profile.points, profile.rank?.key ?? null) : null

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + space[4],
          paddingBottom: insets.bottom + space[8],
          maxWidth: layout.contentMaxWidth,
          alignSelf: 'center',
          width: '100%',
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.brand} />}
    >
      <Text style={[textStyles.title, { color: c.textPrimary }]}>Earnings</Text>

      {error ? <Text style={[textStyles.body, { color: c.danger }]}>{error}</Text> : null}

      {earnings === null ? (
        <ActivityIndicator color={c.brand} style={{ marginTop: space[7] }} />
      ) : (
        <>
          <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[textStyles.overline, { color: c.textTertiary }]}>AVAILABLE NOW</Text>
            <Text style={[textStyles.displayLarge, { color: c.payout }]}>
              {displayMoney(earnings.availableBalanceCents)}
            </Text>
            {earnings.pendingBalanceCents > 0 ? (
              <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                {displayMoney(earnings.pendingBalanceCents)} pending — released once each customer approves,
                or automatically if they do not.
              </Text>
            ) : null}
          </View>

          <View style={styles.statRow}>
            <Stat label="This week" value={displayMoney(earnings.thisWeek.earningsCents)} />
            <Stat label="Jobs done" value={String(earnings.thisWeek.jobsCompleted)} />
            <Stat label="Tips" value={displayMoney(earnings.thisWeek.tipsCents)} />
          </View>

          <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>LIFETIME</Text>
            <Text style={[textStyles.heading, { color: c.textPrimary }]}>
              {displayMoney(earnings.lifetimeEarningsCents)}
            </Text>
          </View>

          {progress ? (
            <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>RANK</Text>
              <Text style={[textStyles.heading, { color: rankColor(progress.currentKey, isDark) ?? c.rank }]}>
                {progress.currentName}
              </Text>
              {progress.nextName ? (
                <>
                  <View style={[styles.track, { backgroundColor: c.surfaceSunken }]}>
                    <View
                      style={[
                        styles.fill,
                        { width: `${Math.round(progress.fraction * 100)}%`, backgroundColor: c.brand },
                      ]}
                    />
                  </View>
                  <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                    {progress.pointsRemaining} points to {progress.nextName}
                    {progress.gated
                      ? ` — and ${progress.gateHint}`
                      : ''}
                  </Text>
                </>
              ) : (
                <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                  Top rank. Nothing above this.
                </Text>
              )}
            </View>
          ) : null}

          <View style={{ gap: space[3], marginTop: space[4] }}>
            <Text style={[textStyles.heading, { color: c.textPrimary }]}>Payouts</Text>
            {earnings.payouts.length === 0 ? (
              <Text style={[textStyles.body, { color: c.textSecondary }]}>
                No payouts yet. Finish a job and your first one lands here.
              </Text>
            ) : (
              earnings.payouts.map((payout) => (
                <View
                  key={payout.id}
                  style={[styles.payout, { backgroundColor: c.surface, borderColor: c.border }]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
                      {displayMoney(payout.amountCents)}
                      {payout.instant ? ' · instant' : ''}
                    </Text>
                    <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                      {payoutStatusLabel(payout.status, payout.arrivalDate)}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  )
}

/** Rank colours are per-theme: a single value fails contrast in one of them. */
function rankColor(key: string, isDark: boolean): string | undefined {
  const visual = rankVisuals[key]
  return visual ? (isDark ? visual.dark : visual.light) : undefined
}

function Stat({ label, value }: { label: string; value: string }) {
  const c = useColors()
  return (
    <View style={[styles.stat, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[textStyles.caption, { color: c.textTertiary }]}>{label}</Text>
      <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[5], gap: space[4] },
  hero: { borderWidth: 1, borderRadius: radius.lg, padding: space[5], gap: space[1] },
  statRow: { flexDirection: 'row', gap: space[2] },
  stat: { flex: 1, borderWidth: 1, borderRadius: radius.md, padding: space[3], gap: 2 },
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  track: { height: 8, borderRadius: radius.full, overflow: 'hidden', marginTop: space[1] },
  fill: { height: '100%', borderRadius: radius.full },
  payout: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderRadius: radius.md, padding: space[3],
  },
})
