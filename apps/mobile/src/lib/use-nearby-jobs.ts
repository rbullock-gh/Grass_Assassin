import { useCallback, useEffect, useRef, useState } from 'react'
import type { LatLng } from '@grassassassin/shared'
import type { MapJob } from '@grassassassin/client'
import { api } from './api'
import { applyFilters, sortJobs, type Filters, type SortKey } from './jobs'

/**
 * Nearby jobs for the worker map.
 *
 * Server results are cached and re-sorted client-side so changing a sort chip
 * is instant rather than a round trip — on a phone signal, a spinner after every
 * chip tap makes the map feel broken. Filters that the server already applied
 * are re-applied locally for the same reason; the server stays authoritative
 * and a refetch reconciles.
 */
export interface NearbyJobsState {
  jobs: MapJob[]
  allJobs: MapJob[]
  loading: boolean
  refreshing: boolean
  error: string | null
  radiusMilesApplied: number | null
  refetch: (center?: LatLng, radiusMiles?: number) => Promise<void>
}

export function useNearbyJobs(params: {
  center: LatLng | null
  radiusMiles: number
  filters: Filters
  sort: SortKey
  enabled?: boolean
}): NearbyJobsState {
  const { center, radiusMiles, filters, sort, enabled = true } = params

  const [allJobs, setAllJobs] = useState<MapJob[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [radiusMilesApplied, setRadiusMilesApplied] = useState<number | null>(null)

  // Guards against a slow earlier request overwriting a newer result — the
  // classic cause of a map that jumps back to stale jobs after a pan.
  const requestId = useRef(0)
  const hasLoaded = useRef(false)

  const fetchJobs = useCallback(async (overrideCenter?: LatLng, overrideRadius?: number) => {
    const searchCenter = overrideCenter ?? center
    if (!searchCenter || !enabled) return

    const id = ++requestId.current
    if (hasLoaded.current) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const result = await api.searchJobs({
        center: searchCenter,
        radiusMiles: overrideRadius ?? radiusMiles,
        minPayoutCents: filters.minPayoutCents,
        categoryIds: filters.categoryIds,
        equipmentProvided: filters.equipmentProvided,
        difficulty: filters.difficulty,
        dueToday: filters.dueToday,
        dueThisWeek: filters.dueThisWeek,
        sort,
        limit: 100,
      })
      if (id !== requestId.current) return
      setAllJobs(result.jobs)
      setRadiusMilesApplied(result.radiusMilesApplied)
      hasLoaded.current = true
    } catch (caught) {
      if (id !== requestId.current) return
      setError(caught instanceof Error ? caught.message : 'Could not load jobs')
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [center, radiusMiles, filters, sort, enabled])

  useEffect(() => { void fetchJobs() }, [fetchJobs])

  const jobs = sortJobs(applyFilters(allJobs, filters), sort)

  return { jobs, allJobs, loading, refreshing, error, radiusMilesApplied, refetch: fetchJobs }
}
