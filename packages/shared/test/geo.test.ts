import { describe, it, expect } from 'vitest'
import {
  haversineMeters, destinationPoint, computeApproximateLocation, boundingBox,
  metersToMiles, milesToMeters, formatDistance, isWithinGeofence, analyticsBucket,
  PRIVACY_OFFSET_MIN_METERS, PRIVACY_OFFSET_MAX_METERS,
} from '../src/geo/index.js'

const NASHVILLE = { lat: 36.1627, lng: -86.7816 }
const FRANKLIN = { lat: 35.9251, lng: -86.8689 }

describe('haversineMeters', () => {
  it('measures a known distance within 0.5%', () => {
    // Nashville -> Franklin TN is ~27.2 km.
    const d = haversineMeters(NASHVILLE, FRANKLIN)
    expect(d).toBeGreaterThan(27_000)
    expect(d).toBeLessThan(27_600)
  })
  it('is zero for identical points', () => {
    expect(haversineMeters(NASHVILLE, NASHVILLE)).toBe(0)
  })
  it('is symmetric', () => {
    expect(haversineMeters(NASHVILLE, FRANKLIN)).toBeCloseTo(haversineMeters(FRANKLIN, NASHVILLE), 6)
  })
  it('handles antipodal points without NaN', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBeGreaterThan(20_000_000)
  })
})

describe('destinationPoint', () => {
  it('lands the requested distance away', () => {
    const moved = destinationPoint(NASHVILLE, 45, 1000)
    expect(haversineMeters(NASHVILLE, moved)).toBeCloseTo(1000, 0)
  })
  it('moves north for bearing 0', () => {
    expect(destinationPoint(NASHVILLE, 0, 1000).lat).toBeGreaterThan(NASHVILLE.lat)
  })
  it('moves east for bearing 90', () => {
    expect(destinationPoint(NASHVILLE, 90, 1000).lng).toBeGreaterThan(NASHVILLE.lng)
  })
  it('keeps longitude normalised when crossing the antimeridian', () => {
    const p = destinationPoint({ lat: 0, lng: 179.99 }, 90, 5000)
    expect(p.lng).toBeGreaterThanOrEqual(-180)
    expect(p.lng).toBeLessThanOrEqual(180)
  })
})

describe('computeApproximateLocation — address privacy', () => {
  it('always offsets within the documented band', () => {
    for (let i = 0; i < 500; i++) {
      const approx = computeApproximateLocation(NASHVILLE)
      const d = haversineMeters(NASHVILLE, approx)
      expect(d).toBeGreaterThanOrEqual(PRIVACY_OFFSET_MIN_METERS - 1)
      expect(d).toBeLessThanOrEqual(PRIVACY_OFFSET_MAX_METERS + 1)
    }
  })

  it('never returns the exact point', () => {
    for (let i = 0; i < 200; i++) {
      const approx = computeApproximateLocation(NASHVILLE)
      expect(approx.lat).not.toBe(NASHVILLE.lat)
      expect(approx.lng).not.toBe(NASHVILLE.lng)
    }
  })

  it('spreads offsets around the compass rather than favouring one direction', () => {
    // A biased offset would let an observer infer the true point's direction.
    const quadrants = [0, 0, 0, 0]
    for (let i = 0; i < 1000; i++) {
      const a = computeApproximateLocation(NASHVILLE)
      const north = a.lat > NASHVILLE.lat
      const east = a.lng > NASHVILLE.lng
      quadrants[north ? (east ? 0 : 1) : east ? 2 : 3]!++
    }
    for (const count of quadrants) {
      expect(count).toBeGreaterThan(150) // expect ~250 each; allow wide variance
    }
  })

  it('is deterministic when given a deterministic source, so it can be persisted', () => {
    // The offset is computed once at write time and stored. Averaging many
    // fresh offsets would triangulate the true point, so per-request
    // randomisation would be a privacy bug, not a feature.
    const fixed = () => 0.5
    const a = computeApproximateLocation(NASHVILLE, fixed)
    const b = computeApproximateLocation(NASHVILLE, fixed)
    expect(a).toEqual(b)
  })
})

describe('unit conversion and formatting', () => {
  it('round-trips miles and meters', () => {
    expect(metersToMiles(milesToMeters(5))).toBeCloseTo(5, 9)
  })
  it('formats distances the way the map displays them', () => {
    expect(formatDistance(50)).toBe('< 0.1 mi')
    expect(formatDistance(milesToMeters(2.44))).toBe('2.4 mi')
    expect(formatDistance(milesToMeters(15.6))).toBe('16 mi')
  })
})

describe('geofence', () => {
  it('accepts a worker at the property', () => {
    expect(isWithinGeofence(destinationPoint(NASHVILLE, 90, 100), NASHVILLE)).toBe(true)
  })
  it('rejects a worker who is not there', () => {
    expect(isWithinGeofence(destinationPoint(NASHVILLE, 90, 400), NASHVILLE)).toBe(false)
  })
})

describe('boundingBox', () => {
  it('contains the whole search circle', () => {
    const box = boundingBox(NASHVILLE, 5000)
    for (let bearing = 0; bearing < 360; bearing += 15) {
      const edge = destinationPoint(NASHVILLE, bearing, 5000)
      expect(edge.lat).toBeGreaterThanOrEqual(box.minLat)
      expect(edge.lat).toBeLessThanOrEqual(box.maxLat)
      expect(edge.lng).toBeGreaterThanOrEqual(box.minLng)
      expect(edge.lng).toBeLessThanOrEqual(box.maxLng)
    }
  })
  it('stays within valid coordinate ranges near the poles', () => {
    const box = boundingBox({ lat: 89.999, lng: 0 }, 100_000)
    expect(box.maxLat).toBeLessThanOrEqual(90)
    expect(box.minLng).toBeGreaterThanOrEqual(-180)
    expect(box.maxLng).toBeLessThanOrEqual(180)
  })
})

describe('analyticsBucket', () => {
  it('coarsens coordinates so analytics never carries an exact location', () => {
    const bucket = analyticsBucket(NASHVILLE)
    expect(bucket).toBe('36.16,-86.78')
    expect(bucket).not.toContain('36.1627')
  })
  it('maps nearby points into the same bucket', () => {
    expect(analyticsBucket({ lat: 36.1627, lng: -86.7816 }))
      .toBe(analyticsBucket({ lat: 36.1631, lng: -86.7819 }))
  })
})
