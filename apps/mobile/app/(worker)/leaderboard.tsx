import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Image,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import type { Leaderboard } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, useIsDark, space, radius, textStyles, minTouchTarget, rankVisuals } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { describePeriod, describeFreshness, describeFallback } from '@/lib/leaderboard'

/**
 * Leaderboards.
 *
 * The brief was explicit that gamification must reward reliability rather than
 * dangerous rushing, and must not lock newcomers out. Two decisions carry that:
 *
 * ROOKIE is a first-class board, not a consolation. A new worker competing
 * against someone with 40,000 points is not competing, and a ladder you cannot
 * climb is a ladder you stop looking at.
 *
 * The board shows points and jobs completed — never speed, never a "fastest
 * job" column. What gets measured gets optimised, and optimising for speed on
 * someone's property with a spinning blade is how people get hurt.
 */

const SCOPES = [
  { key: 'LOCAL', label: 'Near me' },
  { key: 'CITY', label: 'City' },
  { key: 'ROOKIE', label: 'Rookies' },
] as const

const PERIODS = [
  { key: 'WEEKLY', label: 'This week' },
  { key: 'MONTHLY', label: 'This month' },
  { key: 'ALL_TIME', label: 'All time' },
] as const

type Scope = (typeof SCOPES)[number]['key']
type Period = (typeof PERIODS)[number]['key']

export default function LeaderboardScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()

  const [scope, setScope] = useState<Scope>('CITY')
  const [period, setPeriod] = useState<Period>('WEEKLY')
  const [board, setBoard] = useState<Leaderboard | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setBoard(await api.leaderboard(scope, period))
      setError(null)
    } catch {
      setError('Could not load the leaderboard.')
    }
  }, [scope, period])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const myWorkerId = user?.workerProfile?.id ?? null

  const header = (
    <View style={{ gap: space[3], paddingBottom: space[3] }}>
      <ChipRow
        options={SCOPES}
        selected={scope}
        onSelect={(key) => { setScope(key); setBoard(null) }}
      />
      <ChipRow
        options={PERIODS}
        selected={period}
        onSelect={(key) => { setPeriod(key); setBoard(null) }}
      />
      {scope === 'ROOKIE' ? (
        <Text style={[textStyles.caption, { color: c.textSecondary }]}>
          Your first 90 days. Everyone here started this month too.
        </Text>
      ) : null}

      {/* Which week, and how old the numbers are. A worker who just finished a
          job and does not see their points move assumes we lost them. */}
      {board ? (
        <View style={styles.boardMeta}>
          {describePeriod(board) ? (
            <Text style={[textStyles.caption, { color: c.textSecondary }]}>
              {describePeriod(board)}
            </Text>
          ) : null}
          <Text style={[textStyles.caption, { color: c.textTertiary }]}>
            {describeFreshness(board.computedAt)}
          </Text>
        </View>
      ) : null}

      {/* "Near me" that is not near anybody used to be served silently. */}
      {board && describeFallback(board) ? (
        <View style={[styles.notice, { backgroundColor: c.warningSubtle }]}>
          <Text style={[textStyles.caption, { color: c.warningInk }]}>
            {describeFallback(board)}
          </Text>
        </View>
      ) : null}
    </View>
  )

  return (
    <FlatList
      style={{ backgroundColor: c.background }}
      data={board?.entries ?? []}
      keyExtractor={(entry) => entry.workerId}
      ListHeaderComponent={header}
      contentContainerStyle={[
        styles.list,
        {
          paddingTop: insets.top + space[3],
          paddingBottom: insets.bottom + space[6],
          maxWidth: layout.contentMaxWidth,
          alignSelf: 'center',
          width: '100%',
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.brand} />}
      ItemSeparatorComponent={() => <View style={{ height: space[2] }} />}
      ListEmptyComponent={
        board === null ? (
          <ActivityIndicator color={c.brand} style={{ marginTop: space[8] }} />
        ) : (
          <View style={styles.empty}>
            <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>
              {error ?? 'Nobody on this board yet. Finish a job and you are on it.'}
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => <Row entry={item} isMe={item.workerId === myWorkerId} />}
    />
  )
}

function ChipRow<T extends string>({ options, selected, onSelect }: {
  options: readonly { key: T; label: string }[]
  selected: T
  onSelect: (key: T) => void
}) {
  const c = useColors()
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const active = option.key === selected
        return (
          <Pressable
            key={option.key}
            onPress={() => onSelect(option.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[
              styles.chip,
              {
                backgroundColor: active ? c.brand : c.surface,
                borderColor: active ? c.brand : c.border,
              },
            ]}
          >
            <Text style={{ color: active ? c.onBrand : c.textSecondary, fontSize: 13, fontWeight: '700' }}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function Row({ entry, isMe }: { entry: Leaderboard['entries'][number]; isMe: boolean }) {
  const c = useColors()
  const isDark = useIsDark()
  const visual = entry.rankName
    ? Object.values(rankVisuals).find((v) => v.label === entry.rankName)
    : undefined
  const rankColor = visual ? (isDark ? visual.dark : visual.light) : c.textSecondary

  return (
    <Pressable
      onPress={() => router.push(`/(worker)/profile/${entry.workerId}`)}
      accessibilityRole="button"
      accessibilityLabel={`${entry.rank}. ${entry.firstName}, ${entry.points} points`}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? c.surfaceSunken : isMe ? c.brandSubtle : c.surface,
          borderColor: isMe ? c.brand : c.border,
          borderWidth: isMe ? 2 : 1,
        },
      ]}
    >
      <Text style={[styles.position, { color: entry.rank <= 3 ? c.rank : c.textTertiary }]}>
        {entry.rank}
      </Text>

      <View style={[styles.avatar, { backgroundColor: c.surfaceSunken }]}>
        {entry.avatarUrl ? (
          <Image source={{ uri: entry.avatarUrl }} style={styles.avatarImage} />
        ) : (
          <Text style={{ color: c.textSecondary, fontWeight: '800' }}>
            {entry.firstName.slice(0, 1).toUpperCase()}
          </Text>
        )}
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]} numberOfLines={1}>
          {entry.firstName}{isMe ? ' (you)' : ''}
        </Text>
        {entry.rankName ? (
          <Text style={[textStyles.caption, { color: rankColor, fontWeight: '700' }]}>
            {entry.rankName}
          </Text>
        ) : null}
      </View>

      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
          {entry.points.toLocaleString('en-US')}
        </Text>
        <Text style={[textStyles.caption, { color: c.textTertiary }]}>
          {entry.jobsCompleted} {entry.jobsCompleted === 1 ? 'job' : 'jobs'}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: space[5], flexGrow: 1 },
  chipRow: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  boardMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: space[3], flexWrap: 'wrap' },
  notice: { padding: space[3], borderRadius: radius.md },
  // 38px was under the 44px minimum, and these are the controls that decide
  // which board a worker is looking at.
  chip: {
    borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space[4],
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space[3],
    borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[3],
    minHeight: minTouchTarget + 8,
  },
  position: { width: 26, textAlign: 'center', fontSize: 16, fontWeight: '800' },
  avatar: { width: 38, height: 38, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  empty: { flex: 1, justifyContent: 'center', padding: space[8] },
})
