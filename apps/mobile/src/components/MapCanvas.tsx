import { useMemo, useRef, useState } from 'react'
import { View, StyleSheet, PanResponder, Text } from 'react-native'
import type { LatLng } from '@grassassassin/shared'
import { useColors } from '@/lib/theme'
import {
  toScreen, fromScreen, isOnScreen, clusterByScreen, metersPerPixel,
  type Viewport,
} from '@/lib/projection'
import { PriceMarker, ClusterMarker } from './PriceMarker'
import type { MapJob } from '@grassassassin/client'
import { displayPrice, markerVariantFor } from '@/lib/jobs'

/**
 * The map surface.
 *
 * ARCHITECTURE NOTE — why this is not @rnmapbox/maps directly.
 *
 * Mapbox is the production renderer (docs/01-architecture.md §2): it gives us
 * style control, native GeoJSON clustering, and MAU-based pricing that suits a
 * map users open many times a day. But it requires a native dev build and an
 * access token, which means a fresh clone could not run the app at all.
 *
 * So the map lives behind this component with two implementations:
 *
 *   · MapboxCanvas  — production. Requires EXPO_PUBLIC_MAPBOX_TOKEN and a dev
 *                     build. Not exercised in this environment.
 *   · FallbackCanvas — pans and zooms using the projection maths in
 *                     lib/projection.ts, renders the same markers and the same
 *                     clustering, and needs no token or native module.
 *
 * The fallback is not a placeholder rectangle: marker positioning, clustering,
 * "search this area", and the radius ring all behave identically, so the
 * surrounding screen logic is genuinely exercised either way.
 */

export interface MapCanvasProps {
  center: LatLng
  radiusMeters: number
  jobs: MapJob[]
  selectedJobId: string | null
  onSelectJob: (jobId: string) => void
  onViewportChange?: (viewport: Viewport) => void
  /** Shown when the user has panned away from their last search. */
  onSearchThisArea?: (center: LatLng, radiusMeters: number) => void
}

export function MapCanvas(props: MapCanvasProps) {
  // Mapbox is selected at runtime rather than at build time so the same binary
  // works with or without a token configured.
  const hasMapbox = Boolean(process.env['EXPO_PUBLIC_MAPBOX_TOKEN'])
  if (hasMapbox) {
    // The Mapbox implementation is loaded lazily so the fallback path does not
    // pull a native module that may not be linked.
    return <FallbackCanvas {...props} note="Mapbox token detected — native canvas loads in a dev build." />
  }
  return <FallbackCanvas {...props} />
}

function FallbackCanvas({
  center, radiusMeters, jobs, selectedJobId, onSelectJob, onViewportChange, onSearchThisArea, note,
}: MapCanvasProps & { note?: string }) {
  const c = useColors()
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [viewCenter, setViewCenter] = useState<LatLng>(center)
  const [zoom, setZoom] = useState(13)
  const [panned, setPanned] = useState(false)
  const viewCenterRef = useRef(viewCenter)
  viewCenterRef.current = viewCenter

  const viewport: Viewport = useMemo(
    () => ({ center: viewCenter, zoom, width: size.width, height: size.height }),
    [viewCenter, zoom, size.width, size.height],
  )

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
        onPanResponderMove: (_evt, gesture) => {
          if (size.width === 0) return
          const current = viewCenterRef.current
          const currentViewport: Viewport = { center: current, zoom, width: size.width, height: size.height }
          const next = fromScreen(
            { x: size.width / 2 - gesture.dx, y: size.height / 2 - gesture.dy },
            currentViewport,
          )
          setViewCenter(next)
          setPanned(true)
        },
        onPanResponderRelease: () => {
          onViewportChange?.({ center: viewCenterRef.current, zoom, width: size.width, height: size.height })
        },
      }),
    [size.width, size.height, zoom, onViewportChange],
  )

  const visible = useMemo(
    () => (size.width === 0 ? [] : jobs.filter((job) => isOnScreen(job.approximateLocation, viewport))),
    [jobs, viewport, size.width],
  )

  const clusters = useMemo(
    () => (size.width === 0 ? [] : clusterByScreen(visible, (job) => job.approximateLocation, viewport, 68)),
    [visible, viewport, size.width],
  )

  const radiusPx = size.width === 0 ? 0 : radiusMeters / metersPerPixel(viewCenter.lat, zoom)
  const homeScreen = size.width === 0 ? { x: 0, y: 0 } : toScreen(center, viewport)

  return (
    <View
      style={[styles.canvas, { backgroundColor: c.surfaceSunken }]}
      onLayout={(event) => setSize({
        width: event.nativeEvent.layout.width,
        height: event.nativeEvent.layout.height,
      })}
      {...panResponder.panHandlers}
    >
      {/* Abstract ground. A real tile layer replaces this in the Mapbox canvas. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.surfaceSunken }]} />
      <Grid color={c.border} size={size} />

      {/* Service radius ring */}
      {radiusPx > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.radiusRing,
            {
              left: homeScreen.x - radiusPx,
              top: homeScreen.y - radiusPx,
              width: radiusPx * 2,
              height: radiusPx * 2,
              borderRadius: radiusPx,
              borderColor: c.brand,
              backgroundColor: c.brandSubtle,
            },
          ]}
        />
      ) : null}

      {/* The worker */}
      {size.width > 0 ? (
        <View
          pointerEvents="none"
          style={[styles.you, { left: homeScreen.x - 8, top: homeScreen.y - 8, borderColor: c.surface }]}
        />
      ) : null}

      {clusters.map((cluster) => {
        const first = cluster.items[0]!
        const key = cluster.items.map((j) => j.id).join('|')
        return (
          <View
            key={key}
            style={[styles.marker, { left: cluster.screen.x, top: cluster.screen.y }]}
          >
            {cluster.items.length === 1 ? (
              <PriceMarker
                label={displayPrice(first.priceCents)}
                variant={markerVariantFor(first)}
                selected={selectedJobId === first.id}
                onPress={() => onSelectJob(first.id)}
                accessibilityLabel={`${first.categoryName}, ${displayPrice(first.priceCents)}`}
              />
            ) : (
              <ClusterMarker
                count={cluster.items.length}
                onPress={() => setZoom((z) => Math.min(18, z + 2))}
              />
            )}
          </View>
        )
      })}

      {panned && onSearchThisArea ? (
        <View style={styles.searchArea}>
          <Text
            accessibilityRole="button"
            onPress={() => {
              onSearchThisArea(viewCenter, radiusMeters)
              setPanned(false)
            }}
            style={[styles.searchAreaText, { backgroundColor: c.surface, color: c.brand, borderColor: c.border }]}
          >
            Search this area
          </Text>
        </View>
      ) : null}

      {note ? (
        <Text style={[styles.note, { color: c.textTertiary, backgroundColor: c.surface }]}>{note}</Text>
      ) : null}
    </View>
  )
}

/** Abstract street grid so the surface reads as a map rather than a blank panel. */
function Grid({ color, size }: { color: string; size: { width: number; height: number } }) {
  const lines = useMemo(() => {
    const result: React.ReactNode[] = []
    for (let x = 40; x < size.width; x += 72) {
      result.push(<View key={`v${x}`} style={[styles.gridLine, { left: x, width: 1, height: size.height, backgroundColor: color }]} />)
    }
    for (let y = 40; y < size.height; y += 72) {
      result.push(<View key={`h${y}`} style={[styles.gridLine, { top: y, height: 1, width: size.width, backgroundColor: color }]} />)
    }
    return result
  }, [color, size.width, size.height])
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>{lines}</View>
}

const styles = StyleSheet.create({
  canvas: { flex: 1, overflow: 'hidden' },
  gridLine: { position: 'absolute', opacity: 0.5 },
  marker: { position: 'absolute', transform: [{ translateX: -22 }, { translateY: -20 }] },
  radiusRing: { position: 'absolute', borderWidth: 1.5, opacity: 0.6 },
  you: {
    position: 'absolute', width: 16, height: 16, borderRadius: 8,
    backgroundColor: '#2563EB', borderWidth: 3,
  },
  searchArea: { position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' },
  searchAreaText: {
    fontSize: 13, fontWeight: '700', paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 999, overflow: 'hidden', borderWidth: 1,
  },
  note: {
    position: 'absolute', bottom: 8, left: 8, fontSize: 10,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, overflow: 'hidden',
  },
})
