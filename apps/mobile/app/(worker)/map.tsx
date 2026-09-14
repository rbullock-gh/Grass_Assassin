import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, Alert, RefreshControl,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import * as Location from 'expo-location'
import type { LatLng } from '@grassassassin/shared'
import { progressToNextRank, RANKS } from '@grassassassin/shared'
import type { Category, MapJob } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { useNearbyJobs } from '@/lib/use-nearby-jobs'
import {
  EMPTY_FILTERS, SORT_LABELS, countActiveFilters, describeFilters, displayPayout,
  type Filters, type SortKey,
} from '@/lib/jobs'
import { MapCanvas } from '@/components/MapCanvas'
import { JobCard } from '@/components/JobCard'
import { EarningsStrip } from '@/components/EarningsStrip'
import { FilterSheet } from '@/components/filter-sheet'

/**
 * WORKER HOME — Direction A, "Map First", with B's earnings strip.
 *
 * This screen answers one question in under a second: what can I make money on
 * around me right now? Everything here serves that.
 *
 * Layout adapts by size class rather than by device:
 *   compact  — full-bleed map with a draggable sheet over it
 *   medium+  — map and list side by side, no sheet to fight with
 * Desktop is not a stretched phone; it gets a genuinely different composition.
 */

const NASHVILLE: LatLng = { lat: 36.1627, lng: -86.7816 }

export default function WorkerMapScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()

  const [location, setLocation] = useState<LatLng | null>(null)
  const [locationDenied, setLocationDenied] = useState(false)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortKey>('DISTANCE')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [weeklyEarningsCents, setWeeklyEarnings] = useState(0)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])

  const worker = user?.workerProfile ?? null
  const radiusMiles = worker?.serviceRadiusMiles ?? 15

  // Location permission is requested once, and denial is a supported state —
  // not a dead end. A worker who declines still sees jobs, centred on their
  // service area instead of their live position.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync()
        if (cancelled) return
        if (status !== 'granted') {
          setLocationDenied(true)
          setLocation(NASHVILLE)
          return
        }
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        if (cancelled) return
        setLocation({ lat: position.coords.latitude, lng: position.coords.longitude })
      } catch {
        if (!cancelled) {
          setLocationDenied(true)
          setLocation(NASHVILLE)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    void api.earnings()
      .then((earnings) => setWeeklyEarnings(earnings.thisWeek.earningsCents))
      .catch(() => undefined) // a worker with no earnings yet is not an error
  }, [])

  const { jobs, loading, refreshing, error, refetch } = useNearbyJobs({
    center: location, radiusMiles, filters, sort,
  })

  const rankProgress = useMemo(() => {
    if (!worker?.rank) return null
    const definition = RANKS.find((r) => r.key === worker.rank!.key) ?? RANKS[0]!
    return progressToNextRank(worker.points, definition, RANKS)
  }, [worker])

  const handleClaim = useCallback(async (job: MapJob) => {
    setClaimingId(job.id)
    try {
      const result = await api.claimJob(job.id, location ?? undefined)

      if (result.outcome === 'WON') {
        Alert.alert(
          "It's yours",
          `${job.categoryName} for ${displayPayout(job.workerPayoutCents)}. The address is unlocked on the job screen.`,
          [{ text: 'Open job', onPress: () => router.push(`/(worker)/job/${job.id}`) }],
        )
        await refetch()
      } else {
        // Losing a race is the expected outcome for most workers most of the
        // time. It is phrased as information, never as an error.
        Alert.alert('Just missed it', result.message)
        await refetch()
      }
    } catch {
      Alert.alert('Could not claim', 'Check your connection and try again.')
    } finally {
      setClaimingId(null)
    }
  }, [location, refetch])

  const openJob = useCallback((jobId: string) => {
    router.push(`/(worker)/job/${jobId}`)
  }, [])

  // Loaded once for the work-type filter. Failure is silent and the filter
  // simply does not appear: a worker who cannot load a category list still has
  // a working map, which matters more.
  useEffect(() => {
    void api.categories()
      .then((result) => setCategories(result.categories))
      .catch(() => undefined)
  }, [])

  const activeFilterCount = countActiveFilters(filters)
  const categoryNames = useMemo(
    () => Object.fromEntries(categories.map((category) => [category.id, category.name])),
    [categories],
  )

  const listHeader = (
    <View style={styles.listHeader}>
      <View style={styles.listHeadRow}>
        <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
          {loading ? 'Finding jobs…' : `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} nearby`}
        </Text>
        <Pressable
          onPress={() => setFiltersOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={
            activeFilterCount > 0
              ? `Filters, ${activeFilterCount} active: ${describeFilters(filters, categoryNames)}`
              : 'Filters'
          }
          style={[
            styles.filterButton,
            {
              backgroundColor: activeFilterCount > 0 ? c.brandSubtle : c.surface,
              borderColor: activeFilterCount > 0 ? c.brand : c.border,
            },
          ]}
        >
          <Text style={{ color: activeFilterCount > 0 ? c.brand : c.textSecondary, fontSize: 13, fontWeight: '700' }}>
            {activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : 'Filters'}
          </Text>
        </Pressable>
      </View>

      {activeFilterCount > 0 ? (
        // Says WHY the list is short without making the worker open the sheet
        // to find out. A worker who sees three jobs where there were forty and
        // cannot tell why concludes the app is broken.
        <Text style={[textStyles.caption, { color: c.textTertiary }]} numberOfLines={1}>
          {describeFilters(filters, categoryNames)}
        </Text>
      ) : null}

      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={Object.keys(SORT_LABELS) as SortKey[]}
        keyExtractor={(key) => key}
        contentContainerStyle={styles.chipRow}
        renderItem={({ item }) => {
          const active = sort === item
          return (
            <Pressable
              onPress={() => setSort(item)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.chip,
                { backgroundColor: active ? c.brand : c.surface, borderColor: active ? c.brand : c.border },
              ]}
            >
              <Text style={{ color: active ? c.onBrand : c.textSecondary, fontSize: 12.5, fontWeight: '600' }}>
                {SORT_LABELS[item]}
              </Text>
            </Pressable>
          )
        }}
      />
    </View>
  )

  const jobList = (
    <FlatList
      data={jobs}
      keyExtractor={(job) => job.id}
      ListHeaderComponent={listHeader}
      stickyHeaderIndices={[0]}
      contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + space[6] }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void refetch()} tintColor={c.brand} />
      }
      ItemSeparatorComponent={() => <View style={{ height: space[2] }} />}
      renderItem={({ item }) => (
        <JobCard
          job={item}
          onPress={() => openJob(item.id)}
          onClaim={() => void handleClaim(item)}
          claiming={claimingId === item.id}
        />
      )}
      ListEmptyComponent={
        loading ? (
          <View style={styles.empty}>
            <ActivityIndicator color={c.brand} />
          </View>
        ) : (
          <EmptyState
            error={error}
            hasFilters={activeFilterCount > 0}
            onClearFilters={() => setFilters(EMPTY_FILTERS)}
            onRetry={() => void refetch()}
          />
        )
      }
    />
  )

  const map = (
    <MapCanvas
      center={location ?? NASHVILLE}
      radiusMeters={radiusMiles * 1609.344}
      jobs={jobs}
      selectedJobId={selectedJobId}
      onSelectJob={(id) => { setSelectedJobId(id); openJob(id) }}
      onSearchThisArea={(center) => void refetch(center)}
    />
  )

  return (
    <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top }]}>
      <EarningsStrip
        weeklyEarningsCents={weeklyEarningsCents}
        points={worker?.points ?? 0}
        rankKey={worker?.rank?.key ?? null}
        rankName={worker?.rank?.name ?? null}
        pointsToNextRank={rankProgress?.pointsNeeded ?? null}
        progressFraction={rankProgress?.fraction ?? 0}
        jobsNearby={jobs.length}
        onPress={() => router.push('/(worker)/earnings')}
      />

      {locationDenied ? (
        <Pressable
          onPress={() => void Location.requestForegroundPermissionsAsync()}
          style={[styles.banner, { backgroundColor: c.warningSubtle }]}
        >
          <Text style={{ color: c.warning, fontSize: 12.5, fontWeight: '600' }}>
            Location is off — showing jobs in your service area. Tap to enable.
          </Text>
        </Pressable>
      ) : null}

      {layout.isMultiPane ? (
        // Tablet, unfolded foldable, desktop: list rail beside the map. Not a
        // stretched phone.
        <View style={styles.twoPane}>
          <View style={[styles.rail, { width: layout.sizeClass === 'large' ? 380 : 340, borderRightColor: c.border }]}>
            {jobList}
          </View>
          <View style={styles.mapPane}>{map}</View>
        </View>
      ) : (
        // Phone: full-bleed map with the list sheet over it.
        <View style={styles.stack}>
          <View style={styles.mapFill}>{map}</View>
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: c.surface,
                borderTopColor: c.border,
                maxHeight: layout.height * (layout.isPhoneLandscape ? 0.95 : 0.55),
              },
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: c.borderStrong }]} />
            {jobList}
          </View>
        </View>
      )}

      {/* Rendered once, outside both layout branches: a Modal is positioned
          against the screen, so duplicating it per branch would mount two. */}
      <FilterSheet
        visible={filtersOpen}
        filters={filters}
        categories={categories}
        resultCount={jobs.length}
        onChange={setFilters}
        onClose={() => setFiltersOpen(false)}
      />
    </View>
  )
}

function EmptyState({ error, hasFilters, onClearFilters, onRetry }: {
  error: string | null
  hasFilters: boolean
  onClearFilters: () => void
  onRetry: () => void
}) {
  const c = useColors()

  if (error) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>Could not load jobs</Text>
        <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
          Check your connection and try again.
        </Text>
        <Pressable onPress={onRetry} style={[styles.emptyAction, { backgroundColor: c.brand }]}>
          <Text style={{ color: c.onBrand, fontWeight: '700' }}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  if (hasFilters) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>No jobs match your filters</Text>
        <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
          There may be work nearby that your filters are hiding.
        </Text>
        <Pressable onPress={onClearFilters} style={[styles.emptyAction, { backgroundColor: c.brand }]}>
          <Text style={{ color: c.onBrand, fontWeight: '700' }}>Clear filters</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>No jobs right now</Text>
      <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
        New work gets posted through the day. We will notify you the moment
        something lands in your area.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  stack: { flex: 1 },
  mapFill: { flex: 1 },
  twoPane: { flex: 1, flexDirection: 'row' },
  rail: { borderRightWidth: 1 },
  mapPane: { flex: 1 },
  sheet: {
    borderTopWidth: 1, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingTop: space[2],
    shadowColor: '#0B1410', shadowOpacity: 0.16, shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 }, elevation: 16,
  },
  grabber: { width: 34, height: 4, borderRadius: 999, alignSelf: 'center', marginBottom: space[2] },
  banner: { paddingHorizontal: space[4], paddingVertical: space[2], minHeight: minTouchTarget, justifyContent: 'center' },
  listHeader: { paddingHorizontal: space[4], paddingBottom: space[2], gap: space[2] },
  listHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filterButton: {
    minHeight: 34, borderWidth: 1, borderRadius: radius.full,
    paddingHorizontal: space[3], alignItems: 'center', justifyContent: 'center',
  },
  clearButton: { minHeight: 32, justifyContent: 'center' },
  chipRow: { gap: space[2], paddingVertical: space[1] },
  chip: { paddingHorizontal: space[3], paddingVertical: 7, borderRadius: radius.full, borderWidth: 1 },
  listContent: { paddingHorizontal: space[4] },
  empty: { padding: space[8], alignItems: 'center', gap: space[2] },
  emptyTitle: { ...textStyles.subheading, textAlign: 'center' },
  emptyBody: { ...textStyles.body, textAlign: 'center', maxWidth: 320 },
  emptyAction: {
    marginTop: space[2], paddingHorizontal: space[5], minHeight: minTouchTarget,
    borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
  },
})
