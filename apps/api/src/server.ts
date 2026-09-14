import { loadEnv } from './lib/env.js'
import { prisma } from './lib/prisma.js'
import { buildServer } from './http/server.js'
import { StripePaymentProvider } from './modules/payments/stripe-provider.js'
import { FakePaymentProvider } from './modules/payments/fake-provider.js'

/**
 * Process entry point.
 *
 * Environment is validated before anything else, so a missing secret crashes on
 * boot rather than producing a 500 under load at 3am.
 */
async function main() {
  const env = loadEnv()

  const provider = env.STRIPE_SECRET_KEY
    ? new StripePaymentProvider(env.STRIPE_SECRET_KEY)
    : new FakePaymentProvider()

  if (!env.STRIPE_SECRET_KEY) {
    if (env.NODE_ENV === 'production') {
      throw new Error('STRIPE_SECRET_KEY is required in production')
    }
    console.warn('⚠️  No STRIPE_SECRET_KEY — using the in-memory fake payment provider.')
  }

  const app = await buildServer({
    db: prisma,
    provider,
    config: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      ipSalt: env.JWT_REFRESH_SECRET,
      isProduction: env.NODE_ENV === 'production',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    },
  })

  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  console.log(`GrassAssassin API listening on :${env.PORT}`)

  // Drain in-flight requests before exiting, so a deploy does not drop a claim
  // mid-flight and leave a reservation stranded.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => prisma.$disconnect()).then(() => process.exit(0))
    })
  }
}

main().catch((error) => {
  console.error('Failed to start:', error)
  process.exit(1)
})
