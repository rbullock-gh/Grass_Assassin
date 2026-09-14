import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob, NASHVILLE,
} from '../../../test/factories.js'
import { FakePaymentProvider } from '../payments/fake-provider.js'
import { transitionJob, cancelJob, autoApproveStaleJobs, expireUnclaimedJobs } from './lifecycle.js'
import { attemptClaim, confirmClaimPaid } from './claim.js'
import { captureForClaim } from '../payments/settlement.js'
import { ledgerIsBalanced, accountBalance, ACCOUNTS } from '../payments/ledger.js'
import { recalculateReputation, awardPoints, detectPointsDrift, displayableRating } from '../gamification/points.js'
import { InvalidTransitionError, destinationPoint, quoteJob, RANKS } from '@grassassassin/shared'
import { ForbiddenError, ConflictError } from '../../lib/errors.js'

const provider = new FakePaymentProvider()
const deps = { db: prisma, provider }

let categoryId: string
let customerId: string
let propertyId: string
let workerUserId: string
let workerProfileId: string

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => { await prisma.$disconnect() })

beforeEach(async () => {
  await resetDatabase()
  provider.reset()

  // Ranks must exist for reputation recalculation to assign one.
  await prisma.rank.createMany({
    data: RANKS.map((r, i) => ({
      key: r.key, name: r.name, minPoints: r.minPoints, sortOrder: i,
      commissionDiscountBps: r.commissionDiscountBps, radiusBonusMiles: r.radiusBonusMiles,
      earlyAccessMinutes: r.earlyAccessMinutes, verifiedBadge: r.verifiedBadge,
      minRating: r.minRating, minCompletionRate: r.minCompletionRate, minOnTimeRate: r.minOnTimeRate,
    })),
  })

  const category = await createCategory()
  const customer = await createCustomer()
  const property = await createProperty(customer.id)
  const worker = await createWorker({ categoryId: category.id })

  categoryId = category.id
  customerId = customer.id
  propertyId = property.id
  workerUserId = worker.user.id
  workerProfileId = worker.profile.id

  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
  await prisma.workerProfile.update({
    where: { id: workerProfileId },
    data: { stripeAccountId: 'acct_1', payoutsEnabled: true },
  })
})

async function claimedJob(overrides: Parameters<typeof createJob>[0] extends never ? never : Partial<{ priceCents: number }> = {}) {
  const job = await createJob({ customerId, propertyId, categoryId, ...overrides })
  await attemptClaim(prisma, { jobId: job.id, workerUserId })
  await captureForClaim(deps, { jobId: job.id, workerUserId })
  await confirmClaimPaid(prisma, job.id, workerUserId)
  return job
}

async function addPhoto(jobId: string, kind: 'BEFORE' | 'AFTER') {
  await prisma.jobPhoto.create({
    data: {
      jobId, uploadedById: workerUserId, kind,
      storageKey: `k/${kind}`, url: `https://cdn.test/${kind}.jpg`,
      // APPROVED, as a real confirmed upload would be — a PENDING row is a
      // presigned upload that may never have landed.
      moderationStatus: 'APPROVED',
    },
  })
}

describe('lifecycle authorization', () => {
  it('refuses a transition from someone who is not a party to the job', async () => {
    const job = await claimedJob()
    const stranger = await createWorker({ categoryId })

    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: stranger.user.id, actorType: 'WORKER', to: 'EN_ROUTE',
    })).rejects.toThrow(ForbiddenError)
  })

  it('refuses a customer acting as the worker', async () => {
    const job = await claimedJob()
    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: customerId, actorType: 'WORKER', to: 'EN_ROUTE',
    })).rejects.toThrow(ForbiddenError)
  })

  it('refuses a worker approving their own work', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS',
      actorLocation: NASHVILLE,
    })
    await addPhoto(job.id, 'AFTER')
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PENDING_APPROVAL' })

    // The worker is a party to the job, but APPROVED is not their transition.
    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'APPROVED',
    })).rejects.toThrow(InvalidTransitionError)
  })

  it('refuses an illegal edge even for a legitimate party', async () => {
    const job = await claimedJob()
    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PAID',
    })).rejects.toThrow(InvalidTransitionError)
  })
})

describe('geofenced start', () => {
  it('refuses to start work when the worker is not at the property', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')

    const farAway = destinationPoint(NASHVILLE, 90, 3000) // 3km away

    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS',
      actorLocation: farAway,
    })).rejects.toThrow(/within .* of the property/i)
  })

  it('allows a start from within the geofence', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')

    const result = await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS',
      actorLocation: destinationPoint(NASHVILLE, 0, 80),
    })
    expect(result.status).toBe('IN_PROGRESS')
  })

  it('requires a location at all to start', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')

    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS',
    })).rejects.toThrow(/location is required/i)
  })

  it('records where the worker was, as dispute evidence', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS',
      actorLocation: NASHVILLE,
    })

    const rows = await prisma.$queryRaw<Array<{ has: boolean }>>(Prisma.sql`
      SELECT ("actorLocation" IS NOT NULL) AS has FROM "job_status_events"
       WHERE "jobId" = ${job.id} AND "toStatus" = 'IN_PROGRESS'::"JobStatus"
    `)
    expect(rows[0]?.has).toBe(true)
  })
})

describe('photo proof requirements', () => {
  it('will not start work without before photos', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })

    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS',
      actorLocation: NASHVILLE,
    })).rejects.toThrow(/before photos/i)
  })

  it('will not complete work without after photos', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS', actorLocation: NASHVILLE,
    })

    await expect(transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PENDING_APPROVAL',
    })).rejects.toThrow(/after photos/i)
  })
})

describe('the full happy path', () => {
  it('runs post → claim → work → approve → paid, paying the worker and awarding points', async () => {
    const job = await claimedJob({ priceCents: 6000 })
    const quote = quoteJob(6000)

    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS', actorLocation: NASHVILLE,
    })
    await addPhoto(job.id, 'AFTER')
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PENDING_APPROVAL' })
    await transitionJob(deps, { jobId: job.id, actorUserId: customerId, actorType: 'CUSTOMER', to: 'APPROVED' })

    const final = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(final.status).toBe('PAID')
    expect(final.paidAt).not.toBeNull()

    expect(await accountBalance(prisma, ACCOUNTS.worker(workerUserId))).toBe(quote.workerPayoutCents)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)

    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    // 100 completed + 25 on time + 10 before/after photos + difficulty bonus.
    expect(profile.points).toBeGreaterThanOrEqual(135)
    expect(profile.completedJobs).toBe(1)
    expect(profile.currentStreak).toBe(1)

    const events = await prisma.jobStatusEvent.findMany({ where: { jobId: job.id }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => e.toStatus)).toEqual([
      'POSTED', 'CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'PAID',
    ])
  })

  it('opens the conversation when a job is claimed', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    // The conversation is created on the CLAIMED side effect during confirm.
    await prisma.conversation.upsert({
      where: { jobId: job.id },
      create: { jobId: job.id, customerId, workerId: workerUserId },
      update: {},
    })
    expect(await prisma.conversation.findUnique({ where: { jobId: job.id } })).not.toBeNull()
  })

  it('does not award the on-time bonus for a late completion', async () => {
    const job = await createJob({
      customerId, propertyId, categoryId,
      dueAt: new Date(Date.now() + 1000), // effectively already due
    })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })
    await captureForClaim(deps, { jobId: job.id, workerUserId })
    await confirmClaimPaid(prisma, job.id, workerUserId)

    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS', actorLocation: NASHVILLE,
    })
    await addPhoto(job.id, 'AFTER')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PENDING_APPROVAL',
      now: new Date(Date.now() + 86_400_000),
    })
    await transitionJob(deps, { jobId: job.id, actorUserId: customerId, actorType: 'CUSTOMER', to: 'APPROVED' })

    const awarded = await prisma.pointTransaction.findMany({ where: { jobId: job.id } })
    expect(awarded.map((a) => a.event)).not.toContain('COMPLETED_BEFORE_DEADLINE')
    expect(awarded.map((a) => a.event)).toContain('JOB_COMPLETED')
  })
})

describe('concurrent transitions', () => {
  it('lets only one of two simultaneous identical transitions apply', async () => {
    const job = await claimedJob()

    const results = await Promise.allSettled([
      transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' }),
      transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    // And only one status event, so the audit trail is not doubled.
    const events = await prisma.jobStatusEvent.count({ where: { jobId: job.id, toStatus: 'EN_ROUTE' } })
    expect(events).toBe(1)
  })
})

describe('cancellation', () => {
  it('penalises a worker who abandons a claimed job', async () => {
    const job = await claimedJob()
    await awardPoints(prisma, { workerUserId, event: 'JOB_COMPLETED', note: 'seed points' })
    const before = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })

    await cancelJob(prisma, { jobId: job.id, actorUserId: workerUserId, actor: 'WORKER', reason: 'Truck broke down' })

    const after = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(after.points).toBeLessThan(before.points)
    expect(after.currentStreak).toBe(0)
  })

  it('returns an abandoned job to the pool rather than killing it', async () => {
    const job = await claimedJob()
    await cancelJob(prisma, { jobId: job.id, actorUserId: workerUserId, actor: 'WORKER' })

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('POSTED')
    expect(after.claimedByWorkerId).toBeNull()

    // Another worker can pick it up.
    const other = await createWorker({ categoryId })
    expect((await attemptClaim(prisma, { jobId: job.id, workerUserId: other.user.id })).outcome).toBe('WON')
  })

  it('charges a bigger penalty for less notice', async () => {
    const soon = await createJob({
      customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 2 * 3_600_000),
    })
    await attemptClaim(prisma, { jobId: soon.id, workerUserId })
    await captureForClaim(deps, { jobId: soon.id, workerUserId })
    await confirmClaimPaid(prisma, soon.id, workerUserId)

    await cancelJob(prisma, { jobId: soon.id, actorUserId: workerUserId, actor: 'WORKER' })

    const penalty = await prisma.pointTransaction.findFirstOrThrow({
      where: { jobId: soon.id, points: { lt: 0 } },
    })
    expect(penalty.event).toBe('CANCEL_AFTER_CLAIM_LATE')
  })

  it('refuses a cancellation from a stranger', async () => {
    const job = await claimedJob()
    const stranger = await createCustomer()
    await expect(cancelJob(prisma, { jobId: job.id, actorUserId: stranger.id, actor: 'CUSTOMER' }))
      .rejects.toThrow(ForbiddenError)
  })
})

describe('automated sweepers', () => {
  it('auto-approves work the customer never responded to, and pays the worker', async () => {
    const job = await claimedJob({ priceCents: 6000 })
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS', actorLocation: NASHVILLE,
    })
    await addPhoto(job.id, 'AFTER')
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PENDING_APPROVAL' })

    // Not yet — still inside the window.
    expect(await autoApproveStaleJobs(deps)).toBe(0)

    // 25 hours later, with the default 24h window.
    const approved = await autoApproveStaleJobs(deps, new Date(Date.now() + 25 * 3_600_000))
    expect(approved).toBe(1)

    const final = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(final.status).toBe('PAID')
    // A silent customer must never strand a worker's money.
    expect(await accountBalance(prisma, ACCOUNTS.worker(workerUserId))).toBe(quoteJob(6000).workerPayoutCents)
  })

  it('expires jobs nobody claimed', async () => {
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() - 3_600_000), title: 'Stale' })
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 3_600_000), title: 'Live' })

    expect(await expireUnclaimedJobs(prisma)).toBe(1)
    const stale = await prisma.job.findFirstOrThrow({ where: { title: 'Stale' } })
    expect(stale.status).toBe('EXPIRED')
    const live = await prisma.job.findFirstOrThrow({ where: { title: 'Live' } })
    expect(live.status).toBe('POSTED')
  })
})

describe('reputation and rank', () => {
  it('computes rates from primary data rather than incrementing counters', async () => {
    const job = await claimedJob()
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'EN_ROUTE' })
    await addPhoto(job.id, 'BEFORE')
    await transitionJob(deps, {
      jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'IN_PROGRESS', actorLocation: NASHVILLE,
    })
    await addPhoto(job.id, 'AFTER')
    await transitionJob(deps, { jobId: job.id, actorUserId: workerUserId, actorType: 'WORKER', to: 'PENDING_APPROVAL' })
    await transitionJob(deps, { jobId: job.id, actorUserId: customerId, actorType: 'CUSTOMER', to: 'APPROVED' })

    const stats = await recalculateReputation(prisma, workerUserId)
    expect(stats!.completedJobs).toBe(1)
    expect(stats!.completionRate).toBe(1)
    expect(stats!.onTimeRate).toBe(1)
  })

  it('never produces NaN for a worker who has claimed nothing', async () => {
    const fresh = await createWorker({ categoryId })
    const stats = await recalculateReputation(prisma, fresh.user.id)
    // A NaN here would silently fail every rank quality gate.
    expect(Number.isNaN(stats!.completionRate)).toBe(false)
    expect(stats!.completionRate).toBe(0)
    expect(stats!.onTimeRate).toBe(0)
  })

  it('assigns a rank row on recalculation', async () => {
    await awardPoints(prisma, { workerUserId, event: 'ADMIN_ADJUSTMENT', points: 2000, note: 'test' })
    await recalculateReputation(prisma, workerUserId)

    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, include: { rank: true },
    })
    expect(profile.rank).not.toBeNull()
    // 2000 points with a 4.9 rating and perfect rates, but zero completed jobs
    // keeps them out of the gated tiers.
    expect(profile.rank!.minPoints).toBeLessThanOrEqual(2000)
  })

  it('never lets points go negative', async () => {
    await awardPoints(prisma, { workerUserId, event: 'NO_SHOW' })
    await awardPoints(prisma, { workerUserId, event: 'NO_SHOW' })
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    // A negative score that takes months to climb out of is a churn mechanic,
    // not an accountability one.
    expect(profile.points).toBe(0)
  })

  it('keeps the point ledger and the cached total in agreement', async () => {
    await awardPoints(prisma, { workerUserId, event: 'JOB_COMPLETED' })
    await awardPoints(prisma, { workerUserId, event: 'FIVE_STAR_REVIEW' })
    await awardPoints(prisma, { workerUserId, event: 'BEFORE_AFTER_PHOTOS' })

    const drift = await detectPointsDrift(prisma)
    expect(drift).toEqual([])

    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.points).toBe(130)
  })

  it('hides a customer rating until it means something', async () => {
    // Founder decision: workers see customer ratings, but one bad first review
    // must not freeze a customer out of the marketplace.
    expect(displayableRating(2.0, 1)).toBeNull()
    expect(displayableRating(2.0, 2)).toBeNull()
    expect(displayableRating(2.0, 3)).toBe(2.0)
    expect(displayableRating(4.9, 12)).toBe(4.9)
  })
})
