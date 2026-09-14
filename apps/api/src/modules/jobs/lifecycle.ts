import { Prisma } from '@prisma/client'
import type { Db } from '../../lib/prisma.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js'
import {
  assertTransition, isWithinGeofence, GEOFENCE_RADIUS_METERS,
  type JobStatus, type Actor, type LatLng,
} from '@grassassassin/shared'
import { releaseToWorker, type SettlementDeps } from '../payments/settlement.js'
import { awardJobCompletion, breakStreak, recalculateReputation, awardPoints } from '../gamification/points.js'
import { resolvePolicy } from '../payments/fee-config.js'

/**
 * Job lifecycle orchestration.
 *
 * The state machine in @grassassassin/shared says which transitions are legal;
 * this module enforces the *preconditions* around them — who may act, whether
 * the worker is physically present, whether proof was submitted — and runs the
 * side effects each transition implies.
 *
 * Authorization is checked here on every call. No route may transition a job
 * without going through this module, and nothing here trusts a client-supplied
 * role.
 */

export interface TransitionContext {
  jobId: string
  actorUserId: string | null
  actorType: Actor
  to: JobStatus
  /** Worker's device location, required for the geofenced start. */
  actorLocation?: LatLng
  note?: string
  now?: Date
}

/** Loads the job and establishes who the caller is relative to it. */
async function loadForTransition(db: Db, jobId: string, actorUserId: string | null) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true, status: true, customerId: true, claimedByWorkerId: true,
      dueAt: true, completedAt: true, startedAt: true,
      // Only CONFIRMED photos count. A row exists from the moment an upload is
      // presigned, so counting PENDING ones would let a worker satisfy the
      // photo gate by requesting an upload URL and never using it.
      photos: { where: { moderationStatus: { not: 'PENDING' } }, select: { kind: true } },
    },
  })
  if (!job) throw new NotFoundError('Job')

  const isCustomer = actorUserId !== null && job.customerId === actorUserId
  const isWorker = actorUserId !== null && job.claimedByWorkerId === actorUserId
  return { job, isCustomer, isWorker }
}

/**
 * Applies a lifecycle transition.
 *
 * Returns the new status. Throws ForbiddenError when the caller is not a party
 * to the job, ConflictError when a precondition fails, and
 * InvalidTransitionError when the edge does not exist in the state machine.
 */
export async function transitionJob(deps: SettlementDeps, ctx: TransitionContext): Promise<{ status: JobStatus }> {
  const { db } = deps
  const now = ctx.now ?? new Date()
  const { job, isCustomer, isWorker } = await loadForTransition(db, ctx.jobId, ctx.actorUserId)

  // Authorization first: establish the caller really holds the role they claim
  // before the state machine is consulted at all.
  if (ctx.actorType === 'CUSTOMER' && !isCustomer) {
    throw new ForbiddenError('You are not the customer for this job')
  }
  if (ctx.actorType === 'WORKER' && !isWorker) {
    throw new ForbiddenError('You are not the assigned worker for this job')
  }

  const from = job.status as JobStatus
  // Throws InvalidTransitionError if this edge does not exist for this actor.
  assertTransition(from, ctx.to, ctx.actorType)

  // --- preconditions ------------------------------------------------------

  if (ctx.to === 'IN_PROGRESS') {
    // A worker must actually be at the property to start. This timestamp and
    // location pair is the backbone of our chargeback evidence.
    if (!ctx.actorLocation) {
      throw new ValidationError('Location is required to start work')
    }
    const exact = await db.$queryRaw<Array<{ lat: number; lng: number }>>(Prisma.sql`
      SELECT ST_Y("exactLocation"::geometry) AS lat, ST_X("exactLocation"::geometry) AS lng
        FROM "jobs" WHERE "id" = ${ctx.jobId}
    `)
    const point = exact[0]
    if (point && !isWithinGeofence(ctx.actorLocation, { lat: point.lat, lng: point.lng })) {
      throw new ConflictError(
        'NOT_AT_PROPERTY',
        `You need to be within ${GEOFENCE_RADIUS_METERS}m of the property to start work`,
      )
    }

    const hasBefore = job.photos.some((p) => p.kind === 'BEFORE')
    if (!hasBefore) {
      throw new ConflictError('BEFORE_PHOTOS_REQUIRED', 'Upload before photos to start work')
    }
  }

  if (ctx.to === 'PENDING_APPROVAL') {
    const hasAfter = job.photos.some((p) => p.kind === 'AFTER')
    if (!hasAfter) {
      throw new ConflictError('AFTER_PHOTOS_REQUIRED', 'Upload after photos to mark the job complete')
    }
  }

  // --- apply --------------------------------------------------------------

  // Guarded on the current status so two concurrent transitions cannot both
  // apply — the same compare-and-set discipline as the claim. The per-status
  // timestamp is set in the same statement so a crash cannot leave a job in a
  // state without the timestamp that proves when it got there.
  const updated = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "jobs"
       SET "status" = ${ctx.to}::"JobStatus", "updatedAt" = ${now}
           ${ctx.to === 'EN_ROUTE' ? Prisma.sql`, "enRouteAt" = ${now}` : Prisma.empty}
           ${ctx.to === 'IN_PROGRESS' ? Prisma.sql`, "startedAt" = ${now}` : Prisma.empty}
           ${ctx.to === 'PENDING_APPROVAL' ? Prisma.sql`, "completedAt" = ${now}` : Prisma.empty}
           ${ctx.to === 'APPROVED' ? Prisma.sql`, "approvedAt" = ${now}` : Prisma.empty}
           ${ctx.to === 'PAID' ? Prisma.sql`, "paidAt" = ${now}` : Prisma.empty}
           ${ctx.to === 'CLOSED' ? Prisma.sql`, "closedAt" = ${now}` : Prisma.empty}
     WHERE "id" = ${ctx.jobId}
       AND "status" = ${from}::"JobStatus"
    RETURNING "id"
  `)

  if (updated.length === 0) {
    throw new ConflictError('STATUS_CHANGED', 'This job changed while you were acting on it. Try again.')
  }

  await db.jobStatusEvent.create({
    data: {
      jobId: ctx.jobId, fromStatus: from, toStatus: ctx.to,
      actorId: ctx.actorUserId, actorType: ctx.actorType, note: ctx.note ?? null,
    },
  })

  if (ctx.actorLocation) {
    await db.$executeRaw(Prisma.sql`
      UPDATE "job_status_events"
         SET "actorLocation" = ST_SetSRID(ST_MakePoint(${ctx.actorLocation.lng}::float8, ${ctx.actorLocation.lat}::float8), 4326)::geography
       WHERE "id" = (SELECT "id" FROM "job_status_events" WHERE "jobId" = ${ctx.jobId} ORDER BY "createdAt" DESC LIMIT 1)
    `)
  }

  // --- side effects -------------------------------------------------------

  if (ctx.to === 'CLAIMED' && job.claimedByWorkerId) {
    await db.conversation.upsert({
      where: { jobId: ctx.jobId },
      create: { jobId: ctx.jobId, customerId: job.customerId, workerId: job.claimedByWorkerId },
      update: {},
    })
  }

  if (ctx.to === 'APPROVED' && job.claimedByWorkerId) {
    await onApproved(deps, { jobId: ctx.jobId, workerUserId: job.claimedByWorkerId, now })
  }

  return { status: ctx.to }
}

/**
 * Everything that happens when work is approved: pay the worker, award points,
 * recompute reputation.
 *
 * Payment failure does not roll back the approval. The customer approved the
 * work; that fact is true regardless of whether our transfer succeeded, and
 * re-opening an approved job would be far more confusing than retrying a
 * transfer. The job sits in APPROVED and the transfer is retried out of band.
 */
async function onApproved(deps: SettlementDeps, params: {
  jobId: string
  workerUserId: string
  now: Date
}): Promise<void> {
  const { db } = deps

  const release = await releaseToWorker(deps, { jobId: params.jobId })
  if (release.ok) {
    await db.$queryRaw(Prisma.sql`
      UPDATE "jobs" SET "status" = 'PAID'::"JobStatus", "paidAt" = ${params.now}
       WHERE "id" = ${params.jobId} AND "status" = 'APPROVED'::"JobStatus"
    `)
    await db.jobStatusEvent.create({
      data: {
        jobId: params.jobId, fromStatus: 'APPROVED', toStatus: 'PAID',
        actorId: null, actorType: 'SYSTEM', note: 'Funds transferred',
      },
    })
  }

  await awardJobCompletion(db, { workerUserId: params.workerUserId, jobId: params.jobId })
  await recalculateReputation(db, params.workerUserId)
}

/**
 * Cancels a job, applying the points consequence for a worker who backs out.
 *
 * Money settlement is the caller's responsibility (settleCancellation) so that
 * a cancellation preview can quote the customer a number before they confirm.
 */
export async function cancelJob(db: Db, params: {
  jobId: string
  actorUserId: string
  actor: 'CUSTOMER' | 'WORKER'
  reason?: string
  now?: Date
}): Promise<void> {
  const now = params.now ?? new Date()
  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: { id: true, status: true, customerId: true, claimedByWorkerId: true, claimedAt: true, dueAt: true, windowStartAt: true },
  })
  if (!job) throw new NotFoundError('Job')

  if (params.actor === 'CUSTOMER' && job.customerId !== params.actorUserId) {
    throw new ForbiddenError('You are not the customer for this job')
  }
  if (params.actor === 'WORKER' && job.claimedByWorkerId !== params.actorUserId) {
    throw new ForbiddenError('You are not the assigned worker for this job')
  }

  const from = job.status as JobStatus
  const targetStatus = params.actor === 'WORKER' && from === 'CLAIMED' ? 'POSTED' : 'CANCELLED'

  const updated = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "jobs"
       SET "status" = ${targetStatus}::"JobStatus",
           "cancelledAt" = ${targetStatus === 'CANCELLED' ? now : null},
           "cancelledById" = ${targetStatus === 'CANCELLED' ? params.actorUserId : null},
           "cancellationReason" = ${params.reason ?? null},
           "claimedByWorkerId" = ${targetStatus === 'POSTED' ? null : job.claimedByWorkerId},
           "claimedAt" = ${targetStatus === 'POSTED' ? null : job.claimedAt},
           "updatedAt" = ${now}
     WHERE "id" = ${params.jobId} AND "status" = ${from}::"JobStatus"
    RETURNING "id"
  `)
  if (updated.length === 0) {
    throw new ConflictError('STATUS_CHANGED', 'This job changed while you were acting on it. Try again.')
  }

  await db.jobStatusEvent.create({
    data: {
      jobId: params.jobId, fromStatus: from, toStatus: targetStatus,
      actorId: params.actorUserId, actorType: params.actor,
      note: params.reason ?? 'Cancelled',
    },
  })

  // A worker abandoning a claimed job costs points, scaled by how much warning
  // they gave. Note that DECLINING a job costs nothing — only abandoning one
  // they already committed to.
  if (params.actor === 'WORKER' && job.claimedByWorkerId) {
    const scheduledFor = job.windowStartAt ?? job.dueAt
    const hoursNotice = (scheduledFor.getTime() - now.getTime()) / 3_600_000
    await awardPoints(db, {
      workerUserId: job.claimedByWorkerId,
      event: hoursNotice < 12 ? 'CANCEL_AFTER_CLAIM_LATE' : 'CANCEL_AFTER_CLAIM_EARLY',
      jobId: params.jobId,
      note: `Cancelled with ${Math.max(0, Math.round(hoursNotice))}h notice`,
    })
    await breakStreak(db, job.claimedByWorkerId)
    await recalculateReputation(db, job.claimedByWorkerId)
  }
}

/**
 * Auto-approves work the customer never responded to.
 *
 * Without this, a silent customer would strand a worker's money indefinitely.
 * The customer is warned before it fires (see the notification matrix), and the
 * window is admin-configurable per market.
 */
export async function autoApproveStaleJobs(deps: SettlementDeps, now = new Date()): Promise<number> {
  const { db } = deps
  const policy = await resolvePolicy(db, null)
  const cutoff = new Date(now.getTime() - policy.autoApprovalHours * 3_600_000)

  const stale = await db.job.findMany({
    where: { status: 'PENDING_APPROVAL', completedAt: { lt: cutoff } },
    select: { id: true, claimedByWorkerId: true },
    take: 500,
  })

  let approved = 0
  for (const job of stale) {
    if (!job.claimedByWorkerId) continue
    try {
      await transitionJob(deps, {
        jobId: job.id, actorUserId: null, actorType: 'SYSTEM', to: 'APPROVED',
        note: `Auto-approved after ${policy.autoApprovalHours}h without customer response`,
        now,
      })
      approved += 1
    } catch {
      // One job failing to auto-approve must not stop the batch. The sweeper
      // runs again shortly and will retry this job.
    }
  }
  return approved
}

/** Expires jobs nobody claimed before their deadline. */
export async function expireUnclaimedJobs(db: Db, now = new Date()): Promise<number> {
  const expired = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "jobs"
       SET "status" = 'EXPIRED'::"JobStatus", "updatedAt" = ${now}
     WHERE "status" = 'POSTED'::"JobStatus" AND "dueAt" < ${now}
    RETURNING "id"
  `)
  if (expired.length > 0) {
    await db.jobStatusEvent.createMany({
      data: expired.map((j) => ({
        jobId: j.id, fromStatus: 'POSTED' as const, toStatus: 'EXPIRED' as const,
        actorId: null, actorType: 'SYSTEM', note: 'Deadline passed without a claim',
      })),
    })
  }
  return expired.length
}
