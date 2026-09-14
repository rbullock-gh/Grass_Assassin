import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob, NASHVILLE,
} from '../../../test/factories.js'
import { InMemoryQueue, SCHEDULES } from './queue.js'
import { registerHandlers, registerSchedules, onJobPosted, onDeadlineReminder, onSweepAutoApprove, onSweepExpireJobs, onRecomputeLeaderboards, onGenerateRecurringJobs } from './handlers.js'
import { Notifier, RecordingPushSender, isQuietHours, mayDeliverNow, MAX_JOB_MATCH_PUSHES_PER_DAY } from '../notifications/notifier.js'
import { FakePaymentProvider } from '../payments/fake-provider.js'
import { captureForClaim } from '../payments/settlement.js'
import { attemptClaim, confirmClaimPaid } from '../jobs/claim.js'
import { transitionJob } from '../jobs/lifecycle.js'
import { destinationPoint, milesToMeters, RANKS } from '@grassassassin/shared'
import { awardPoints } from '../gamification/points.js'

const provider = new FakePaymentProvider()
const push = new RecordingPushSender()
const queue = new InMemoryQueue()
const notifier = new Notifier(prisma, push)
const deps = { db: prisma, provider, queue, notifier }

let categoryId: string
let customerId: string
let propertyId: string

beforeAll(async () => {
  await prisma.$connect()
  registerHandlers(deps)
})
afterAll(async () => { await prisma.$disconnect() })

beforeEach(async () => {
  await resetDatabase()
  provider.reset()
  push.reset()
  queue.reset()

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
  categoryId = category.id
  customerId = customer.id
  propertyId = property.id

  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
})

async function workerWithDevice(overrides: Parameters<typeof createWorker>[0] = {}) {
  const worker = await createWorker({ categoryId, ...overrides })
  await prisma.device.create({
    data: { userId: worker.user.id, pushToken: `ExponentPushToken[${worker.user.id}]`, platform: 'ios' },
  })
  await prisma.workerProfile.update({
    where: { id: worker.profile.id },
    data: { stripeAccountId: `acct_${worker.profile.id}`, payoutsEnabled: true },
  })
  return worker
}

// Mid-morning US Central, comfortably outside quiet hours.
const DAYTIME = new Date('2026-06-15T16:00:00Z')

describe('quiet hours', () => {
  it('treats 3am local as quiet and 2pm local as not', () => {
    // tzOffset 360 is US Central.
    expect(isQuietHours(new Date('2026-06-15T09:00:00Z'), 360)).toBe(true)  // 3am
    expect(isQuietHours(new Date('2026-06-15T20:00:00Z'), 360)).toBe(false) // 2pm
    expect(isQuietHours(new Date('2026-06-16T04:00:00Z'), 360)).toBe(true)  // 11pm
  })

  it('suppresses a job-match push at 3am but not a message on an active job', () => {
    const night = new Date('2026-06-15T09:00:00Z')
    // A 3am job alert is how a worker turns notifications off permanently.
    expect(mayDeliverNow('JOB_MATCH', night, 360)).toBe(false)
    // But something happening on a job they are working on is different.
    expect(mayDeliverNow('NEW_MESSAGE', night, 360)).toBe(true)
    expect(mayDeliverNow('WORKER_EN_ROUTE', night, 360)).toBe(true)
  })

  it('records a suppressed notification rather than dropping it silently', async () => {
    const worker = await workerWithDevice()
    const delivered = await notifier.notify({
      userId: worker.user.id, type: 'JOB_MATCH', title: 'x', body: 'y',
      now: new Date('2026-06-15T09:00:00Z'),
    })

    expect(delivered).toBe(false)
    expect(push.sent).toHaveLength(0)
    // "We decided not to send" and "we never tried" are different facts.
    const record = await prisma.notification.findFirstOrThrow({ where: { userId: worker.user.id } })
    expect(record.sentAt).toBeNull()
    expect(record.failureReason).toMatch(/quiet hours/i)
  })
})

describe('job-match notifications', () => {
  it('notifies a nearby qualified worker when a job is posted', async () => {
    const worker = await workerWithDevice({ baseLocation: NASHVILLE, serviceRadiusMiles: 15 })
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 8500 })

    const delivered = await onJobPosted(deps, job.id)

    expect(delivered).toBe(1)
    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.title).toContain('$85')
    expect(push.sent[0]!.body).toMatch(/you earn \$74\.80/)
    expect(push.sent[0]!.data?.['jobId']).toBe(job.id)
    void worker
  })

  it('does not notify a worker outside their own service radius', async () => {
    await workerWithDevice({
      baseLocation: destinationPoint(NASHVILLE, 0, milesToMeters(40)),
      serviceRadiusMiles: 10,
    })
    const job = await createJob({ customerId, propertyId, categoryId })

    expect(await onJobPosted(deps, job.id)).toBe(0)
    expect(push.sent).toHaveLength(0)
  })

  it('does not notify a worker who does not offer that category', async () => {
    const other = await createCategory({ slug: `other-${Date.now()}` })
    await workerWithDevice({ baseLocation: NASHVILLE, categoryId: other.id })
    const job = await createJob({ customerId, propertyId, categoryId })

    expect(await onJobPosted(deps, job.id)).toBe(0)
  })

  it('never tells someone about their own posted job', async () => {
    // A dual-role user posting a job must not get a push about it.
    const dual = await createCustomer()
    await prisma.workerProfile.create({
      data: {
        userId: dual.id, status: 'APPROVED', completedJobs: 20,
        averageRating: 4.9, completionRate: 1, onTimeRate: 1,
      },
    })
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { userId: dual.id } })
    await prisma.workerService.create({ data: { workerProfileId: profile.id, categoryId } })
    await prisma.device.create({ data: { userId: dual.id, pushToken: 'tok-dual', platform: 'ios' } })
    await prisma.$executeRawUnsafe(
      `UPDATE worker_profiles SET "baseLocation" = ST_SetSRID(ST_MakePoint($1,$2),4326)::geography WHERE id = $3`,
      NASHVILLE.lng, NASHVILLE.lat, profile.id,
    )

    const ownProperty = await createProperty(dual.id)
    const job = await createJob({ customerId: dual.id, propertyId: ownProperty.id, categoryId })

    expect(await onJobPosted(deps, job.id)).toBe(0)
  })

  it('caps how many job-match pushes one worker gets per day', async () => {
    // A busy Saturday in a dense market would otherwise send forty buzzes and
    // the worker mutes the app — costing us far more than the jobs they missed.
    const worker = await workerWithDevice({ baseLocation: NASHVILLE, serviceRadiusMiles: 20 })

    for (let i = 0; i < MAX_JOB_MATCH_PUSHES_PER_DAY + 4; i++) {
      const job = await createJob({ customerId, propertyId, categoryId, title: `Job ${i}` })
      await onJobPosted(deps, job.id)
    }

    expect(push.sent.length).toBe(MAX_JOB_MATCH_PUSHES_PER_DAY)

    const suppressed = await prisma.notification.count({
      where: { userId: worker.user.id, failureReason: { contains: 'cap' } },
    })
    expect(suppressed).toBe(4)
  })

  it('schedules deadline reminders when the job is posted', async () => {
    await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({
      customerId, propertyId, categoryId,
      dueAt: new Date(Date.now() + 48 * 3_600_000),
    })

    await onJobPosted(deps, job.id)

    // Both the 24-hour and 3-hour reminders are in the future for a 48h job.
    expect(queue.countEnqueued('notify.deadline-reminder')).toBe(2)
  })

  it('does not schedule a reminder that would already be in the past', async () => {
    await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({
      customerId, propertyId, categoryId,
      dueAt: new Date(Date.now() + 2 * 3_600_000), // only 2 hours out
    })

    await onJobPosted(deps, job.id)

    // Neither a 24h nor a 3h warning fits, so neither is scheduled.
    expect(queue.countEnqueued('notify.deadline-reminder')).toBe(0)
  })

  it('ignores a job that is no longer POSTED', async () => {
    await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({ customerId, propertyId, categoryId, status: 'DRAFT' })
    expect(await onJobPosted(deps, job.id)).toBe(0)
  })
})

describe('deadline reminders', () => {
  it('reminds the assigned worker', async () => {
    const worker = await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: worker.user.id })
    await captureForClaim(deps, { jobId: job.id, workerUserId: worker.user.id })
    await confirmClaimPaid(prisma, job.id, worker.user.id)

    const sent = await onDeadlineReminder(deps, { jobId: job.id, hoursBefore: 3 })

    expect(sent).toBe(true)
    expect(push.sent.at(-1)!.title).toMatch(/due in 3 hours/i)
  })

  it('does not remind about a job that is already complete', async () => {
    // Buzzing someone about work they finished is how an app earns a mute.
    const worker = await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: worker.user.id })
    await captureForClaim(deps, { jobId: job.id, workerUserId: worker.user.id })
    await confirmClaimPaid(prisma, job.id, worker.user.id)
    await prisma.job.update({ where: { id: job.id }, data: { status: 'PAID' } })

    expect(await onDeadlineReminder(deps, { jobId: job.id, hoursBefore: 3 })).toBe(false)
  })

  it('does not remind about an unclaimed job', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    expect(await onDeadlineReminder(deps, { jobId: job.id, hoursBefore: 24 })).toBe(false)
  })

  it('wakes a worker for a 3-hour warning but not a 24-hour one', async () => {
    const worker = await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: worker.user.id })
    await captureForClaim(deps, { jobId: job.id, workerUserId: worker.user.id })
    await confirmClaimPaid(prisma, job.id, worker.user.id)

    const night = new Date('2026-06-15T09:00:00Z')
    // A deadline they are about to miss is worth waking them for.
    await prisma.notification.deleteMany({})
    const urgent = await notifier.notify({
      userId: worker.user.id, type: 'DEADLINE_REMINDER',
      title: 'due soon', body: 'x', force: true, now: night,
    })
    expect(urgent).toBe(true)

    const notUrgent = await notifier.notify({
      userId: worker.user.id, type: 'DEADLINE_REMINDER',
      title: 'due tomorrow', body: 'x', now: night,
    })
    expect(notUrgent).toBe(false)
  })
})

describe('sweeps', () => {
  it('warns the customer before auto-approving, and only once', async () => {
    const worker = await workerWithDevice({ baseLocation: NASHVILLE })
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: worker.user.id })
    await captureForClaim(deps, { jobId: job.id, workerUserId: worker.user.id })
    await confirmClaimPaid(prisma, job.id, worker.user.id)
    await transitionJob(deps, { jobId: job.id, actorUserId: worker.user.id, actorType: 'WORKER', to: 'EN_ROUTE' })
    await prisma.jobPhoto.create({
      data: { jobId: job.id, uploadedById: worker.user.id, kind: 'BEFORE', storageKey: 'b', url: 'u', moderationStatus: 'APPROVED' },
    })
    await transitionJob(deps, {
      jobId: job.id, actorUserId: worker.user.id, actorType: 'WORKER', to: 'IN_PROGRESS',
      actorLocation: NASHVILLE,
    })
    await prisma.jobPhoto.create({
      data: { jobId: job.id, uploadedById: worker.user.id, kind: 'AFTER', storageKey: 'a', url: 'u', moderationStatus: 'APPROVED' },
    })
    await transitionJob(deps, { jobId: job.id, actorUserId: worker.user.id, actorType: 'WORKER', to: 'PENDING_APPROVAL' })

    // Move completion back past the warning threshold.
    await prisma.job.update({
      where: { id: job.id }, data: { completedAt: new Date(Date.now() - 21 * 3_600_000) },
    })

    await onSweepAutoApprove(deps)
    await onSweepAutoApprove(deps)
    await onSweepAutoApprove(deps)

    // Deduped: a sweep running every ten minutes must not warn the same
    // customer six times an hour.
    expect(queue.countEnqueued('notify.approval-reminder')).toBe(1)
  })

  it('tells a customer their job expired unclaimed, with something actionable', async () => {
    await prisma.device.create({ data: { userId: customerId, pushToken: 'tok-cust', platform: 'ios' } })
    await createJob({
      customerId, propertyId, categoryId,
      dueAt: new Date(Date.now() - 3_600_000), title: 'Stale',
    })

    const expired = await onSweepExpireJobs(deps)

    expect(expired).toBe(1)
    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.body).toMatch(/higher price/i)
  })
})

describe('leaderboards', () => {
  it('materializes boards and ranks by points', async () => {
    const top = await workerWithDevice({ email: `lb1-${Date.now()}@x.com` })
    const mid = await workerWithDevice({ email: `lb2-${Date.now()}@x.com` })
    await awardPoints(prisma, { workerUserId: top.user.id, event: 'ADMIN_ADJUSTMENT', points: 5000, note: 't' })
    await awardPoints(prisma, { workerUserId: mid.user.id, event: 'ADMIN_ADJUSTMENT', points: 1200, note: 't' })

    const written = await onRecomputeLeaderboards(deps)
    expect(written).toBeGreaterThan(0)

    const board = await prisma.leaderboard.findFirstOrThrow({
      where: { scope: 'CITY', period: 'ALL_TIME' },
      include: { entries: { orderBy: { rank: 'asc' } } },
    })
    expect(board.entries[0]!.workerProfileId).toBe(top.profile.id)
    expect(board.entries[0]!.rank).toBe(1)
    expect(board.entries[1]!.workerProfileId).toBe(mid.profile.id)
  })

  it('replaces entries rather than accumulating stale ranks', async () => {
    const worker = await workerWithDevice()
    await awardPoints(prisma, { workerUserId: worker.user.id, event: 'ADMIN_ADJUSTMENT', points: 900, note: 't' })

    await onRecomputeLeaderboards(deps)
    const firstEntries = await prisma.leaderboardEntry.count()
    const firstBoards = await prisma.leaderboard.count()

    await onRecomputeLeaderboards(deps)
    await onRecomputeLeaderboards(deps)

    // Recomputing must not double the rows, or a worker appears twice.
    expect(await prisma.leaderboardEntry.count()).toBe(firstEntries)
    // And it must not create a new BOARD each time. With a rolling periodStart
    // this produced a fresh set of boards on every run — 96 a day at the
    // configured cadence.
    expect(await prisma.leaderboard.count()).toBe(firstBoards)
  })

  it('keeps a weekly board stable through the week and rolls it over after', async () => {
    const worker = await workerWithDevice()
    await awardPoints(prisma, { workerUserId: worker.user.id, event: 'ADMIN_ADJUSTMENT', points: 900, note: 't' })
    await onRecomputeLeaderboards(deps)

    const weekly = await prisma.leaderboard.findFirstOrThrow({
      where: { scope: 'CITY', period: 'WEEKLY' },
    })
    // Monday-anchored, so the same board is reused all week.
    expect(weekly.periodStart.getUTCDay()).toBe(1)
    expect(weekly.periodEnd.getTime() - weekly.periodStart.getTime()).toBe(7 * 86_400_000)
  })

  it('puts newcomers in the rookie bracket so they can actually place', async () => {
    const veteran = await workerWithDevice({ email: `vet-${Date.now()}@x.com`, completedJobs: 200 })
    const rookie = await workerWithDevice({ email: `rook-${Date.now()}@x.com`, completedJobs: 3 })
    await awardPoints(prisma, { workerUserId: veteran.user.id, event: 'ADMIN_ADJUSTMENT', points: 50_000, note: 't' })
    await awardPoints(prisma, { workerUserId: rookie.user.id, event: 'ADMIN_ADJUSTMENT', points: 300, note: 't' })

    await onRecomputeLeaderboards(deps)

    const rookieBoard = await prisma.leaderboard.findFirstOrThrow({
      where: { scope: 'ROOKIE', period: 'ALL_TIME' },
      include: { entries: { orderBy: { rank: 'asc' } } },
    })
    // A board you cannot place on is a board you stop opening.
    expect(rookieBoard.entries).toHaveLength(1)
    expect(rookieBoard.entries[0]!.workerProfileId).toBe(rookie.profile.id)
  })
})

describe('recurring jobs', () => {
  async function createRecurring(nextRunAt: Date) {
    return prisma.recurringJob.create({
      data: {
        customerId, propertyId, categoryId,
        interval: 'BIWEEKLY', priceCents: 6000, active: true, nextRunAt,
      },
    })
  }

  it('generates the next job when one is due', async () => {
    const recurring = await createRecurring(new Date(Date.now() - 3_600_000))

    expect(await onGenerateRecurringJobs(deps)).toBe(1)

    const generated = await prisma.job.findFirstOrThrow({ where: { recurringJobId: recurring.id } })
    expect(generated.status).toBe('POSTED')
    expect(generated.priceCents).toBe(6000)

    const after = await prisma.recurringJob.findUniqueOrThrow({ where: { id: recurring.id } })
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now())
    expect(after.lastRunAt).not.toBeNull()
  })

  it('does not generate one that is not due yet', async () => {
    await createRecurring(new Date(Date.now() + 7 * 86_400_000))
    expect(await onGenerateRecurringJobs(deps)).toBe(0)
  })

  it('NEVER double-generates when two sweeps run concurrently', async () => {
    // Recurring conversion is the highest-leverage thing in the product, so
    // this path must be reliable — and charging a customer twice for one
    // scheduled mow would be unforgivable.
    await createRecurring(new Date(Date.now() - 3_600_000))

    const results = await Promise.all([
      onGenerateRecurringJobs(deps),
      onGenerateRecurringJobs(deps),
      onGenerateRecurringJobs(deps),
    ])

    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(await prisma.job.count({ where: { recurringJobId: { not: null } } })).toBe(1)
  })

  it('skips a paused subscription', async () => {
    const recurring = await createRecurring(new Date(Date.now() - 3_600_000))
    await prisma.recurringJob.update({
      where: { id: recurring.id },
      data: { pausedUntil: new Date(Date.now() + 30 * 86_400_000) },
    })
    expect(await onGenerateRecurringJobs(deps)).toBe(0)
  })

  it('skips an inactive subscription', async () => {
    const recurring = await createRecurring(new Date(Date.now() - 3_600_000))
    await prisma.recurringJob.update({ where: { id: recurring.id }, data: { active: false } })
    expect(await onGenerateRecurringJobs(deps)).toBe(0)
  })

  it('advances by the configured interval', async () => {
    const runAt = new Date(Date.now() - 3_600_000)
    const recurring = await createRecurring(runAt)
    await onGenerateRecurringJobs(deps)

    const after = await prisma.recurringJob.findUniqueOrThrow({ where: { id: recurring.id } })
    const days = (after.nextRunAt.getTime() - runAt.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(14)
  })

  it('queues a job-match notification for the generated job', async () => {
    await createRecurring(new Date(Date.now() - 3_600_000))
    await onGenerateRecurringJobs(deps)
    expect(queue.countEnqueued('notify.job-posted')).toBe(1)
  })
})

describe('the schedule table', () => {
  it('registers every recurring job', async () => {
    queue.reset()
    await registerSchedules(queue)
    expect(queue.scheduled).toHaveLength(Object.keys(SCHEDULES).length)
  })

  it('sweeps money-affecting work more often than display-only work', async () => {
    // Releasing a stuck claim matters in minutes; a leaderboard being fifteen
    // minutes stale harms nobody.
    const minuteField = (cron: string) => cron.split(' ')[0]!
    expect(minuteField(SCHEDULES['expiredClaims']!.cron)).toBe('*/1')
    expect(minuteField(SCHEDULES['leaderboards']!.cron)).toBe('*/15')
  })
})

describe('the in-memory queue itself', () => {
  it('runs a delayed job only once its time arrives', async () => {
    const q = new InMemoryQueue()
    let ran = 0
    q.on('sweep.expired-claims', async () => { ran += 1 })

    await q.enqueue('sweep.expired-claims', {}, { delayMs: 60_000 })
    await q.runDue(Date.now())
    expect(ran).toBe(0)

    await q.runDue(Date.now() + 61_000)
    expect(ran).toBe(1)
  })

  it('deduplicates by key while a job is still pending', async () => {
    const q = new InMemoryQueue()
    await q.enqueue('notify.job-posted', { jobId: 'j1' }, { dedupeKey: 'posted:j1' })
    await q.enqueue('notify.job-posted', { jobId: 'j1' }, { dedupeKey: 'posted:j1' })
    await q.enqueue('notify.job-posted', { jobId: 'j2' }, { dedupeKey: 'posted:j2' })

    expect(q.pendingCount('notify.job-posted')).toBe(2)
  })

  it('releases a dedupe key once the job has run', async () => {
    const q = new InMemoryQueue()
    q.on('notify.job-posted', async () => undefined)

    await q.enqueue('notify.job-posted', { jobId: 'j1' }, { dedupeKey: 'k' })
    await q.runDue()
    await q.enqueue('notify.job-posted', { jobId: 'j1' }, { dedupeKey: 'k' })

    expect(q.pendingCount()).toBe(1)
  })

  it('keeps draining after a handler throws', async () => {
    // In production each job retries independently; a batch that stops at the
    // first error would strand everything behind it.
    const q = new InMemoryQueue()
    let ran = 0
    q.on('sweep.expired-claims', async () => { throw new Error('boom') })
    q.on('sweep.expired-claims', async () => { ran += 1 })

    await q.enqueue('sweep.expired-claims', {})
    await expect(q.runDue()).resolves.toBe(1)
    expect(ran).toBe(1)
  })
})
