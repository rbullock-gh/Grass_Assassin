/**
 * Geographic primitives and the address-privacy offset.
 *
 * Distance math here is used for client-side display and for tests. Authoritative
 * distance and radius filtering happen in PostGIS on the server — see
 * apps/api/src/modules/geo.
 */

export interface LatLng {
  lat: number
  lng: number
}

export const EARTH_RADIUS_METERS = 6_371_008.8

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI
}

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const METERS_PER_MILE = 1609.344

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE
}

export function milesToMeters(miles: number): number {
  return miles * METERS_PER_MILE
}

/** Distance label matching the worker map's display conventions. */
export function formatDistance(meters: number): string {
  const miles = metersToMiles(meters)
  if (miles < 0.1) return '< 0.1 mi'
  if (miles < 10) return `${miles.toFixed(1)} mi`
  return `${Math.round(miles)} mi`
}

/** Moves a point `distanceMeters` along `bearingDegrees`. */
export function destinationPoint(origin: LatLng, bearingDegrees: number, distanceMeters: number): LatLng {
  const angular = distanceMeters / EARTH_RADIUS_METERS
  const bearing = toRadians(bearingDegrees)
  const lat1 = toRadians(origin.lat)
  const lng1 = toRadians(origin.lng)

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    )

  return {
    lat: toDegrees(lat2),
    // Normalize longitude into [-180, 180].
    lng: ((toDegrees(lng2) + 540) % 360) - 180,
  }
}

export const PRIVACY_OFFSET_MIN_METERS = 100
export const PRIVACY_OFFSET_MAX_METERS = 250

/**
 * Computes the public, approximate location for a job.
 *
 * Deliberately called ONCE, at job-write time, and persisted. It must never be
 * recomputed per request: a fresh random offset on every response would let an
 * observer average many samples and recover the true coordinate. A single frozen
 * offset leaks nothing beyond "somewhere within ~250m".
 *
 * `random` is injectable so tests are deterministic.
 */
export function computeApproximateLocation(
  exact: LatLng,
  random: () => number = Math.random,
): LatLng {
  const bearing = random() * 360
  const distance =
    PRIVACY_OFFSET_MIN_METERS + random() * (PRIVACY_OFFSET_MAX_METERS - PRIVACY_OFFSET_MIN_METERS)
  return destinationPoint(exact, bearing, distance)
}

/** Geofence check for "worker is actually at the property" before starting work. */
export const GEOFENCE_RADIUS_METERS = 150

export function isWithinGeofence(workerLocation: LatLng, jobLocation: LatLng, radiusMeters = GEOFENCE_RADIUS_METERS): boolean {
  return haversineMeters(workerLocation, jobLocation) <= radiusMeters
}

/** Coarse geohash bucket for analytics — never log exact coordinates (strategy §R12). */
export function analyticsBucket(point: LatLng, precisionDegrees = 0.01): string {
  const lat = Math.round(point.lat / precisionDegrees) * precisionDegrees
  const lng = Math.round(point.lng / precisionDegrees) * precisionDegrees
  return `${lat.toFixed(2)},${lng.toFixed(2)}`
}

export interface BoundingBox {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/** Bounding box around a point, used to pre-filter before exact PostGIS distance. */
export function boundingBox(center: LatLng, radiusMeters: number): BoundingBox {
  const latDelta = toDegrees(radiusMeters / EARTH_RADIUS_METERS)
  const cosLat = Math.cos(toRadians(center.lat))
  // Near the poles the longitude delta explodes; clamp to the full range.
  const lngDelta = Math.abs(cosLat) < 1e-9 ? 180 : toDegrees(radiusMeters / (EARTH_RADIUS_METERS * cosLat))

  return {
    minLat: Math.max(-90, center.lat - latDelta),
    maxLat: Math.min(90, center.lat + latDelta),
    minLng: Math.max(-180, center.lng - lngDelta),
    maxLng: Math.min(180, center.lng + lngDelta),
  }
}
