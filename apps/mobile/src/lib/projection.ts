import type { LatLng } from '@grassassassin/shared'

/**
 * Web Mercator projection.
 *
 * Used by the fallback map canvas to position markers without a tile provider,
 * and by the Mapbox canvas to decide when a viewport change is large enough to
 * warrant re-querying the server.
 *
 * Pure maths, no native dependency, so it is testable in plain Node — which
 * matters because a projection bug puts every marker in the wrong place and is
 * very hard to spot by eye.
 */

export interface Viewport {
  center: LatLng
  /** Standard slippy-map zoom. 0 is the whole world; ~14 is a neighbourhood. */
  zoom: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

const TILE_SIZE = 256
const MAX_LATITUDE = 85.0511287798

export function clampLatitude(lat: number): number {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat))
}

/** World pixel coordinates at a given zoom. */
export function project(location: LatLng, zoom: number): Point {
  const scale = TILE_SIZE * 2 ** zoom
  const lat = clampLatitude(location.lat)
  const sinLat = Math.sin((lat * Math.PI) / 180)
  return {
    x: scale * (location.lng / 360 + 0.5),
    y: scale * (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)),
  }
}

export function unproject(point: Point, zoom: number): LatLng {
  const scale = TILE_SIZE * 2 ** zoom
  const lng = (point.x / scale - 0.5) * 360
  const y = 0.5 - point.y / scale
  const lat = (Math.atan(Math.sinh(y * 2 * Math.PI)) * 180) / Math.PI
  return { lat, lng }
}

/** Screen position of a coordinate within a viewport, origin at top-left. */
export function toScreen(location: LatLng, viewport: Viewport): Point {
  const center = project(viewport.center, viewport.zoom)
  const target = project(location, viewport.zoom)
  return {
    x: target.x - center.x + viewport.width / 2,
    y: target.y - center.y + viewport.height / 2,
  }
}

export function fromScreen(point: Point, viewport: Viewport): LatLng {
  const center = project(viewport.center, viewport.zoom)
  return unproject(
    { x: center.x + point.x - viewport.width / 2, y: center.y + point.y - viewport.height / 2 },
    viewport.zoom,
  )
}

export function isOnScreen(location: LatLng, viewport: Viewport, paddingPx = 60): boolean {
  const point = toScreen(location, viewport)
  return (
    point.x >= -paddingPx && point.x <= viewport.width + paddingPx &&
    point.y >= -paddingPx && point.y <= viewport.height + paddingPx
  )
}

/** Meters per screen pixel — used to size the radius circle and scale bar. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((clampLatitude(lat) * Math.PI) / 180)) / 2 ** zoom
}

/**
 * Zoom level that fits a radius into the smaller screen dimension.
 *
 * `marginFraction` keeps the radius circle off the screen edge. Fitting the
 * diameter exactly puts the boundary flush against the bezel, where it reads as
 * clipped rather than as a deliberate edge — and leaves no room for a marker
 * sitting on the boundary.
 */
export function zoomForRadius(
  radiusMeters: number,
  lat: number,
  width: number,
  height: number,
  marginFraction = 0.12,
): number {
  const shortest = Math.min(width, height)
  if (shortest <= 0 || radiusMeters <= 0) return 14
  const usable = shortest * (1 - marginFraction)
  const targetMetersPerPixel = (radiusMeters * 2) / usable
  const zoom = Math.log2((156543.03392 * Math.cos((clampLatitude(lat) * Math.PI) / 180)) / targetMetersPerPixel)
  return Math.max(3, Math.min(18, zoom))
}

/** Radius that covers the current viewport, for a "search this area" query. */
export function viewportRadiusMeters(viewport: Viewport): number {
  const perPixel = metersPerPixel(viewport.center.lat, viewport.zoom)
  // Half the diagonal, so the circle covers the corners rather than clipping them.
  return (Math.hypot(viewport.width, viewport.height) / 2) * perPixel
}

/**
 * Whether the viewport moved enough to justify re-querying.
 *
 * Without this the map would fire a request on every frame of a pan, which on a
 * phone signal makes the map feel broken and burns the user's data.
 */
export function shouldRefetch(previous: Viewport, next: Viewport, thresholdFraction = 0.3): boolean {
  if (Math.abs(previous.zoom - next.zoom) >= 0.5) return true
  const movedPixels = Math.hypot(
    toScreen(next.center, previous).x - previous.width / 2,
    toScreen(next.center, previous).y - previous.height / 2,
  )
  return movedPixels > Math.min(previous.width, previous.height) * thresholdFraction
}

/**
 * Groups nearby markers so the map does not become an unreadable pile of pills.
 *
 * A simple screen-space grid rather than true k-means: it is O(n), stable as the
 * user pans, and at the densities a worker actually sees the difference is not
 * visible. Mapbox does this natively in production; this powers the fallback
 * canvas and keeps the behaviour identical between the two.
 */
export interface Cluster<T> {
  location: LatLng
  screen: Point
  items: T[]
}

export function clusterByScreen<T>(
  items: T[],
  locationOf: (item: T) => LatLng,
  viewport: Viewport,
  cellSizePx = 64,
): Cluster<T>[] {
  const cells = new Map<string, { items: T[]; sumX: number; sumY: number }>()

  for (const item of items) {
    const point = toScreen(locationOf(item), viewport)
    const key = `${Math.floor(point.x / cellSizePx)}:${Math.floor(point.y / cellSizePx)}`
    const cell = cells.get(key)
    if (cell) {
      cell.items.push(item)
      cell.sumX += point.x
      cell.sumY += point.y
    } else {
      cells.set(key, { items: [item], sumX: point.x, sumY: point.y })
    }
  }

  return [...cells.values()].map((cell) => {
    const screen = { x: cell.sumX / cell.items.length, y: cell.sumY / cell.items.length }
    return { screen, location: fromScreen(screen, viewport), items: cell.items }
  })
}
