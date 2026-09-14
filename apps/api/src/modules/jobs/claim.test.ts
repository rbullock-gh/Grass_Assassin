import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob, NASHVILLE,
} from '../../../test/factories.js'
import {
  attemptClaim, confirmClaimPaid, releaseReservation, sweepExpiredReservations,
  CLAIM_RESERVATION_TTL_SECONDS,
} from './claim.js'
import { destinationPoint, milesToMeters } from '@grassassassin/shared'

/**
 * HULK — concurrency and contention.
 *
 * These run against a real PostgreSQL + PostGIS database on purpose. The
 * property under test is row-level locking behaviour under concurrent
 * conditional UPDATEs, which exists only inside Postgres. A mocked database
 * would assert nothing about the thing that can actually break.
 */

let categoryId: string
let customerId: string
let propertyId: string

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })

beforeEach(async () => {
  await resetDatabase()
  const category = await createCategory()
  const customer = await createCustomer()
  const property = await createProperty(customer.id)
  categoryId = category.id
  customerId = customer.id
  propertyId = property.id
})

describe('single-winner claim under concurrency', () => {
  it('lets exactly one of 20 simultaneous workers win', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })

    const workers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createWorker({ email: `race${i}-${Date.now()}@x.com`, categoryId })),
    )

    // Fire every claim in the same tick. Prisma dispatches these across the
    // connection pool, so they contend for the same row inside Postgres.
    const results = await Promise.all(
      workers.map((w) => attemptClaim(prisma, { jobId: job.id, workerUserId: w.user.id })),
    )

    const winners = results.filter((r) => r.outcome === 'WON')
    const losers = results.filter((r) => r.outcome === 'LOST')

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(19)

    // Every loser must be told the truth: someone else got it.
    for (const l of losers) {
      expect(l.outcome).toBe('LOST')
      if (l.outcome === 'LOST') expect(l.reason).toBe('ALREADY_CLAIMED')
    }

    // The database agrees with exactly one winner.
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('CLAIM_PENDING_PAYMENT')
    const winner = winners[0]!
    if (winner.outcome === 'WON') {
      expect(after.claimedByWorkerId).toBe(
        workers.find((w) => results[workers.indexOf(w)]?.outcome === 'WON')?.user.id,
      )
    }
    expect(after.claimedByWorkerId).not.toBeNull()
    expect(after.claimExpiresAt).not.toBeNull()

    // Exactly one WON row in the claims audit trail.
    const wonClaims = await prisma.jobClaim.count({ where: { jobId: job.id, outcome: 'WON' } })
    expect(wonClaims).toBe(1)
  })

  it('holds at exactly one winner across 50 workers', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const workers = await Promise.all(
      Array.from({ length: 50 }, (_, i) => createWorker({ email: `heavy${i}-${Date.now()}@x.com`, categoryId })),
    )

    const results = await Promise.all(
      workers.map((w) => attemptClaim(prisma, { jobId: job.id, workerUserId: w.user.id })),
    )

    expect(results.filter((r) => r.outcome === 'WON')).toHaveLength(1)
    expect(await prisma.jobClaim.count({ where: { jobId: job.id, outcome: 'WON' } })).toBe(1)
  })

  it('assigns each of 5 jobs exactly one winner when 25 workers storm all of them', async () => {
    // The realistic scenario: a batch of jobs posts, every nearby worker's phone
    // buzzes, and they all tap at once across several jobs.
    const jobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createJob({ customerId, propertyId, categoryId, title: `Job ${i}` }),
      ),
    )
    const workers = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        createWorker({ email: `storm${i}-${Date.now()}@x.com`, categoryId, maxActiveJobs: 10 }),
      ),
    )

    const attempts = workers.flatMap((w) =>
      jobs.map((j) => attemptClaim(prisma, { jobId: j.id, workerUserId: w.user.id })),
    )
    const results = await Promise.all(attempts)

    expect(results.filter((r) => r.outcome === 'WON')).toHaveLength(5)

    for (const job of jobs) {
      const won = await prisma.jobClaim.count({ where: { jobId: job.id, outcome: 'WON' } })
      expect(won, `job ${job.id} must have exactly one winner`).toBe(1)

      const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(row.status).toBe('CLAIM_PENDING_PAYMENT')
      expect(row.claimedByWorkerId).not.toBeNull()
    }

    // No worker won the same job twice.
    const allWon = await prisma.jobClaim.findMany({ where: { outcome: 'WON' } })
    const pairs = new Set(allWon.map((c) => `${c.jobId}:${c.workerId}`))
    expect(pairs.size).toBe(allWon.length)
  })

  it('still yields one winner when the same worker double-taps', async () => {
    // Fat-finger / laggy network: the client fires the same claim twice.
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })

    const results = await Promise.all([
      attemptClaim(prisma, { jobId: job.id, workerUserId: user.id }),
      attemptClaim(prisma, { jobId: job.id, workerUserId: user.id }),
      attemptClaim(prisma, { jobId: job.id, workerUserId: user.id }),
    ])

    expect(results.filter((r) => r.outcome === 'WON')).toHaveLength(1)
    expect(await prisma.jobClaim.count({ where: { jobId: job.id, outcome: 'WON' } })).toBe(1)
  })
})

describe('claim eligibility', () => {
  it('refuses a worker who has not finished onboarding', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ status: 'PENDING_ONBOARDING', categoryId })

    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('WORKER_NOT_APPROVED')
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('POSTED')
  })

  it('refuses a suspended worker', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ status: 'SUSPENDED', categoryId })
    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })
    expect(result.outcome).toBe('LOST')
  })

  it('refuses a worker already at their active-job cap', async () => {
    const { user } = await createWorker({ maxActiveJobs: 2, categoryId })

    for (let i = 0; i < 2; i++) {
      const j = await createJob({ customerId, propertyId, categoryId, title: `Active ${i}` })
      const r = await attemptClaim(prisma, { jobId: j.id, workerUserId: user.id })
      expect(r.outcome).toBe('WON')
    }

    const third = await createJob({ customerId, propertyId, categoryId, title: 'Third' })
    const result = await attemptClaim(prisma, { jobId: third.id, workerUserId: user.id })

    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('TOO_MANY_ACTIVE_JOBS')
  })

  it('refuses a job that is not POSTED', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const first = await createWorker({ categoryId })
    const second = await createWorker({ categoryId })

    await attemptClaim(prisma, { jobId: job.id, workerUserId: first.user.id })
    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: second.user.id })

    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('ALREADY_CLAIMED')
  })

  it('refuses an expired job', async () => {
    const job = await createJob({
      customerId, propertyId, categoryId,
      dueAt: new Date(Date.now() - 3_600_000),
    })
    const { user } = await createWorker({ categoryId })
    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })
    expect(result.outcome).toBe('LOST')
  })

  it('refuses a nonexistent job without throwing', async () => {
    const { user } = await createWorker({ categoryId })
    const result = await attemptClaim(prisma, { jobId: 'does-not-exist', workerUserId: user.id })
    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('NOT_AVAILABLE')
  })

  it('stops a customer claiming their own job', async () => {
    // Wash-trading guard: posting a job and claiming it yourself would farm
    // points and manufacture fake reputation.
    const selfUser = await createCustomer()
    await createWorker({ email: `self-${Date.now()}@x.com`, categoryId })
    await prisma.workerProfile.create({
      data: {
        userId: selfUser.id, status: 'APPROVED', completedJobs: 20,
        averageRating: 4.9, completionRate: 1, onTimeRate: 1,
      },
    })
    const selfProperty = await createProperty(selfUser.id)
    const job = await createJob({ customerId: selfUser.id, propertyId: selfProperty.id, categoryId })

    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: selfUser.id })

    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('NOT_ELIGIBLE')
  })

  it('refuses a claim from well outside the service radius', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })
    const { user } = await createWorker({ serviceRadiusMiles: 5, categoryId })

    // 60 miles away — far beyond radius + GPS slack.
    const farAway = destinationPoint(NASHVILLE, 90, milesToMeters(60))
    const result = await attemptClaim(prisma, {
      jobId: job.id, workerUserId: user.id, workerLocation: farAway,
    })

    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('OUT_OF_RANGE')
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('POSTED')
  })

  it('allows a claim comfortably inside the radius and records the distance', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })
    const { user } = await createWorker({ serviceRadiusMiles: 15, categoryId })

    const nearby = destinationPoint(NASHVILLE, 45, milesToMeters(3))
    const result = await attemptClaim(prisma, {
      jobId: job.id, workerUserId: user.id, workerLocation: nearby,
    })

    expect(result.outcome).toBe('WON')
    const claim = await prisma.jobClaim.findFirstOrThrow({ where: { jobId: job.id, outcome: 'WON' } })
    expect(claim.distanceMeters).toBeGreaterThan(0)
    expect(claim.distanceMeters!).toBeLessThan(milesToMeters(6))
  })
})

describe('early access fairness', () => {
  it('does not gate an ordinary job for a low-ranked worker', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, isPremium: false })
    const { user } = await createWorker({ points: 0, completedJobs: 50, categoryId })
    expect((await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })).outcome).toBe('WON')
  })

  it('briefly gates a premium job for an established low-ranked worker', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, isPremium: true, postedAt: new Date() })
    const { user } = await createWorker({ points: 0, completedJobs: 50, categoryId })

    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })
    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('EARLY_ACCESS_WINDOW')
  })

  it('exempts brand-new workers from the premium gate entirely', async () => {
    // Newcomers need early wins or they churn in week one (strategy §6).
    const job = await createJob({ customerId, propertyId, categoryId, isPremium: true, postedAt: new Date() })
    const { user } = await createWorker({ points: 0, completedJobs: 2, categoryId })
    expect((await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })).outcome).toBe('WON')
  })

  it('opens a premium job to everyone once the window closes', async () => {
    const job = await createJob({
      customerId, propertyId, categoryId, isPremium: true,
      postedAt: new Date(Date.now() - 11 * 60_000),
    })
    const { user } = await createWorker({ points: 0, completedJobs: 50, categoryId })
    expect((await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })).outcome).toBe('WON')
  })
})

describe('reservation lifecycle', () => {
  it('promotes a reservation to CLAIMED once payment captures', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    expect(await confirmClaimPaid(prisma, job.id, user.id)).toBe(true)

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('CLAIMED')
    expect(after.claimExpiresAt).toBeNull()
    expect(after.claimedByWorkerId).toBe(user.id)
  })

  it('refuses to let a different worker confirm someone else\'s reservation', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const winner = await createWorker({ categoryId })
    const other = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: winner.user.id })

    expect(await confirmClaimPaid(prisma, job.id, other.user.id)).toBe(false)

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.claimedByWorkerId).toBe(winner.user.id)
    expect(after.status).toBe('CLAIM_PENDING_PAYMENT')
  })

  it('returns the job to the pool when payment fails', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    expect(await releaseReservation(prisma, job.id, user.id, 'card_declined')).toBe(true)

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('POSTED')
    expect(after.claimedByWorkerId).toBeNull()
    expect(after.claimedAt).toBeNull()
    expect(after.claimExpiresAt).toBeNull()
  })

  it('lets a different worker claim after a released reservation', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const first = await createWorker({ categoryId })
    const second = await createWorker({ categoryId })

    await attemptClaim(prisma, { jobId: job.id, workerUserId: first.user.id })
    await releaseReservation(prisma, job.id, first.user.id, 'card_declined')

    const result = await attemptClaim(prisma, { jobId: job.id, workerUserId: second.user.id })
    expect(result.outcome).toBe('WON')
  })

  it('is idempotent when a payment webhook is replayed', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    expect(await confirmClaimPaid(prisma, job.id, user.id)).toBe(true)
    // A replayed webhook must not move the job again.
    expect(await confirmClaimPaid(prisma, job.id, user.id)).toBe(false)
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CLAIMED')
  })

  it('cannot release a reservation that already became a real claim', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })
    await confirmClaimPaid(prisma, job.id, user.id)

    expect(await releaseReservation(prisma, job.id, user.id, 'late webhook')).toBe(false)
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CLAIMED')
  })

  it('sweeps an expired reservation back into the pool', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    // Simulate a crashed payment call: the TTL elapses with nothing resolving.
    const swept = await sweepExpiredReservations(
      prisma,
      new Date(Date.now() + (CLAIM_RESERVATION_TTL_SECONDS + 5) * 1000),
    )

    expect(swept).toBe(1)
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('POSTED')
    expect(after.claimedByWorkerId).toBeNull()

    const claim = await prisma.jobClaim.findFirstOrThrow({ where: { jobId: job.id } })
    expect(claim.outcome).toBe('EXPIRED')
  })

  it('does not sweep a reservation that is still within its TTL', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    expect(await sweepExpiredReservations(prisma, new Date())).toBe(0)
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CLAIM_PENDING_PAYMENT')
  })

  it('records a status event for every transition', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })
    await confirmClaimPaid(prisma, job.id, user.id)

    const events = await prisma.jobStatusEvent.findMany({
      where: { jobId: job.id }, orderBy: { createdAt: 'asc' },
    })
    // The audit trail starts at creation, not at the first claim, so a dispute
    // can be reconstructed from the job's entire history.
    expect(events.map((e) => e.toStatus)).toEqual(['POSTED', 'CLAIM_PENDING_PAYMENT', 'CLAIMED'])
    expect(events[0]!.actorType).toBe('CUSTOMER')
    expect(events[1]!.actorType).toBe('WORKER')
    expect(events[2]!.actorType).toBe('SYSTEM')
    // Every transition's `from` must match the previous transition's `to`.
    expect(events[1]!.fromStatus).toBe('POSTED')
    expect(events[2]!.fromStatus).toBe('CLAIM_PENDING_PAYMENT')
  })
})
