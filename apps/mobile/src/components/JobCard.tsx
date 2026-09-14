import { memo } from 'react'
import { Text, View, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import type { MapJob } from '@grassassassin/client'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import {
  displayPrice, displayPayout, displayRate, formatDeadline, formatDistance,
  isUrgent, yardSizeLabel,
} from '@/lib/jobs'

/**
 * The job card.
 *
 * CLAIM lives on the card, not only on the detail screen. The single most
 * important interaction in the product must never require navigation — two taps
 * from a cold open is the target, and putting claim behind a detail view makes
 * it three.
 *
 * Claim uses a confirmation sheet rather than firing immediately: an accidental
 * claim becomes a cancellation, which costs the worker points and the customer
 * their afternoon.
 */
export interface JobCardProps {
  job: MapJob
  onPress: () => void
  onClaim: () => void
  claiming?: boolean
  /** Compact omits the description row, for the map's peek detent. */
  compact?: boolean
  showCustomerRating?: boolean
}

export const JobCard = memo(function JobCard({
  job, onPress, onClaim, claiming, compact, showCustomerRating = true,
}: JobCardProps) {
  const c = useColors()
  const urgent = isUrgent(job.dueAt)
  const rate = displayRate(job.payPerHourCents)
  const size = yardSizeLabel(job.yardSize)

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: job.isFeatured ? c.rank : c.border }]}>
      {job.isFeatured ? (
        <View style={[styles.ribbon, { backgroundColor: c.rankSubtle }]}>
          <Text style={[styles.ribbonText, { color: c.rank }]}>FEATURED</Text>
        </View>
      ) : null}

      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${job.categoryName}, ${displayPrice(job.priceCents)}, ${formatDistance(job.distanceMeters)} away, ${formatDeadline(job.dueAt)}`}
        style={styles.body}
      >
        <View style={styles.headRow}>
          <Text style={[textStyles.price, { color: c.payout }]}>{displayPrice(job.priceCents)}</Text>
          <Text style={[styles.title, { color: c.textPrimary }]} numberOfLines={1}>
            {job.categoryName}
          </Text>
        </View>

        {!compact && job.title !== job.categoryName ? (
          <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={1}>
            {job.title}
          </Text>
        ) : null}

        <View style={styles.metaRow}>
          <Meta color={c.textSecondary}>{formatDistance(job.distanceMeters)}</Meta>
          {size ? <Meta color={c.textSecondary}>{size}</Meta> : null}
          {rate ? <Meta color={c.textSecondary}>{rate}</Meta> : null}
        </View>

        <View style={styles.metaRow}>
          <Text
            style={[
              styles.deadline,
              { color: urgent ? c.danger : c.textSecondary, fontWeight: urgent ? '700' : '500' },
            ]}
          >
            {formatDeadline(job.dueAt)}
          </Text>
          {showCustomerRating && job.customerRating !== null ? (
            <Meta color={c.textTertiary}>★ {job.customerRating.toFixed(1)}</Meta>
          ) : null}
          <Meta color={c.textTertiary}>
            {job.equipmentProvided ? 'Equipment provided' : 'Bring your own'}
          </Meta>
        </View>
      </Pressable>

      <Pressable
        onPress={onClaim}
        disabled={claiming}
        accessibilityRole="button"
        accessibilityLabel={`Claim this job for ${displayPayout(job.workerPayoutCents)}`}
        style={({ pressed }) => [
          styles.claim,
          {
            backgroundColor: claiming ? c.brandPressed : pressed ? c.brandHover : c.brand,
            opacity: claiming ? 0.85 : 1,
          },
        ]}
      >
        {claiming ? (
          <ActivityIndicator color={c.onBrand} size="small" />
        ) : (
          <Text style={[styles.claimText, { color: c.onBrand }]}>
            CLAIM {displayPayout(job.workerPayoutCents)}
          </Text>
        )}
      </Pressable>
    </View>
  )
})

function Meta({ children, color }: { children: React.ReactNode; color: string }) {
  return <Text style={[styles.meta, { color }]}>{children}</Text>
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden',
    shadowColor: '#0B1410', shadowOpacity: 0.06, shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  ribbon: { paddingHorizontal: space[3], paddingVertical: 3 },
  ribbonText: { fontSize: 9.5, fontWeight: '800', letterSpacing: 1.2 },
  body: { padding: space[3], gap: space[1] },
  headRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  title: { ...textStyles.bodyStrong, flex: 1 },
  subtitle: { ...textStyles.caption },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[3] },
  meta: { fontSize: 12.5, fontWeight: '500' },
  deadline: { fontSize: 12.5 },
  claim: {
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space[4],
  },
  claimText: { fontSize: 14, fontWeight: '800', letterSpacing: 0.4 },
})
