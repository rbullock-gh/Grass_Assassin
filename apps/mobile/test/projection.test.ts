import { describe, it, expect } from 'vitest'
import {
  project, unproject, toScreen, fromScreen, isOnScreen, metersPerPixel,
  zoomForRadius, viewportRadiusMeters, clusterByScreen, clampLatitude, type Viewport,
} from '@/lib/projection'
import { haversineMeters, destinationPoint, milesToMeters } from '@grassassassin/shared'

const NASHVILLE = { lat: 36.1627, lng: -86.7816 }
const viewport: Viewport = { center: NASHVILLE, zoom: 13, width: 390, height: 700 }

describe('projection', () => {
  it('round-trips a coordinate', () => {
    const projected = project(NASHVILLE, 13)
    const back = unproject(projected, 13)
    expect(back.lat).toBeCloseTo(NASHVILLE.lat, 9)
    expect(back.lng).toBeCloseTo(NASHVILLE.lng, 9)
  })

  it('round-trips across a range of coordinates and zooms', () => {
    for (const lat of [-60, -20, 0, 36.16, 60, 80]) {
      for (const lng of [-179, -86.78, 0, 90, 179]) {
        for (const zoom of [3, 8, 13, 18]) {
          const back = unproject(project({ lat, lng }, zoom), zoom)
          expect(back.lat).toBeCloseTo(lat, 6)
          expect(back.lng).toBeCloseTo(lng, 6)
        }
      }
    }
  })

  it('clamps latitude to the Mercator limit rather than producing Infinity', () => {
    expect(clampLatitude(90)).toBeLessThan(90)
    expect(Number.isFinite(project({ lat: 90, lng: 0 }, 13).y)).toBe(true)
    expect(Number.isFinite(project({ lat: -90, lng: 0 }, 13).y)).toBe(true)
  })

  it('places north above and east to the right', () => {
    const north = project({ lat: 37, lng: -86.78 }, 13)
    const south = project({ lat: 36, lng: -86.78 }, 13)
    expect(north.y).toBeLessThan(south.y) // screen y grows downward

    const east = project({ lat: 36.16, lng: -86 }, 13)
    const west = project({ lat: 36.16, lng: -87 }, 13)
    expect(east.x).toBeGreaterThan(west.x)
  })
})

describe('screen mapping', () => {
  it('puts the viewport centre at the middle of the screen', () => {
    const point = toScreen(NASHVILLE, viewport)
    expect(point.x).toBeCloseTo(viewport.width / 2, 6)
    expect(point.y).toBeCloseTo(viewport.height / 2, 6)
  })

  it('round-trips screen coordinates', () => {
    const location = fromScreen({ x: 120, y: 300 }, viewport)
    const back = toScreen(location, viewport)
    expect(back.x).toBeCloseTo(120, 6)
    expect(back.y).toBeCloseTo(300, 6)
  })

  it('detects what is off screen, so hidden markers are not rendered', () => {
    expect(isOnScreen(NASHVILLE, viewport)).toBe(true)
    const faraway = destinationPoint(NASHVILLE, 90, milesToMeters(30))
    expect(isOnScreen(faraway, viewport)).toBe(false)
  })

  it('keeps a marker just off the edge within the padding band', () => {
    // Markers hug the edge while panning; popping them in and out at exactly
    // the boundary looks broken.
    const justOff = fromScreen({ x: -30, y: 300 }, viewport)
    expect(isOnScreen(justOff, viewport, 60)).toBe(true)
    expect(isOnScreen(justOff, viewport, 10)).toBe(false)
  })
})

describe('scale', () => {
  it('computes metres per pixel consistently with real distance', () => {
    const perPixel = metersPerPixel(NASHVILLE.lat, 13)
    const right = fromScreen({ x: viewport.width / 2 + 100, y: viewport.height / 2 }, viewport)
    const measured = haversineMeters(NASHVILLE, right) / 100
    expect(measured).toBeCloseTo(perPixel, 0)
  })

  it('picks a zoom that fits the requested radius on screen', () => {
    for (const radiusMiles of [2, 5, 10, 25]) {
      const radius = milesToMeters(radiusMiles)
      const zoom = zoomForRadius(radius, NASHVILLE.lat, 390, 700)
      const fitted: Viewport = { center: NASHVILLE, zoom, width: 390, height: 700 }

      // The edge of the radius must land inside the viewport with visible
      // breathing room, but not so far inside that the map is uselessly
      // zoomed out.
      const edge = destinationPoint(NASHVILLE, 90, radius)
      expect(isOnScreen(edge, fitted, 0), `radius ${radiusMiles}mi should be on screen`).toBe(true)

      const edgeX = toScreen(edge, fitted).x
      expect(edgeX, `radius ${radiusMiles}mi should clear the edge`).toBeLessThan(390 - 8)

      // And the radius should fill a useful share of the screen rather than
      // sitting as a dot in the middle.
      expect(edgeX, `radius ${radiusMiles}mi should not be tiny`).toBeGreaterThan(390 * 0.6)
    }
  })

  it('clamps zoom to a sane range', () => {
    expect(zoomForRadius(1, NASHVILLE.lat, 390, 700)).toBeLessThanOrEqual(18)
    expect(zoomForRadius(20_000_000, NASHVILLE.lat, 390, 700)).toBeGreaterThanOrEqual(3)
  })

  it('degrades gracefully before layout has measured the view', () => {
    expect(Number.isFinite(zoomForRadius(5000, NASHVILLE.lat, 0, 0))).toBe(true)
  })

  it('computes a viewport radius that covers the corners', () => {
    const radius = viewportRadiusMeters(viewport)
    const corner = fromScreen({ x: 0, y: 0 }, viewport)
    expect(haversineMeters(NASHVILLE, corner)).toBeLessThanOrEqual(radius + 1)
  })
})

describe('clustering', () => {
  const at = (bearing: number, meters: number) => destinationPoint(NASHVILLE, bearing, meters)

  it('groups markers that would overlap on screen', () => {
    // Five jobs within 40m of each other are one visual pile.
    const jobs = [0, 72, 144, 216, 288].map((b) => ({ id: `j${b}`, location: at(b, 20) }))
    const clusters = clusterByScreen(jobs, (j) => j.location, viewport, 64)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.items).toHaveLength(5)
  })

  it('keeps well-separated markers apart', () => {
    const jobs = [
      { id: 'a', location: at(0, 3000) },
      { id: 'b', location: at(90, 3000) },
      { id: 'c', location: at(180, 3000) },
    ]
    expect(clusterByScreen(jobs, (j) => j.location, viewport, 64)).toHaveLength(3)
  })

  it('never loses a marker', () => {
    const jobs = Array.from({ length: 200 }, (_, i) => ({
      id: `j${i}`, location: at(Math.random() * 360, Math.random() * 8000),
    }))
    const clusters = clusterByScreen(jobs, (j) => j.location, viewport, 64)
    const total = clusters.reduce((sum, c) => sum + c.items.length, 0)
    expect(total).toBe(200)
    expect(new Set(clusters.flatMap((c) => c.items.map((j) => j.id))).size).toBe(200)
  })

  it('splits clusters as the user zooms in', () => {
    const jobs = [0, 90, 180, 270].map((b) => ({ id: `j${b}`, location: at(b, 200) }))
    const zoomedOut = clusterByScreen(jobs, (j) => j.location, { ...viewport, zoom: 11 }, 64)
    const zoomedIn = clusterByScreen(jobs, (j) => j.location, { ...viewport, zoom: 17 }, 64)
    expect(zoomedIn.length).toBeGreaterThan(zoomedOut.length)
  })

  it('places a cluster at the centroid of its members', () => {
    const jobs = [{ id: 'a', location: at(0, 30) }, { id: 'b', location: at(180, 30) }]
    const clusters = clusterByScreen(jobs, (j) => j.location, viewport, 128)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.location.lat).toBeCloseTo(NASHVILLE.lat, 4)
  })

  it('handles an empty input', () => {
    expect(clusterByScreen([], () => NASHVILLE, viewport)).toEqual([])
  })
})
