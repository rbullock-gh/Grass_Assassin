import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerDeps } from '../server.js'
import { requireServiceAdmin } from '../context.js'
import { resolveDispute } from '../../modules/payments/settlement.js'

/**
 * Operations the admin dashboard performs on the marketplace's money.
 *
 * These live behind the API rather than in the dashboard for one reason: this
 * is the only process that holds the payment provider's credentials. A refund
 * should be issuable from exactly one place, and widening that to every
 * internal tool is how a marketplace ends up unable to say who moved what.
 *
 * Authenticated as a service acting for a named administrator — see
 * requireServiceAdmin, which verifies that administrator against the database
 * rather than believing the header.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  /**
   * Records a human's decision about a disputed job and settles the money.
   *
   * Takes the decision; does not make one. The reasoning is in resolveDispute:
   * every automatic rule is wrong in the case that matters, because what
   * happened on somebody's lawn is not knowable from here.
   */
  app.post<{ Params: { id: string } }>('/admin/disputes/:id/resolve', async (request, reply) => {
    const identity = await requireServiceAdmin(request, deps.db)

    const body = z.object({
      decision: z.enum(['WORKER', 'CUSTOMER', 'SPLIT']),
      refundCents: z.number().int().positive().optional(),
      // Required, and not trivially satisfiable. This text is what the customer
      // and the worker are told, and what anybody reviewing the decision later
      // has to go on; "ok" helps nobody and protects nobody.
      resolution: z.string().trim().min(20).max(2000),
    }).parse(request.body)

    const result = await resolveDispute(
      { db: deps.db, provider: deps.provider },
      { ...body, disputeId: request.params.id, resolvedById: identity.userId },
    )

    return reply.code(200).send(result)
  })
}
