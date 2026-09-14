import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../../lib/errors.js'
import { resolvePolicy } from '../../modules/payments/fee-config.js'

/**
 * Recurring service.
 *
 * The single highest-leverage feature in the product: a customer converted to
 * biweekly produces roughly thirteen jobs a season instead of one, so the same
 * acquisition cost amortises across ~$124 of contribution rather than ~$9.57.
 *
 * The conversion moment is deliberately placed right after a good rating, when
 * the customer has just confirmed they are happy — which is why the primary
 * entry point is "make this job recurring" rather than a standalone form.
 */

const INTERVAL_DAYS: Record<string, number> = { WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 30 }

export async function registerRecurringRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  /** Turns a completed job into a standing appointment. */
  app.post<{ Params: { id: string } }>('/jobs/:id/make-recurring', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = z.object({
      interval: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY']),
      priceCents: z.number().int().positive().optional(),
      /** Offer it to the same pro first. Defaults to true — it is why they liked it. */
      preferPreviousWorker: z.boolean().default(true),
    }).parse(request.body)

    const job = await deps.db.job.findUnique({
      where: { id: request.params.id },
      select: {
        id: true, customerId: true, propertyId: true, categoryId: true,
        priceCents: true, specialInstructions: true, equipmentProvided: true,
        claimedByWorkerId: true, status: true, recurringJobId: true,
      },
    })
    if (!job) throw new NotFoundError('Job')
    if (job.customerId !== identity.userId) throw new ForbiddenError('That is not your job')

    if (!['APPROVED', 'PAID', 'CLOSED'].includes(job.status)) {
      throw new ConflictError(
        'NOT_COMPLETE',
        'You can set up recurring service once this job is complete',
      )
    }
    if (job.recurringJobId) {
      throw new ConflictError('ALREADY_RECURRING', 'This job is already part of a recurring service')
    }

    const priceCents = body.priceCents ?? job.priceCents
    const policy = await resolvePolicy(deps.db, null)
    if (priceCents < policy.fees.minJobPriceCents) {
      throw new ValidationError(`The minimum job price is $${(policy.fees.minJobPriceCents / 100).toFixed(2)}`)
    }

    const existing = await deps.db.recurringJob.findFirst({
      where: {
        customerId: identity.userId, propertyId: job.propertyId,
        categoryId: job.categoryId, active: true,
      },
      select: { id: true },
    })
    if (existing) {
      throw new ConflictError(
        'ALREADY_SCHEDULED',
        'You already have recurring service for this job type at this property',
      )
    }

    const days = INTERVAL_DAYS[body.interval]!
    const recurring = await deps.db.recurringJob.create({
      data: {
        customerId: identity.userId,
        propertyId: job.propertyId,
        categoryId: job.categoryId,
        interval: body.interval,
        priceCents,
        specialInstructions: job.specialInstructions,
        equipmentProvided: job.equipmentProvided,
        // The next visit is one interval from now, not immediately — the work
        // was just done.
        nextRunAt: new Date(Date.now() + days * 86_400_000),
        ...(body.preferPreviousWorker && job.claimedByWorkerId
          ? { preferredWorkerId: job.claimedByWorkerId }
          : {}),
      },
      select: { id: true, interval: true, priceCents: true, nextRunAt: true, preferredWorkerId: true },
    })

    return reply.status(201).send(recurring)
  })

  app.get('/recurring', async (request) => {
    const identity = requireIdentity(request)
    const subscriptions = await deps.db.recurringJob.findMany({
      where: { customerId: identity.userId },
      orderBy: [{ active: 'desc' }, { nextRunAt: 'asc' }],
      select: {
        id: true, interval: true, priceCents: true, active: true,
        nextRunAt: true, lastRunAt: true, pausedUntil: true,
        category: { select: { id: true, name: true, icon: true } },
        property: { select: { id: true, label: true, city: true, state: true } },
        _count: { select: { jobs: true } },
      },
    })
    return { subscriptions }
  })

  /**
   * Pause, resume, reschedule, or cancel.
   *
   * Cancelling is deliberately easy and immediate. A recurring charge that is
   * hard to stop is the fastest way to lose a customer permanently and earn a
   * chargeback while doing it.
   */
  app.patch<{ Params: { id: string } }>('/recurring/:id', async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({
      active: z.boolean().optional(),
      interval: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY']).optional(),
      priceCents: z.number().int().positive().optional(),
      pauseUntil: z.coerce.date().nullable().optional(),
      nextRunAt: z.coerce.date().optional(),
    }).parse(request.body)

    const recurring = await deps.db.recurringJob.findUnique({
      where: { id: request.params.id },
      select: { id: true, customerId: true },
    })
    if (!recurring) throw new NotFoundError('Recurring service')
    if (recurring.customerId !== identity.userId) throw new ForbiddenError('That is not your recurring service')

    if (body.priceCents !== undefined) {
      const policy = await resolvePolicy(deps.db, null)
      if (body.priceCents < policy.fees.minJobPriceCents) {
        throw new ValidationError(`The minimum job price is $${(policy.fees.minJobPriceCents / 100).toFixed(2)}`)
      }
    }
    if (body.nextRunAt && body.nextRunAt < new Date()) {
      throw new ValidationError('The next visit must be in the future')
    }

    return deps.db.recurringJob.update({
      where: { id: request.params.id },
      data: {
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.interval !== undefined ? { interval: body.interval } : {}),
        ...(body.priceCents !== undefined ? { priceCents: body.priceCents } : {}),
        ...(body.pauseUntil !== undefined ? { pausedUntil: body.pauseUntil } : {}),
        ...(body.nextRunAt !== undefined ? { nextRunAt: body.nextRunAt } : {}),
      },
      select: {
        id: true, interval: true, priceCents: true, active: true,
        nextRunAt: true, pausedUntil: true,
      },
    })
  })
}
