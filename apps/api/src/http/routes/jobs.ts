import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  createJobSchema, searchJobsQuerySchema, claimJobSchema, jobStatusUpdateSchema,
  createReviewSchema, tipSchema, queryBoolean, metersToMiles, quoteJob,
  endOfLocalDay, endOfLocalWeek,
  type JobStatus,
} from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { requireVerifiedEmail } from '../../modules/auth/email-verification.js'
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../../lib/errors.js'
import { createJob } from '../../modules/jobs/repository.js'
import { searchNearbyJobs, getExactLocationForClaimedJob } from '../../modules/geo/job-search.js'
import { attemptClaim, confirmClaimPaid, releaseReservation } from '../../modules/jobs/claim.js'
import { transitionJob, cancelJob } from '../../modules/jobs/lifecycle.js'
import { captureForClaim, settleCancellation, chargeTip } from '../../modules/payments/settlement.js'
import { resolvePolicy } from '../../modules/payments/fee-config.js'
import {
  DISPUTE_REASONS, MIN_DISPUTE_DESCRIPTION, MAX_DISPUTE_DESCRIPTION,
  DISPUTE_WINDOW_DAYS, canDispute, withinDisputeWindow, isUrgentDispute,
} from '@grassassassin/shared'
import { displayableRating, recalculateReputation, recalculateCustomerReputation, awardPoints } from '../../modules/gamification/points.js'

export async function registerJobRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {

  // --- pricing guidance, before the job exists ---------------------------

  /*
   * Public on purpose, and the only route under /jobs that is.
   *
   * It answers "roughly what does this cost" from category averages and a
   * lot-size multiplier. Someone weighing up whether to sign up should be able
   * to ask that, and the answer contains nobody's data — the same figures
   * /v1/categories already hands out. Anything here that starts reading a
   * specific customer's or property's data needs requireIdentity first.
   */
  app.get<{ Querystring: { categoryId?: string; yardSize?: string } }>('/jobs/price-guidance', async (request) => {
    const query = z.object({
      categoryId: z.string().min(1),
      yardSize: z.enum(['UNDER_QUARTER_ACRE', 'QUARTER_TO_HALF', 'HALF_TO_ONE', 'ONE_TO_TWO', 'OVER_TWO']).optional(),
    }).parse(request.query)

    const category = await deps.db.serviceCategory.findUnique({
      where: { id: query.categoryId },
      select: { typicalLowCents: true, typicalHighCents: true, baseMinutes: true },
    })
    if (!category) throw new NotFoundError('Category')

    // Larger lots cost more. Scaled sublinearly, matching the duration estimate.
    const multiplier = query.yardSize
      ? ({ UNDER_QUARTER_ACRE: 0.8, QUARTER_TO_HALF: 1, HALF_TO_ONE: 1.5, ONE_TO_TWO: 2.2, OVER_TWO: 3.2 } as const)[query.yardSize]
      : 1

    return {
      suggestedLowCents: Math.round(category.typicalLowCents * multiplier),
      suggestedHighCents: Math.round(category.typicalHighCents * multiplier),
      estimatedMinutes: Math.round(category.baseMinutes * multiplier),
    }
  })

  app.get('/categories', async () => {
    const categories = await deps.db.serviceCategory.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, slug: true, name: true, icon: true, difficulty: true,
        baseMinutes: true, typicalLowCents: true, typicalHighCents: true,
      },
    })
    return { categories }
  })

  // --- customer: create ---------------------------------------------------

  app.post('/jobs', async (request, reply) => {
    const identity = requireIdentity(request)
    /*
     * Posting means a stranger is coming to your home, so the account doing it
     * has to be reachable at a real address. Checked here rather than at
     * sign-in: locking somebody out of an app they just installed over a mail
     * in a spam folder loses the person, not the bad actor.
     */
    await requireVerifiedEmail(deps.db, identity.userId)
    const body = createJobSchema.parse(request.body)

    const property = await deps.db.$queryRaw<Array<{ ownerId: string; lat: number; lng: number; city: string; state: string; yardSize: string }>>(
      Prisma.sql`
        SELECT "ownerId", ST_Y("location"::geometry) AS lat, ST_X("location"::geometry) AS lng,
               "city","state","yardSize"::text AS "yardSize"
          FROM "properties" WHERE "id" = ${body.propertyId}
      `,
    )
    const prop = property[0]
    if (!prop) throw new NotFoundError('Property')
    if (prop.ownerId !== identity.userId) throw new ForbiddenError('That is not your property')

    const policy = await resolvePolicy(deps.db, null)
    if (body.priceCents < policy.fees.minJobPriceCents) {
      throw new ValidationError(
        `The minimum job price is $${(policy.fees.minJobPriceCents / 100).toFixed(2)}`,
      )
    }
    if (body.dueAt <= new Date()) {
      throw new ValidationError('The deadline must be in the future')
    }

    const category = await deps.db.serviceCategory.findUnique({
      where: { id: body.categoryId },
      select: { id: true, name: true, active: true },
    })
    if (!category?.active) throw new NotFoundError('Category')

    const { id } = await createJob(deps.db, {
      customerId: identity.userId,
      propertyId: body.propertyId,
      categoryId: body.categoryId,
      title: body.title ?? category.name,
      description: body.description ?? null,
      specialInstructions: body.specialInstructions ?? null,
      priceCents: body.priceCents,
      location: { lat: prop.lat, lng: prop.lng },
      generalArea: `${prop.city}, ${prop.state}`,
      dueAt: body.dueAt,
      windowStartAt: body.windowStartAt ?? null,
      windowEndAt: body.windowEndAt ?? null,
      yardSize: (body.yardSize ?? prop.yardSize) as never,
      equipmentProvided: body.equipmentProvided,
      feeConfig: policy.fees,
    })

    if (body.photoIds.length > 0) {
      await deps.db.jobPhoto.updateMany({
        where: { id: { in: body.photoIds }, uploadedById: identity.userId },
        data: { jobId: id },
      })
    }

    return reply.status(201).send(await loadJobForOwner(deps, id, identity.userId))
  })

  // --- worker: search -----------------------------------------------------

  app.get('/jobs/search', async (request) => {
    const identity = requireIdentity(request)
    // Query-string schema, not the JSON one: a query string carries only
    // strings, and coercing them by hand at each call site is how
    // `Boolean("false") === true` bugs get in.
    const query = searchJobsQuerySchema.parse(request.query)

    const worker = await deps.db.workerProfile.findUnique({
      where: { userId: identity.userId },
      select: { serviceRadiusMiles: true, status: true, rank: { select: { radiusBonusMiles: true } } },
    })

    // Cap the search at what this worker is actually allowed to serve, so the
    // radius parameter cannot be used to scrape the whole marketplace.
    const allowedRadius = worker
      ? worker.serviceRadiusMiles + (worker.rank?.radiusBonusMiles ?? 0)
      : 15
    const radiusMiles = Math.min(query.radiusMiles, allowedRadius)

    // Computed in the WORKER's timezone, not the server's. See the
    // tzOffsetMinutes note in the contract.
    const now = new Date()
    const dueBefore = query.dueToday
      ? endOfLocalDay(now, query.tzOffsetMinutes ?? 0)
      : query.dueThisWeek
        ? endOfLocalWeek(now, query.tzOffsetMinutes ?? 0)
        : undefined

    const rows = await searchNearbyJobs(deps.db, {
      center: { lat: query.lat, lng: query.lng },
      radiusMiles,
      minPayoutCents: query.minPayoutCents,
      categoryIds: query.categoryIds,
      equipmentProvided: query.equipmentProvided,
      difficulty: query.difficulty,
      dueBefore,
      sort: query.sort,
      limit: query.limit,
      viewerUserId: identity.userId,
    })

    return {
      jobs: rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        priceCents: row.priceCents,
        workerPayoutCents: row.workerPayoutCents,
        yardSize: row.yardSize,
        estimatedMinutes: row.estimatedMinutes,
        payPerHourCents: row.estimatedMinutes
          ? Math.round((row.workerPayoutCents * 60) / row.estimatedMinutes)
          : null,
        difficulty: row.difficulty,
        equipmentProvided: row.equipmentProvided,
        dueAt: row.dueAt,
        windowStartAt: row.windowStartAt,
        windowEndAt: row.windowEndAt,
        postedAt: row.postedAt,
        // Approximate only. The exact point is never in this response.
        approximateLocation: { lat: row.approxLat, lng: row.approxLng },
        distanceMeters: row.distanceMeters,
        distanceMiles: Number(metersToMiles(row.distanceMeters).toFixed(2)),
        generalArea: row.generalArea,
        customerRating: displayableRating(row.customerRating, row.customerCompletedJobs),
        customerCompletedJobs: row.customerCompletedJobs,
        isPremium: row.isPremium,
        isFeatured: row.isFeatured,
      })),
      radiusMilesApplied: radiusMiles,
    }
  })

  // --- job detail ---------------------------------------------------------

  app.get<{ Params: { id: string } }>('/jobs/:id', async (request) => {
    const identity = requireIdentity(request)
    const job = await deps.db.job.findUnique({
      where: { id: request.params.id },
      include: {
        category: { select: { id: true, name: true, icon: true, difficulty: true } },
        photos: { select: { id: true, kind: true, url: true, createdAt: true } },
        customer: {
          select: {
            id: true, firstName: true, avatarUrl: true,
            customerProfile: { select: { averageRating: true, ratingCount: true, jobsCompleted: true } },
          },
        },
      },
    })
    if (!job) throw new NotFoundError('Job')

    const isCustomer = job.customerId === identity.userId
    const isAssignedWorker = job.claimedByWorkerId === identity.userId
    const isAdmin = identity.roles.includes('ADMIN')

    // THE PRIVACY BOUNDARY. Exact location and the property's address are
    // released only to the customer, the worker holding the claim, or an admin.
    const canSeeExact = isCustomer || isAssignedWorker || isAdmin

    const location = canSeeExact
      ? await getExactLocationForClaimedJob(deps.db, job.id)
      : await approximateLocationFor(deps, job.id)

    let address: Record<string, unknown> | null = null
    if (canSeeExact) {
      const rows = await deps.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT "addressLine1","addressLine2","city","state","postalCode","gateCode","hasDog","accessNotes"
          FROM "properties" WHERE "id" = ${job.propertyId}
      `)
      address = rows[0] ?? null
    }

    // The auto-approval deadline is computed here rather than in the app.
    // The window is admin-configurable per market, so a client that assumed 24h
    // would start lying to customers the moment someone changed it — and the
    // lie would be about when their money gets spent.
    const autoApproveAt = job.status === 'PENDING_APPROVAL' && job.completedAt
      ? new Date(job.completedAt.getTime() + (await resolvePolicy(deps.db, null)).autoApprovalHours * 3_600_000)
      : null

    // Fetched separately because claimedByWorkerId is denormalised onto the job
    // so the single-winner conditional UPDATE can set it atomically — which
    // means Prisma has no relation to include here.
    //
    // Gated on canSeeExact, not merely on "someone claimed it". A stranger
    // learning that a named person is at a house in this neighbourhood tonight
    // is a location-inference channel on a real worker — the mirror image of
    // the address rule, and it deserves the same boundary.
    const assignedWorker = job.claimedByWorkerId && canSeeExact
      ? await deps.db.user.findUnique({
          where: { id: job.claimedByWorkerId },
          select: {
            id: true, firstName: true, avatarUrl: true,
            workerProfile: {
              select: {
                averageRating: true, ratingCount: true, completedJobs: true, onTimeRate: true,
                rank: { select: { key: true, name: true, verifiedBadge: true, colorHex: true } },
              },
            },
          },
        })
      : null

    const profile = job.customer.customerProfile

    return {
      id: job.id,
      title: job.title,
      description: job.description,
      // Special instructions can contain a gate code, so they follow the same rule.
      specialInstructions: canSeeExact ? job.specialInstructions : null,
      status: job.status,
      category: job.category,
      priceCents: job.priceCents,
      serviceFeeCents: isCustomer ? job.serviceFeeCents : undefined,
      customerTotalCents: isCustomer ? job.customerTotalCents : undefined,
      workerPayoutCents: job.workerPayoutCents,
      yardSize: job.yardSize,
      estimatedMinutes: job.estimatedMinutes,
      difficulty: job.difficulty,
      equipmentProvided: job.equipmentProvided,
      dueAt: job.dueAt,
      windowStartAt: job.windowStartAt,
      windowEndAt: job.windowEndAt,
      postedAt: job.postedAt,
      claimedAt: job.claimedAt,
      completedAt: job.completedAt,
      generalArea: job.generalArea,
      location,
      locationPrecision: canSeeExact ? 'EXACT' : 'APPROXIMATE',
      address,
      photos: job.photos,
      customer: {
        id: job.customer.id,
        firstName: job.customer.firstName,
        avatarUrl: job.customer.avatarUrl,
        rating: displayableRating(profile?.averageRating ?? null, profile?.jobsCompleted ?? 0),
        completedJobs: profile?.jobsCompleted ?? 0,
      },
      // Who is coming to the house. The customer cannot see this before anyone
      // has claimed, because there is nobody to see; once someone has, hiding
      // it would be worse than useless — a stranger is about to walk onto their
      // property and they are entitled to know who.
      //
      // Reputation only. No email, no phone, no last name: the same rule the
      // public profile follows, for the same reason.
      autoApproveAt,
      worker: assignedWorker
        ? {
            id: assignedWorker.id,
            firstName: assignedWorker.firstName,
            avatarUrl: assignedWorker.avatarUrl,
            rating: displayableRating(
              assignedWorker.workerProfile?.averageRating ?? null,
              assignedWorker.workerProfile?.ratingCount ?? 0,
            ),
            completedJobs: assignedWorker.workerProfile?.completedJobs ?? 0,
            onTimeRate: assignedWorker.workerProfile?.onTimeRate ?? null,
            rank: assignedWorker.workerProfile?.rank ?? null,
          }
        : null,
      viewerRole: isCustomer ? 'CUSTOMER' : isAssignedWorker ? 'WORKER' : 'VIEWER',
    }
  })

  app.get('/jobs/mine', async (request) => {
    const identity = requireIdentity(request)
    const query = z.object({
      role: z.enum(['CUSTOMER', 'WORKER']).default('CUSTOMER'),
      // queryBoolean, not z.coerce.boolean(): the latter applies Boolean(),
      // and Boolean("false") is true — so ?active=false would filter TO active.
      active: queryBoolean.optional(),
    }).parse(request.query)

    const activeStatuses: JobStatus[] = ['POSTED', 'CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'DISPUTED']

    const jobs = await deps.db.job.findMany({
      where: {
        ...(query.role === 'CUSTOMER'
          ? { customerId: identity.userId }
          : { claimedByWorkerId: identity.userId }),
        ...(query.active ? { status: { in: activeStatuses as never } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, title: true, status: true, priceCents: true, workerPayoutCents: true,
        dueAt: true, generalArea: true, completedAt: true, createdAt: true,
        category: { select: { name: true, icon: true } },
      },
    })
    return { jobs }
  })

  // --- worker: claim ------------------------------------------------------

  app.post('/jobs/:id/claim', {
    // Claiming is the most contended endpoint in the product. A per-worker
    // limit stops a script from hammering it faster than a human could tap.
    config: app.rateLimits.enabled
      ? { rateLimit: { max: app.rateLimits.claimMax, timeWindow: '1 minute' } }
      : {},
  }, async (request) => {
    const identity = requireIdentity(request)
    // And the other direction: claiming means going to a stranger's home.
    await requireVerifiedEmail(deps.db, identity.userId)
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const body = claimJobSchema.partial({ jobId: true }).parse(request.body ?? {})

    const claim = await attemptClaim(deps.db, {
      jobId: params.id,
      workerUserId: identity.userId,
      workerLocation: body.workerLocation,
    })

    if (claim.outcome === 'LOST') return claim

    // The reservation is held; now charge. If this fails the job goes straight
    // back into the pool so nobody else is blocked by a dead reservation.
    const capture = await captureForClaim(deps, { jobId: params.id, workerUserId: identity.userId })

    if (!capture.ok) {
      await releaseReservation(deps.db, params.id, identity.userId, capture.failureCode ?? 'payment_failed')
      return {
        outcome: 'LOST' as const,
        jobId: params.id,
        reason: 'PAYMENT_FAILED' as const,
        message: 'We could not charge the customer. The job has been released.',
      }
    }

    // confirmClaimPaid performs the CLAIM_PENDING_PAYMENT -> CLAIMED transition
    // and opens the conversation. Nothing further is needed here.
    await confirmClaimPaid(deps.db, params.id, identity.userId)

    return { ...claim, status: 'CLAIMED' as const }
  })

  // --- lifecycle ----------------------------------------------------------

  app.post<{ Params: { id: string } }>('/jobs/:id/status', async (request) => {
    const identity = requireIdentity(request)
    const body = jobStatusUpdateSchema.omit({ jobId: true }).parse(request.body)

    const job = await deps.db.job.findUnique({
      where: { id: request.params.id },
      select: { customerId: true, claimedByWorkerId: true },
    })
    if (!job) throw new NotFoundError('Job')

    const actorType = job.customerId === identity.userId
      ? 'CUSTOMER'
      : job.claimedByWorkerId === identity.userId
        ? 'WORKER'
        : identity.roles.includes('ADMIN') ? 'ADMIN' : null

    if (!actorType) throw new ForbiddenError('You are not a party to this job')

    return transitionJob(deps, {
      jobId: request.params.id,
      actorUserId: identity.userId,
      actorType,
      to: body.to,
      actorLocation: body.workerLocation,
      note: body.note,
    })
  })

  // --- cancellation -------------------------------------------------------

  app.get<{ Params: { id: string } }>('/jobs/:id/cancellation-preview', async (request) => {
    const identity = requireIdentity(request)
    const job = await deps.db.job.findUnique({
      where: { id: request.params.id },
      select: {
        customerId: true, claimedByWorkerId: true, status: true, claimedAt: true,
        dueAt: true, windowStartAt: true, priceCents: true, serviceFeeCents: true,
        customerTotalCents: true, workerCommissionCents: true, workerPayoutCents: true,
      },
    })
    if (!job) throw new NotFoundError('Job')

    const isCustomer = job.customerId === identity.userId
    const isWorker = job.claimedByWorkerId === identity.userId
    if (!isCustomer && !isWorker) throw new ForbiddenError('You are not a party to this job')

    const policy = await resolvePolicy(deps.db, null)
    const { resolveCancellation } = await import('@grassassassin/shared')

    // Quote the number BEFORE they confirm. Charging a cancellation fee someone
    // did not see coming is the fastest way to lose them permanently.
    return resolveCancellation({
      quote: quoteJob(job.priceCents, policy.fees),
      actor: isCustomer ? 'CUSTOMER' : 'WORKER',
      status: job.status as 'POSTED' | 'CLAIMED' | 'EN_ROUTE' | 'IN_PROGRESS',
      claimedAt: job.claimedAt,
      scheduledFor: job.windowStartAt ?? job.dueAt,
      now: new Date(),
      policy: policy.cancellation,
    })
  })

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({ reason: z.string().max(500).optional() }).parse(request.body ?? {})

    const job = await deps.db.job.findUnique({
      where: { id: request.params.id },
      select: { customerId: true, claimedByWorkerId: true },
    })
    if (!job) throw new NotFoundError('Job')

    const actor = job.customerId === identity.userId
      ? 'CUSTOMER'
      : job.claimedByWorkerId === identity.userId ? 'WORKER' : null
    if (!actor) throw new ForbiddenError('You are not a party to this job')

    // Settle the money first: it reads the pre-cancellation state, which
    // cancelJob is about to overwrite.
    const settlement = await settleCancellation(deps, { jobId: request.params.id, actor })
    await cancelJob(deps.db, {
      jobId: request.params.id, actorUserId: identity.userId, actor, reason: body.reason,
    })

    return settlement
  })

  // --- reviews and tips ---------------------------------------------------

  /**
   * Reports a problem with completed work.
   *
   * This writes a Dispute record, which nothing previously did. The job status
   * machine had a DISPUTED state and the admin dashboard was built around an
   * evidence package, but a customer reporting a problem only moved the status
   * — holding their money and the worker's with no case for anyone to answer.
   *
   * The transition and the record are written together. A DISPUTED job with no
   * dispute row is invisible to the people whose job it is to resolve it, and a
   * dispute row on a job that never moved would be a case about nothing.
   */
  app.post<{ Params: { id: string } }>('/jobs/:id/dispute', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = z.object({
      reason: z.enum(DISPUTE_REASONS.map((r) => r.key) as [string, ...string[]]),
      description: z.string().trim().min(MIN_DISPUTE_DESCRIPTION).max(MAX_DISPUTE_DESCRIPTION),
    }).parse(request.body)

    const job = await deps.db.job.findUnique({
      where: { id: request.params.id },
      select: { id: true, customerId: true, claimedByWorkerId: true, status: true, completedAt: true },
    })
    if (!job) throw new NotFoundError('Job')
    if (job.customerId !== identity.userId) throw new ForbiddenError('That is not your job')
    if (!job.claimedByWorkerId) {
      throw new ConflictError('NO_WORKER', 'Nobody has worked on this job yet')
    }

    // Checked FIRST, before the status rules. Opening a dispute moves the job
    // to DISPUTED, which is not itself a disputable status — so a customer who
    // taps report twice would otherwise be told "you can cancel the job
    // instead", which is both wrong and alarming when what actually happened is
    // that their report went through.
    const existing = await deps.db.dispute.findFirst({
      where: { jobId: job.id, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      select: { id: true, createdAt: true },
    })
    if (existing) {
      throw new ConflictError(
        'ALREADY_OPEN',
        'You have already reported a problem with this job. A person is reviewing it.',
      )
    }

    if (!canDispute(job.status)) {
      // Before the work is finished the remedy is to cancel, which is cheaper
      // for everyone than opening a case.
      throw new ConflictError(
        'NOT_DISPUTABLE',
        'You can report a problem once the work is marked finished. Until then you can cancel the job.',
      )
    }
    if (!withinDisputeWindow(job.completedAt)) {
      throw new ConflictError(
        'WINDOW_CLOSED',
        `Problems can be reported within ${DISPUTE_WINDOW_DAYS} days of the work being finished.`,
      )
    }

    const dispute = await deps.db.dispute.create({
      data: {
        jobId: job.id,
        openedById: identity.userId,
        againstId: job.claimedByWorkerId,
        reason: body.reason,
        description: body.description,
        status: 'OPEN',
      },
      select: { id: true, reason: true, status: true, createdAt: true },
    })

    // Only move the job if it is somewhere the machine allows. A dispute
    // raised after payment is still a real case — the money has moved and an
    // admin may need to refund — but the job does not travel backwards.
    if (job.status === 'PENDING_APPROVAL') {
      await transitionJob(deps, {
        jobId: job.id,
        actorUserId: identity.userId,
        actorType: 'CUSTOMER',
        to: 'DISPUTED',
        note: `Customer reported: ${body.reason}`,
      })
    }

    return reply.status(201).send({
      disputeId: dispute.id,
      reason: dispute.reason,
      status: dispute.status,
      urgent: isUrgentDispute(dispute.reason),
      // Said plainly, because the alternative is a customer who assumes nothing
      // is happening and calls their bank instead.
      message: isUrgentDispute(dispute.reason)
        ? 'Reported. Because this involves damage or safety, a person is being alerted now.'
        : 'Reported. A person will review this within one business day, and your payment is held until it is resolved.',
    })
  })

  app.post('/jobs/:id/review', async (request, reply) => {
    const identity = requireIdentity(request)
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const body = createReviewSchema.omit({ jobId: true }).parse(request.body)

    const job = await deps.db.job.findUnique({
      where: { id: params.id },
      select: { id: true, customerId: true, claimedByWorkerId: true, status: true },
    })
    if (!job) throw new NotFoundError('Job')
    if (!['APPROVED', 'PAID', 'CLOSED'].includes(job.status)) {
      throw new ConflictError('NOT_REVIEWABLE', 'You can review this job once the work is approved')
    }

    const isCustomer = job.customerId === identity.userId
    const isWorker = job.claimedByWorkerId === identity.userId
    if (!isCustomer && !isWorker) throw new ForbiddenError('You are not a party to this job')

    const subjectId = isCustomer ? job.claimedByWorkerId! : job.customerId

    const review = await deps.db.review.create({
      data: {
        jobId: job.id,
        authorId: identity.userId,
        subjectId,
        direction: isCustomer ? 'CUSTOMER_TO_WORKER' : 'WORKER_TO_CUSTOMER',
        rating: body.rating,
        comment: body.comment ?? null,
        tags: body.tags,
      },
    })

    if (isCustomer) {
      if (body.rating === 5) {
        await awardPoints(deps.db, {
          workerUserId: subjectId, event: 'FIVE_STAR_REVIEW', jobId: job.id,
        })
      }
      await recalculateReputation(deps.db, subjectId)
    } else {
      await recalculateCustomerReputation(deps.db, subjectId)
    }

    // Once both sides have reviewed, the job is done.
    const reviewCount = await deps.db.review.count({ where: { jobId: job.id } })
    if (reviewCount >= 2 && job.status === 'PAID') {
      await transitionJob(deps, {
        jobId: job.id, actorUserId: null, actorType: 'SYSTEM', to: 'CLOSED',
        note: 'Both parties reviewed',
      }).catch(() => undefined)
    }

    return reply.status(201).send(review)
  })

  app.post('/jobs/:id/tip', async (request) => {
    const identity = requireIdentity(request)
    const params = z.object({ id: z.string().min(1) }).parse(request.params)
    const body = tipSchema.omit({ jobId: true }).parse(request.body)

    const result = await chargeTip(deps, {
      jobId: params.id, fromUserId: identity.userId, amountCents: body.amountCents,
    })
    if (!result.ok) throw new ConflictError('TIP_FAILED', result.failureMessage ?? 'The tip could not be processed')
    return result
  })
}

async function approximateLocationFor(deps: ServerDeps, jobId: string) {
  const rows = await deps.db.$queryRaw<Array<{ lat: number; lng: number }>>(Prisma.sql`
    SELECT ST_Y("approxLocation"::geometry) AS lat, ST_X("approxLocation"::geometry) AS lng
      FROM "jobs" WHERE "id" = ${jobId}
  `)
  return rows[0] ?? null
}

async function loadJobForOwner(deps: ServerDeps, jobId: string, ownerId: string) {
  const job = await deps.db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      id: true, title: true, status: true, priceCents: true, serviceFeeCents: true,
      customerTotalCents: true, workerPayoutCents: true, dueAt: true, generalArea: true,
      estimatedMinutes: true, difficulty: true, customerId: true, postedAt: true,
    },
  })
  if (job.customerId !== ownerId) throw new ForbiddenError('That is not your job')
  return job
}
