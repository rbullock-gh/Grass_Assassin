import { Text, View, Pressable, StyleSheet } from 'react-native'
import { useColors, space, radius, textStyles } from '@/lib/theme'
import { rankVisuals } from '@grassassassin/design'
import { useIsDark } from '@/lib/theme'

/**
 * The earnings and rank strip above the map.
 *
 * This is the founder-approved blend of Directions A and B: Map First keeps the
 * map as the product, but B's earnings hero was the stronger retention hook, so
 * it survives here as a slim bar. It occupies roughly 10% of the screen and
 * delivers most of B's motivational pull.
 *
 * A brand-new worker sees $0 and an empty bar, which is the weakest moment in
 * the design — so when there is nothing earned yet we show the jobs-nearby count
 * instead, which is a promise rather than a scoreboard.
 */
export interface EarningsStripProps {
  weeklyEarningsCents: number
  points: number
  rankKey: string | null
  rankName: string | null
  pointsToNextRank: number | null
  progressFraction: number | null
  jobsNearby: number
  onPress?: () => void
}

export function EarningsStrip({
  weeklyEarningsCents, points, rankKey, rankName,
  pointsToNextRank, progressFraction, jobsNearby, onPress,
}: EarningsStripProps) {
  const c = useColors()
  const isDark = useIsDark()
  const visual = rankKey ? rankVisuals[rankKey] : undefined
  const rankColor = visual ? (isDark ? visual.dark : visual.light) : c.textSecondary

  const hasEarnings = weeklyEarningsCents > 0

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        hasEarnings
          ? `You earned ${(weeklyEarningsCents / 100).toFixed(2)} dollars this week. ${points} XP, rank ${rankName ?? 'unranked'}.`
          : `${jobsNearby} jobs available near you.`
      }
      style={[styles.strip, { backgroundColor: c.surface, borderBottomColor: c.border }]}
    >
      <View style={styles.left}>
        {hasEarnings ? (
          <>
            <Text style={[styles.label, { color: c.textTertiary }]}>THIS WEEK</Text>
            <Text style={[textStyles.price, { color: c.payout }]}>
              ${(weeklyEarningsCents / 100).toFixed(2)}
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.label, { color: c.textTertiary }]}>NEARBY</Text>
            <Text style={[textStyles.price, { color: c.textPrimary }]}>
              {jobsNearby} {jobsNearby === 1 ? 'job' : 'jobs'}
            </Text>
          </>
        )}
      </View>

      <View style={styles.right}>
        <View style={styles.rankRow}>
          {rankName ? (
            <Text style={[styles.rankName, { color: rankColor }]} numberOfLines={1}>{rankName}</Text>
          ) : null}
          <Text style={[styles.xp, { color: c.textSecondary }]}>{points.toLocaleString()} XP</Text>
        </View>

        <View style={[styles.track, { backgroundColor: c.surfaceSunken }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: rankColor, width: `${Math.round((progressFraction ?? 0) * 100)}%` },
            ]}
          />
        </View>

        <Text style={[styles.toNext, { color: c.textTertiary }]} numberOfLines={1}>
          {pointsToNextRank === null
            ? 'Top rank reached'
            : `${pointsToNextRank.toLocaleString()} to next rank`}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row', alignItems: 'center', gap: space[4],
    paddingHorizontal: space[4], paddingVertical: space[2],
    borderBottomWidth: 1, minHeight: 60,
  },
  left: { minWidth: 96 },
  right: { flex: 1, gap: 3 },
  label: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1.1 },
  rankRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[2] },
  rankName: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  xp: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  track: { height: 5, borderRadius: radius.full, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.full },
  toNext: { fontSize: 10.5, fontWeight: '500' },
})
