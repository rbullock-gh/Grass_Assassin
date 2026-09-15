import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma, resetDatabase, createWorker } from '../../../test/factories.js'
import { readLeaderboard, LOCAL_RADIUS_MILES, ROOKIE_MAX_COMPLETED_JOBS } from './leaderboard.js'
import { onRecomputeLeaderboards } from '../queue/handlers.js'
import { periodBoundsFor } from '@grassassassin/shared'

/**
 * Which board a worker is actually shown.
 *
 * Every test here corresponds to something that was wrong: a "Near me" board
 * that was the city board, a "This week" that never reset, and a snapshot
 * written every fifteen minutes that nothing read.
 */

const NASHVILLE = { lat: 36.1627, lng: -86.7816 }
// Memphis: 200 miles west. Same state, nobody's neighbour.
const MEMPHIS = { lat: 35.1495, lng: -90.0490 }

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => { await resetDatabase() })

/** Awards points at a given moment, which is what every board is built from. */
async function award(workerProfileId: string, points: number, at: Date) {
  await prisma.pointTransaction.create({
    data: {
      workerProfileId, points, event: 'JOB_COMPLETED', balanceAfter: points, createdAt: at,
    },
  })
}

const deps = () => ({
  db: prisma,
  provider: null as never,
  queue: null as never,
  notifier: null as never,
})

describe('"Near me" is actually near me', () => {
  it('leaves out a worker two hundred miles away', async () => {
    // This is the whole bug: the endpoint accepted scope=LOCAL and then ignored
    // it, so the app's "Near me" chip returned the city board verbatim.
    const local = await createWorker({ baseLocation: NASHVILLE })
    const distant = await createWorker({ baseLocation: MEMPHIS })
    const now = new Date()
    await award(local.profile.id, 100, now)
    await award(distant.profile.id, 900, now)

    const board = await readLeaderboard(prisma, {
      scope: 'LOCAL', period: 'ALL_TIME', limit: 25, userId: local.user.id, now,
    })

    expect(board.scope).toBe('LOCAL')
    expect(board.entries.map((e) => e.workerId)).toEqual([local.profile.id])
  })

  it('differs from the city board, which is how you know the scope did something', async () => {
    const local = await createWorker({ baseLocation: NASHVILLE })
    const distant = await createWorker({ baseLocation: MEMPHIS })
    const now = new Date()
    await award(local.profile.id, 100, now)
    await award(distant.profile.id, 900, now)

    const near = await readLeaderboard(prisma, {
      scope: 'LOCAL', period: 'ALL_TIME', limit: 25, userId: local.user.id, now,
    })
    const city = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'ALL_TIME', limit: 25, userId: local.user.id, now,
    })

    expect(near.entries).toHaveLength(1)
    expect(city.entries).toHaveLength(2)
  })

  it('includes somebody just inside the radius', async () => {
    // ~20 miles north of Nashville: a different suburb, the same market.
    const neighbour = { lat: NASHVILLE.lat + 0.29, lng: NASHVILLE.lng }
    const me = await createWorker({ baseLocation: NASHVILLE })
    const them = await createWorker({ baseLocation: neighbour })
    const now = new Date()
    await award(me.profile.id, 10, now)
    await award(them.profile.id, 20, now)

    const board = await readLeaderboard(prisma, {
      scope: 'LOCAL', period: 'ALL_TIME', limit: 25, userId: me.user.id, now,
    })
    expect(board.entries).toHaveLength(2)
    expect(LOCAL_RADIUS_MILES).toBeGreaterThan(20)
  })

  it('says it fell back rather than passing the city board off as local', async () => {
    // An anonymous caller has no home base. Showing them the city board under a
    // "Near me" heading is the original bug wearing a different hat.
    const worker = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date()
    await award(worker.profile.id, 10, now)

    const board = await readLeaderboard(prisma, {
      scope: 'LOCAL', period: 'ALL_TIME', limit: 25, now,
    })

    expect(board.scope).toBe('CITY')
    expect(board.fellBackFrom).toBe('LOCAL')
  })

  it('falls back for a worker who has not set a home base yet', async () => {
    const worker = await createWorker({ baseLocation: NASHVILLE })
    await prisma.$executeRawUnsafe(
      'UPDATE "worker_profiles" SET "baseLocation" = NULL WHERE "id" = $1', worker.profile.id,
    )
    const now = new Date()
    await award(worker.profile.id, 10, now)

    const board = await readLeaderboard(prisma, {
      scope: 'LOCAL', period: 'ALL_TIME', limit: 25, userId: worker.user.id, now,
    })
    expect(board.fellBackFrom).toBe('LOCAL')
  })
})

describe('"This week" is a week, not the last 168 hours', () => {
  it('excludes points from before the week started', async () => {
    // The rolling window meant a board that never reset: points aged out
    // continuously and no week was ever won. These points landed last week.
    const worker = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date('2026-07-15T12:00:00Z') // a Wednesday
    const { start } = periodBoundsFor('WEEKLY', now)
    const lastWeek = new Date(start.getTime() - 3_600_000)

    await award(worker.profile.id, 500, lastWeek)

    const board = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'WEEKLY', limit: 25, now,
    })
    expect(board.entries).toHaveLength(0)
  })

  it('counts points from earlier in the same week', async () => {
    const worker = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date('2026-07-15T12:00:00Z')
    const { start } = periodBoundsFor('WEEKLY', now)
    await award(worker.profile.id, 500, new Date(start.getTime() + 3_600_000))

    const board = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'WEEKLY', limit: 25, now,
    })
    expect(board.entries[0]?.points).toBe(500)
  })

  it('reports the boundaries it used, so a client can say which week', async () => {
    const now = new Date('2026-07-15T12:00:00Z')
    const board = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'WEEKLY', limit: 25, now,
    })
    const { start, end } = periodBoundsFor('WEEKLY', now)
    expect(board.periodStart).toBe(start.toISOString())
    expect(board.periodEnd).toBe(end.toISOString())
  })

  it('would have counted those old points under a rolling window', async () => {
    // Negative control for the fix. Six days back is inside a rolling 7 days
    // and outside the calendar week, so this is exactly the case that changed.
    const worker = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date('2026-07-13T12:00:00Z') // Monday, early in the week
    const { start } = periodBoundsFor('WEEKLY', now)
    const sixDaysAgo = new Date(now.getTime() - 6 * 86_400_000)
    expect(sixDaysAgo.getTime()).toBeLessThan(start.getTime())

    await award(worker.profile.id, 500, sixDaysAgo)
    const board = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'WEEKLY', limit: 25, now,
    })
    expect(board.entries).toHaveLength(0)
  })
})

describe('the snapshot the recompute worker writes', () => {
  it('is what a CITY board is served from', async () => {
    const worker = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date()
    await award(worker.profile.id, 300, now)

    await onRecomputeLeaderboards(deps())

    const board = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'ALL_TIME', limit: 25, now,
    })

    // computedAt is only set on a snapshot read. Before this fix it was always
    // null, because the snapshot was written and never opened.
    expect(board.computedAt).not.toBeNull()
    expect(board.entries[0]?.points).toBe(300)
  })

  it('does not go blank between the start of a period and the first recompute', async () => {
    // A weekly board would otherwise be empty for the first fifteen minutes of
    // every week, and a fresh deployment empty until the worker first ran.
    // Empty does not read as "not computed yet", it reads as broken.
    const worker = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date()
    await award(worker.profile.id, 42, now)

    const board = await readLeaderboard(prisma, {
      scope: 'CITY', period: 'WEEKLY', limit: 25, now,
    })

    expect(board.computedAt).toBeNull()
    expect(board.entries[0]?.points).toBe(42)
  })

  it('keeps rookies on their own board', async () => {
    const rookie = await createWorker({ baseLocation: NASHVILLE, completedJobs: 3 })
    const veteran = await createWorker({ baseLocation: NASHVILLE, completedJobs: 400 })
    const now = new Date()
    await award(rookie.profile.id, 50, now)
    await award(veteran.profile.id, 5000, now)

    await onRecomputeLeaderboards(deps())

    const board = await readLeaderboard(prisma, {
      scope: 'ROOKIE', period: 'ALL_TIME', limit: 25, now,
    })
    expect(board.entries.map((e) => e.workerId)).toEqual([rookie.profile.id])
    expect(ROOKIE_MAX_COMPLETED_JOBS).toBe(20)
  })

  it('keeps rookies out of the live path too, not just the snapshot', async () => {
    // The two paths used to be separate SQL with a hand-copied threshold.
    const rookie = await createWorker({ baseLocation: NASHVILLE, completedJobs: 3 })
    const veteran = await createWorker({ baseLocation: NASHVILLE, completedJobs: 400 })
    const now = new Date()
    await award(rookie.profile.id, 50, now)
    await award(veteran.profile.id, 5000, now)

    const board = await readLeaderboard(prisma, {
      scope: 'ROOKIE', period: 'ALL_TIME', limit: 25, now,
    })
    expect(board.computedAt).toBeNull()
    expect(board.entries.map((e) => e.workerId)).toEqual([rookie.profile.id])
  })

  it('ranks from 1 with no gaps, whichever path served it', async () => {
    const a = await createWorker({ baseLocation: NASHVILLE })
    const b = await createWorker({ baseLocation: NASHVILLE })
    const now = new Date()
    await award(a.profile.id, 10, now)
    await award(b.profile.id, 90, now)

    const live = await readLeaderboard(prisma, { scope: 'CITY', period: 'ALL_TIME', limit: 25, now })
    await onRecomputeLeaderboards(deps())
    const stored = await readLeaderboard(prisma, { scope: 'CITY', period: 'ALL_TIME', limit: 25, now })

    expect(live.entries.map((e) => e.rank)).toEqual([1, 2])
    expect(stored.entries.map((e) => e.rank)).toEqual([1, 2])
    expect(stored.entries.map((e) => e.workerId)).toEqual(live.entries.map((e) => e.workerId))
  })

  it('honours the limit on both paths', async () => {
    const now = new Date()
    for (let i = 0; i < 4; i += 1) {
      const w = await createWorker({ baseLocation: NASHVILLE })
      await award(w.profile.id, (i + 1) * 10, now)
    }

    const live = await readLeaderboard(prisma, { scope: 'CITY', period: 'ALL_TIME', limit: 2, now })
    await onRecomputeLeaderboards(deps())
    const stored = await readLeaderboard(prisma, { scope: 'CITY', period: 'ALL_TIME', limit: 2, now })

    expect(live.entries).toHaveLength(2)
    expect(stored.entries).toHaveLength(2)
  })

  it('leaves a suspended worker off the board', async () => {
    const good = await createWorker({ baseLocation: NASHVILLE })
    const suspended = await createWorker({ baseLocation: NASHVILLE, status: 'SUSPENDED' })
    const now = new Date()
    await award(good.profile.id, 10, now)
    await award(suspended.profile.id, 900, now)

    const board = await readLeaderboard(prisma, { scope: 'CITY', period: 'ALL_TIME', limit: 25, now })
    expect(board.entries.map((e) => e.workerId)).toEqual([good.profile.id])
  })
})
