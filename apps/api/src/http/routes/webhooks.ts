import type { FastifyInstance } from 'fastify'
import type { ServerDeps } from '../server.js'
import { handleWebhook, WebhookSignatureError } from '../../modules/payments/webhooks.js'

export async function registerWebhookRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  /**
   * Payment provider webhooks.
   *
   * Registered in its own encapsulated scope with a RAW body parser. Stripe
   * signs the exact bytes it sent, so Fastify's default JSON parse-and-restore
   * would invalidate every signature — this is the single most common reason a
   * Stripe integration rejects all its own webhooks.
   *
   * Scoped rather than global so the rest of the API keeps normal JSON parsing.
   */
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => { done(null, body) },
    )

    scope.post('/webhooks/stripe', {
      // Deliberately exempt from the global limiter. A busy day genuinely
      // produces a burst of legitimate events, and throttling them makes the
      // provider retry — which makes the burst worse.
      config: { rateLimit: false },
    }, async (request, reply) => {
      const signature = request.headers['stripe-signature']
      if (typeof signature !== 'string') {
        return reply.status(400).send({
          error: { code: 'MISSING_SIGNATURE', message: 'Missing signature header' },
        })
      }

      if (!deps.config.webhookSecret) {
        request.log.error('Webhook received but no webhook secret is configured')
        return reply.status(500).send({
          error: { code: 'NOT_CONFIGURED', message: 'Webhooks are not configured' },
        })
      }

      try {
        const outcome = await handleWebhook(
          { db: deps.db, provider: deps.provider, webhookSecret: deps.config.webhookSecret },
          { rawBody: request.body as Buffer, signature },
        )
        // 200 on duplicate and ignored as well as processed: a non-2xx makes
        // the provider retry an event we have already handled or will never
        // handle, forever.
        return reply.status(200).send(outcome)
      } catch (error) {
        if (error instanceof WebhookSignatureError) {
          return reply.status(400).send({
            error: { code: error.code, message: error.message },
          })
        }
        throw error
      }
    })
  })
}
