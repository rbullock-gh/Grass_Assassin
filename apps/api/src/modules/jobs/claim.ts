import { Prisma } from '@prisma/client'
import type { Db } from '../../lib/prisma.js'
import {
  ACTIVE_CLAIM_STATUSES,
  canSeeDuringEarlyAccess,
  resolveRank,
  RANKS,
  haversineMeters,
  milesToMeters,
  type LatLng,
} from '@grassassassin/shared'

/**
 * Job claiming — single-winner semantics.
 *
 * This is the most contended write in the product and the one most likely to be
 * implemented wrong. The requirement is absolute: when N workers tap CLAIM on
 * the same job at the same instant, exactly one succeeds.
 *
 * WHY THE OBVIOUS IMPLEMENTATION IS BROKEN
 *
 *   const job = await db.job.findUnique({ where: { id } })
 *   if (job.status === 'POSTED') {
 *     await db.job.update({ where: { id }, data: { status: 'CLAIMED', workerId } })
 *   }
 *
 * Both requests read POSTED before either writes. Both pass the guard. Both
 * write. Two workers are told they won. Under READ COMMITTED — Postgres's
 * default — this is not a rare interleaving; it happens readily under load.
 *
 * WHAT WE DO INSTEAD
 *
 * A single conditional UPDATE whose WHERE clause contains the guard:
 *
 *   UPDATE jobs SET status = 'CLAIM_PENDING_PAYMENT', ...
 *    WHERE id = $1 AND status = 'POSTED'
 *
 * Read and write become one atomic statement. Postgres takes a row lock for its
 * duration; a concurrent transaction blocks, and on release re-evaluates the
 * predicate against the *updated* row (EvalPlanQual), finds the status is no
 * longer POSTED, and matches zero rows. Exactly one caller gets a row back.
 * There is no race window — not a narrow one, none.
 *
 * WHY NOT THE ALTERNATIVES
 *  · SELECT ... FOR UPDATE then UPDATE — correct, but two round trips and a
 *    longer lock hold for no benefit here.
 *  · SERIALIZABLE isolation — correct, but converts contention into commit-time
 *    serialization failures the application must detect and retry, and costs
 *    throughput across every other transaction in the system.
 *  · A Redis distributed lock — introduces a second source of truth that can
 *    disagree with the database. Never add a distributed lock to solve a
 *    problem one SQL statement already solves.
 *
 * WHY THE RESERVATION IS TWO-PHASE
 *
 * The winner lands in CLAIM_PENDING_PAYMENT, not CLAIMED. Payment is a fallible
 * network call to Stripe and must not happen while holding a row lock. The
 * reservation gives the winner an exclusive, time-boxed right to attempt
 * payment; on success the job becomes CLAIMED, on failure or TTL expiry a
 * sweeper returns it to POSTED. The concurrency primitive and the fallible side
 * effect are thereby separated.
 */

export const CLAIM_RESERVATION_TTL_SECONDS = 90

export type ClaimFailureReason =
  | 'ALREADY_CLAIMED'
  | 'NOT_AVAILABLE'
  | 'NOT_ELIGIBLE'
  | 'OUT_OF_RANGE'
  | 'WORKER_NOT_APPROVED'
  | 'TOO_MANY_ACTIVE_JOBS'
  | 'EARLY_ACCESS_WINDOW'
  | 'PAYMENT_FAILED'

export type ClaimResult =
  | { outcome: 'WON'; jobId: string; claimId: string; expiresAt: Date }
  | { outcome: 'LOST'; jobId: string; reason: ClaimFailureReason; message: string }

const FAILURE_MESSAGES: Record<ClaimFailureReason, string> = {
  ALREADY_CLAIMED: 'Another pro claimed this job first.',
  NOT_AVAILABLE: 'This job is no longer available.',
  NOT_ELIGIBLE: 'You are not eligible to claim this job.',
  OUT_OF_RANGE: 'This job is outside your service area.',
  WORKER_NOT_APPROVED: 'Finish your onboarding before claiming jobs.',
  TOO_MANY_ACTIVE_JOBS: 'Finish one of your active jobs before claiming another.',
  EARLY_ACCESS_WINDOW: 'This job opens to all pros in a few minutes.',
  PAYMENT_FAILED: 'We could not charge the customer. The job has been released.',
}

function lost(jobId: string, reason: ClaimFailureReason): ClaimResult {
  return { outcome: 'LOST', jobId, reason, message: FAILURE_MESSAGES[reason] }
}

export interface ClaimContext {
  jobId: string
  workerUserId: string
  /** Worker's device location at claim time, if permission was granted. */
  workerLocation?: LatLng
  /** Injected so tests are deterministic. */
  now?: Date
}

/**
 * Attempts to reserve a job for a worker.
 *
 * Eligibility is checked *before* the atomic reservation, deliberately: those
 * checks are reads against the worker's own rows and do not need to be
 * serialized with other workers' claims. Only the reservation itself must be
 * atomic, and keeping it to one statement keeps the lock hold minimal — which
 * is what lets this scale under contention.
 */
export async function attemptClaim(db: Db, ctx: ClaimContext): Promise<ClaimResult> {
  const now = ctx.now ?? new Date()
  const { jobId, workerUserId } = ctx

  const worker = await db.workerProfile.findUnique({
    where: { userId: workerUserId },
    select: {
      id: true, status: true, serviceRadiusMiles: true, points: true,
      averageRating: true, completionRate: true, onTimeRate: true,
      completedJobs: true, maxActiveJobs: true,
      user: { select: { status: true } },
    },
  })

  if (!worker || worker.status !== 'APPROVED' || worker.user.status !== 'ACTIVE') {
    await recordAttempt(db, jobId, workerUserId, 'LOST_NOT_ELIGIBLE', null)
    return lost(jobId, 'WORKER_NOT_APPROVED')
  }

  // Cap in-flight work. A worker holding ten simultaneous jobs is either gaming
  // the map or about to no-show on most of them; both are bad for customers.
  const activeCount = await db.job.count({
    where: {
      claimedByWorkerId: workerUserId,
      status: { in: ACTIVE_CLAIM_STATUSES as unknown as Prisma.EnumJobStatusFilter['in'] },
    },
  })
  if (activeCount >= worker.maxActiveJobs) {
    await recordAttempt(db, jobId, workerUserId, 'LOST_NOT_ELIGIBLE', null)
    return lost(jobId, 'TOO_MANY_ACTIVE_JOBS')
  }

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true, status: true, customerId: true, categoryId: true,
      isPremium: true, postedAt: true, dueAt: true,
    },
  })
  if (!job) return lost(jobId, 'NOT_AVAILABLE')
  if (job.status !== 'POSTED') {
    await recordAttempt(db, jobId, workerUserId, 'LOST_ALREADY_CLAIMED', null)
    // Distinguish "someone beat you to it" from "this job is gone". Telling a
    // worker another pro claimed a job the customer actually cancelled is a
    // small lie that erodes trust in the map.
    const goneForGood: readonly string[] = ['CANCELLED', 'EXPIRED', 'CLOSED', 'DRAFT']
    return lost(jobId, goneForGood.includes(job.status) ? 'NOT_AVAILABLE' : 'ALREADY_CLAIMED')
  }
  if (job.dueAt <= now) return lost(jobId, 'NOT_AVAILABLE')

  // Nobody claims their own job — that is either confusion or wash-trading.
  if (job.customerId === workerUserId) {
    return lost(jobId, 'NOT_ELIGIBLE')
  }

  // Early access applies only to premium jobs, for at most 10 minutes, and never
  // to a worker's first 10 jobs (docs/00-strategy.md §6).
  const rank = resolveRank({
    points: worker.points,
    averageRating: worker.averageRating,
    completionRate: worker.completionRate,
    onTimeRate: worker.onTimeRate,
    completedJobs: worker.completedJobs,
  }, RANKS)

  const secondsSincePosted = job.postedAt
    ? (now.getTime() - job.postedAt.getTime()) / 1000
    : Number.MAX_SAFE_INTEGER

  if (!canSeeDuringEarlyAccess({
    isPremiumJob: job.isPremium,
    secondsSincePosted,
    rank,
    completedJobs: worker.completedJobs,
  })) {
    return lost(jobId, 'EARLY_ACCESS_WINDOW')
  }

  let distanceMeters: number | null = null
  if (ctx.workerLocation) {
    const exact = await db.$queryRaw<Array<{ lat: number; lng: number }>>(Prisma.sql`
      SELECT ST_Y("approxLocation"::geometry) AS lat, ST_X("approxLocation"::geometry) AS lng
        FROM "jobs" WHERE "id" = ${jobId}
    `)
    const point = exact[0]
    if (point) {
      distanceMeters = haversineMeters(ctx.workerLocation, { lat: point.lat, lng: point.lng })
      // Generous slack over the stated radius: GPS drift and the privacy offset
      // both add noise, and rejecting a legitimate claim is worse than allowing
      // a marginally distant one.
      const allowed = milesToMeters(worker.serviceRadiusMiles + rank.radiusBonusMiles) + 2000
      if (distanceMeters > allowed) {
        await recordAttempt(db, jobId, workerUserId, 'LOST_NOT_ELIGIBLE', distanceMeters)
        return lost(jobId, 'OUT_OF_RANGE')
      }
    }
  }

  const expiresAt = new Date(now.getTime() + CLAIM_RESERVATION_TTL_SECONDS * 1000)

  // ---------------------------------------------------------------------
  // THE ATOMIC RESERVATION
  //
  // One statement. The `status = 'POSTED'` predicate is the lock. Exactly one
  // concurrent caller can match a row here; every other caller matches zero.
  // ---------------------------------------------------------------------
  const claimed = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "jobs"
       SET "status"              = 'CLAIM_PENDING_PAYMENT'::"JobStatus",
           "claimedByWorkerId"   = ${workerUserId},
           "claimedAt"           = ${now},
           "claimExpiresAt"      = ${expiresAt},
           "updatedAt"           = ${now}
     WHERE "id"     = ${jobId}
       AND "status" = 'POSTED'::"JobStatus"
    RETURNING "id"
  `)

  if (claimed.length === 0) {
    // Someone else won the race in the microseconds since our read. This is the
    // expected, correct outcome for every loser — not an error.
    await recordAttempt(db, jobId, workerUserId, 'LOST_ALREADY_CLAIMED', distanceMeters)
    return lost(jobId, 'ALREADY_CLAIMED')
  }

  const claim = await db.jobClaim.create({
    data: {
      jobId, workerId: workerUserId, outcome: 'WON',
      distanceMeters, attemptedAt: now, resolvedAt: now,
    },
    select: { id: true },
  })

  await db.jobStatusEvent.create({
    data: {
      jobId, fromStatus: 'POSTED', toStatus: 'CLAIM_PENDING_PAYMENT',
      actorId: workerUserId, actorType: 'WORKER', note: 'Claim reserved, awaiting payment capture',
    },
  })

  return { outcome: 'WON', jobId, claimId: claim.id, expiresAt }
}

/** Losing attempts are recorded for contention analytics, never surfaced as errors. */
async function recordAttempt(
  db: Db,
  jobId: string,
  workerId: string,
  outcome: 'LOST_ALREADY_CLAIMED' | 'LOST_NOT_ELIGIBLE' | 'LOST_PAYMENT_FAILED',
  distanceMeters: number | null,
): Promise<void> {
  try {
    await db.jobClaim.create({
      data: { jobId, workerId, outcome, distanceMeters, resolvedAt: new Date() },
    })
  } catch {
    // Analytics must never fail a request. A dropped loser row costs a data
    // point; a thrown error costs the worker their next claim.
  }
}

/**
 * Promotes a reservation to a real claim once payment is captured.
 *
 * Guarded on both status and worker id so a late or duplicated call from a
 * different worker's flow cannot hijack the job.
 */
export async function confirmClaimPaid(db: Db, jobId: string, workerUserId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "jobs"
       SET "status"         = 'CLAIMED'::"JobStatus",
           "claimExpiresAt" = NULL,
           "updatedAt"      = now()
     WHERE "id"                = ${jobId}
       AND "status"            = 'CLAIM_PENDING_PAYMENT'::"JobStatus"
       AND "claimedByWorkerId" = ${workerUserId}
    RETURNING "id"
  `)
  if (rows.length === 0) return false

  await db.jobStatusEvent.create({
    data: {
      jobId, fromStatus: 'CLAIM_PENDING_PAYMENT', toStatus: 'CLAIMED',
      actorId: null, actorType: 'SYSTEM', note: 'Payment captured',
    },
  })
  return true
}

/**
 * Returns a reservation to the pool after a payment failure.
 *
 * Idempotent and guarded on worker id: a retried webhook cannot release a job
 * that a different worker has since legitimately claimed.
 */
export async function releaseReservation(
  db: Db,
  jobId: string,
  workerUserId: string,
  reason: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "jobs"
       SET "status"            = 'POSTED'::"JobStatus",
           "claimedByWorkerId" = NULL,
           "claimedAt"         = NULL,
           "claimExpiresAt"    = NULL,
           "updatedAt"         = now()
     WHERE "id"                = ${jobId}
       AND "status"            = 'CLAIM_PENDING_PAYMENT'::"JobStatus"
       AND "claimedByWorkerId" = ${workerUserId}
    RETURNING "id"
  `)
  if (rows.length === 0) return false

  await db.jobClaim.updateMany({
    where: { jobId, workerId: workerUserId, outcome: 'WON' },
    data: { outcome: 'LOST_PAYMENT_FAILED', resolvedAt: new Date() },
  })
  await db.jobStatusEvent.create({
    data: {
      jobId, fromStatus: 'CLAIM_PENDING_PAYMENT', toStatus: 'POSTED',
      actorId: null, actorType: 'SYSTEM', note: reason,
    },
  })
  return true
}

/**
 * Sweeps reservations whose TTL elapsed without payment resolving.
 *
 * Without this a crashed payment call would strand a job out of the pool
 * permanently. Runs on a short interval from the worker process; the partial
 * index jobs_claim_expiry_sweep keeps it from scanning the table.
 */
export async function sweepExpiredReservations(db: Db, now = new Date()): Promise<number> {
  // A CTE, not a plain UPDATE ... RETURNING.
  //
  // RETURNING yields POST-update values, so `RETURNING "claimedByWorkerId"`
  // after setting that column to NULL returns NULL — losing the very worker id
  // needed to close out their claim row. The first CTE captures the pre-update
  // values; the second performs the update against them.
  //
  // FOR UPDATE SKIP LOCKED makes the sweep safe to run from several worker
  // processes at once: each grabs a disjoint set of rows instead of blocking on
  // or double-processing the same ones.
  const expired = await db.$queryRaw<Array<{ id: string; claimedByWorkerId: string | null }>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id", "claimedByWorkerId"
        FROM "jobs"
       WHERE "status"         = 'CLAIM_PENDING_PAYMENT'::"JobStatus"
         AND "claimExpiresAt" < ${now}
       FOR UPDATE SKIP LOCKED
    ), released AS (
      UPDATE "jobs" j
         SET "status"            = 'POSTED'::"JobStatus",
             "claimedByWorkerId" = NULL,
             "claimedAt"         = NULL,
             "claimExpiresAt"    = NULL,
             "updatedAt"         = ${now}
        FROM candidates c
       WHERE j."id" = c."id"
      RETURNING j."id"
    )
    SELECT c."id", c."claimedByWorkerId" FROM candidates c
  `)

  if (expired.length === 0) return 0

  // Batched rather than per-row: a sweep after an outage can cover thousands of
  // jobs, and a loop of single-row writes would take minutes.
  await db.jobStatusEvent.createMany({
    data: expired.map((job) => ({
      jobId: job.id,
      fromStatus: 'CLAIM_PENDING_PAYMENT' as const,
      toStatus: 'POSTED' as const,
      actorId: null,
      actorType: 'SYSTEM',
      note: 'Claim reservation expired',
    })),
  })

  const withWorker = expired.filter((j) => j.claimedByWorkerId !== null)
  if (withWorker.length > 0) {
    await db.jobClaim.updateMany({
      where: {
        outcome: 'WON',
        OR: withWorker.map((j) => ({ jobId: j.id, workerId: j.claimedByWorkerId! })),
      },
      data: { outcome: 'EXPIRED', resolvedAt: now },
    })
  }

  return expired.length
}
