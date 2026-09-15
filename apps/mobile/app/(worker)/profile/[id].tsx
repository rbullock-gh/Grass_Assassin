import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Image, Pressable } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import type { WorkerPublicProfile } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useColors, useIsDark, space, radius, textStyles, rankVisuals, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'

/**
 * A pro's public profile.
 *
 * Reputation only — no email, no phone, no home location. A customer looking at
 * this is deciding whether to let a stranger onto their property, and a worker
 * looking at a rival's is comparing standing; neither needs a contact card, and
 * publishing one would hand a harasser everything they need.
 *
 * Rate, completion and on-time are shown alongside the rank rather than behind
 * it, because a rank badge with nothing under it is a participation trophy.
 */
export default function WorkerProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const c = useColors()
  const isDark = useIsDark()
  const layout = useLayout()

  const [profile, setProfile] = useState<WorkerPublicProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    try {
      setProfile(await api.workerProfile(id))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.brand} />
      </View>
    )
  }

  if (!profile) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={{ color: c.textSecondary }}>That profile is not available.</Text>
      </View>
    )
  }

  const visual = profile.rank ? rankVisuals[profile.rank.key] : undefined
  const rankColor = visual ? (isDark ? visual.dark : visual.light) : c.textSecondary

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
      ]}
    >
      <View style={[styles.header, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.avatar, { backgroundColor: c.surfaceSunken }]}>
          {profile.avatarUrl ? (
            <Image source={{ uri: profile.avatarUrl }} style={styles.avatarImage} />
          ) : (
            <Text style={{ color: c.textSecondary, fontWeight: '800', fontSize: 26 }}>
              {profile.firstName.slice(0, 1).toUpperCase()}
            </Text>
          )}
        </View>
        <Text style={[textStyles.title, { color: c.textPrimary }]}>
          {profile.firstName}
          {profile.rank?.verifiedBadge ? ' ✓' : ''}
        </Text>
        {profile.rank ? (
          <Text style={[textStyles.bodyStrong, { color: rankColor }]}>{profile.rank.name}</Text>
        ) : null}
        {profile.bio ? (
          <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>{profile.bio}</Text>
        ) : null}
      </View>

      <View style={styles.statRow}>
        <Stat
          label="Rating"
          value={profile.rating !== null ? `${profile.rating.toFixed(1)}★` : 'New'}
          hint={profile.ratingCount > 0 ? `${profile.ratingCount} reviews` : 'No reviews yet'}
        />
        <Stat label="Jobs" value={String(profile.completedJobs)} hint="completed" />
        <Stat label="On time" value={`${Math.round(profile.onTimeRate * 100)}%`} hint="arrivals" />
      </View>

      {profile.services.length > 0 ? (
        <Panel title="SERVICES">
          <View style={styles.chips}>
            {profile.services.map((service) => (
              <Chip key={service.id} label={service.name} />
            ))}
          </View>
        </Panel>
      ) : null}

      {profile.equipment.length > 0 ? (
        <Panel title="EQUIPMENT">
          <View style={styles.chips}>
            {profile.equipment.map((item) => (
              <Chip key={item.id} label={item.name} />
            ))}
          </View>
        </Panel>
      ) : null}

      {profile.badges.length > 0 ? (
        <Panel title="BADGES">
          {profile.badges.map((badge) => (
            <View key={badge.key} style={{ gap: 2 }}>
              <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{badge.name}</Text>
              <Text style={[textStyles.caption, { color: c.textSecondary }]}>{badge.description}</Text>
            </View>
          ))}
        </Panel>
      ) : null}

      {profile.reviews.length > 0 ? (
        <Panel title="WHAT CUSTOMERS SAY">
          {profile.reviews.map((review, index) => (
            <View key={`${review.createdAt}-${index}`} style={{ gap: 2 }}>
              <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
                {'★'.repeat(review.rating)}
                <Text style={{ color: c.textTertiary }}>{'★'.repeat(5 - review.rating)}</Text>
              </Text>
              {review.comment ? (
                <Text style={[textStyles.body, { color: c.textSecondary }]}>{review.comment}</Text>
              ) : null}
              <Text style={[textStyles.caption, { color: c.textTertiary }]}>
                {review.author.firstName}
              </Text>
            </View>
          ))}
        </Panel>
      ) : null}

      {/*
        * Last, quiet, and present.
        *
        * A profile is where somebody decides whether to let this person onto
        * their property, so it is where "something is wrong with this person"
        * has to be reachable. Placed at the end and in plain text because
        * a prominent red button on a profile invites idle use, and every idle
        * report costs a reviewer the time a real one needed.
        */}
      <Pressable
        onPress={() => router.push({
          pathname: '/(shared)/report-person/[userId]',
          params: { userId: profile.userId, name: profile.firstName },
        })}
        accessibilityRole="button"
        accessibilityLabel={`Report ${profile.firstName}`}
        style={styles.report}
      >
        <Text style={[textStyles.caption, { color: c.textTertiary, fontWeight: '700' }]}>
          Report {profile.firstName}
        </Text>
      </Pressable>
    </ScrollView>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  const c = useColors()
  return (
    <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>{title}</Text>
      {children}
    </View>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  const c = useColors()
  return (
    <View style={[styles.stat, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[textStyles.caption, { color: c.textTertiary }]}>{label}</Text>
      <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{value}</Text>
      <Text style={[textStyles.caption, { color: c.textTertiary }]}>{hint}</Text>
    </View>
  )
}

function Chip({ label }: { label: string }) {
  const c = useColors()
  return (
    <View style={[styles.chip, { backgroundColor: c.surfaceSunken, borderColor: c.border }]}>
      <Text style={{ color: c.textPrimary, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space[5], gap: space[4], paddingBottom: space[10] },
  header: {
    borderWidth: 1, borderRadius: radius.lg, padding: space[5],
    alignItems: 'center', gap: space[2],
  },
  avatar: { width: 72, height: 72, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  statRow: { flexDirection: 'row', gap: space[2] },
  stat: { flex: 1, borderWidth: 1, borderRadius: radius.md, padding: space[3], gap: 2 },
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[3] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space[3], paddingVertical: space[1] },
  report: { minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center' },
})
