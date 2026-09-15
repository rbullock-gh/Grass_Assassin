import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ServerDeps } from '../server.js'
import { requireIdentity, requireRole } from '../context.js'
import { ValidationError } from '../../lib/errors.js'
import {
  startPaymentMethodSetup, listSavedMethods, setDefaultPaymentMethod,
  startPayoutOnboarding, refreshPayoutReadiness, withdrawEarnings, listPayouts,
} from '../../modules/payments/billing.js'

/**
 * Getting set up to pay, and to be paid.
 *
 * These are the doors into the money. Everything behind them already existed and
 * had no route: the marketplace could charge a card and credit a worker, but only
 * for accounts whose provider ids had been written into the database by hand.
 *
 * Nothing here accepts a card number. The customer's device exchanges a
 * short-lived secret with the payment provider directly, and this server only
 * ever learns a reference — which is what keeps card data out of our logs, our
 * database and our backups.
 */

/**
 * Where the provider is allowed to send someone after onboarding.
 *
 * The provider redirects a browser to whatever we hand it, so an unchecked value
 * from the request body turns this into an open redirect wearing our domain. Only
 * the app's own scheme and our own base URL are accepted.
 */
function checkRedirect(url: string, publicBaseUrl: string | undefined): string {
  const allowed = ['grassassassin://', 'https://grassassassin.com/', 'https://www.grassassassin.com/']
  if (publicBaseUrl) allowed.push(publicBaseUrl.replace(/\/$/, '') + '/')

  if (!allowed.some((prefix) => url.startsWith(prefix))) {
    throw new ValidationError(
      'That return address is not one of ours. Use the app link or a grassassassin.com URL.',
    )
  }
  return url
}

export async function registerBillingRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const money = { db: deps.db, provider: deps.provider }

  // --- the customer's side --------------------------------------------------

  /**
   * Begins saving a card. Returns a client secret, never a form.
   *
   * Rate limited: each call creates a provider-side object, so an unbounded loop
   * here is a way to fill our provider account with junk at no cost to the caller.
   */
  app.post('/billing/setup-intent', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 20, timeWindow: '5 minutes' } }
      : {},
  }, async (request, reply) => {
    const identity = requireIdentity(request)
    const result = await startPaymentMethodSetup(money, identity.userId)
    return reply.code(201).send(result)
  })

  app.get('/billing/payment-methods', async (request) => {
    const identity = requireIdentity(request)
    return listSavedMethods(money, identity.userId)
  })

  /**
   * Chooses which saved card gets charged for the next job.
   *
   * The id is verified against this customer's own saved methods before it is
   * stored — a request naming a card is not evidence of owning it.
   */
  app.post('/billing/payment-methods/default', async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({ paymentMethodId: z.string().trim().min(1).max(200) })
      .parse(request.body)
    return setDefaultPaymentMethod(money, identity.userId, body.paymentMethodId)
  })

  // --- the worker's side ----------------------------------------------------

  /**
   * Starts payout onboarding and hands back the link to send them to.
   *
   * The identity checks live at the provider, deliberately. Tax details and bank
   * credentials are exactly the data this platform should never be holding.
   */
  app.post('/worker/payouts/onboard', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 20, timeWindow: '5 minutes' } }
      : {},
  }, async (request, reply) => {
    const identity = requireRole(request, 'WORKER')
    const body = z.object({
      returnUrl: z.string().trim().max(500).optional(),
      refreshUrl: z.string().trim().max(500).optional(),
    }).parse(request.body ?? {})

    const base = deps.config.publicBaseUrl
    const returnUrl = checkRedirect(body.returnUrl ?? 'grassassassin://payouts/done', base)
    const refreshUrl = checkRedirect(body.refreshUrl ?? 'grassassassin://payouts/retry', base)

    const result = await startPayoutOnboarding(money, identity.userId, { returnUrl, refreshUrl })
    return reply.code(201).send(result)
  })

  /**
   * What the provider currently says about this worker's account.
   *
   * Re-read rather than served from our copy: a worker who has just finished
   * onboarding comes straight back here, and telling them they are not set up
   * while a webhook is still in flight reads as the app being broken.
   */
  app.get('/worker/payouts/status', async (request) => {
    const identity = requireRole(request, 'WORKER')
    return refreshPayoutReadiness(money, identity.userId)
  })

  app.get('/worker/payouts', async (request) => {
    const identity = requireRole(request, 'WORKER')
    return { payouts: await listPayouts(money, identity.userId) }
  })

  /**
   * Moves a worker's available balance to their bank.
   *
   * Omitting the amount withdraws everything available, which is what the button
   * in the app does and what almost everyone wants.
   */
  app.post('/worker/payouts', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 10, timeWindow: '5 minutes' } }
      : {},
  }, async (request, reply) => {
    const identity = requireRole(request, 'WORKER')
    const body = z.object({
      amountCents: z.number().int().positive().max(1_000_000).optional(),
      instant: z.boolean().optional(),
    }).parse(request.body ?? {})

    const result = await withdrawEarnings(money, { userId: identity.userId, ...body })
    return reply.code(201).send(result)
  })
}
