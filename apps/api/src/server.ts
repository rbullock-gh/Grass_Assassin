import { loadEnv } from './lib/env.js'
import { prisma } from './lib/prisma.js'
import { buildServer } from './http/server.js'
import { StripePaymentProvider } from './modules/payments/stripe-provider.js'
import { FakePaymentProvider } from './modules/payments/fake-provider.js'
import { InMemoryQueue } from './modules/queue/queue.js'
import { BullMqQueue } from './modules/queue/bullmq-queue.js'
import { registerHandlers, registerSchedules } from './modules/queue/handlers.js'
import { Notifier, RecordingPushSender } from './modules/notifications/notifier.js'
import { ExpoPushSender } from './modules/notifications/expo-push.js'
import { ResendMailProvider } from './modules/mail/resend-provider.js'
import { ConsoleMailProvider } from './modules/mail/console-provider.js'
import type { Queue } from './modules/queue/queue.js'

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

  // Background work. Without Redis the process still serves requests — an API
  // that refuses to boot over a missing optional dependency is worse than one
  // that degrades and says so.
  let queue: Queue
  if (env.REDIS_URL) {
    queue = await BullMqQueue.connect(env.REDIS_URL)
  } else {
    queue = new InMemoryQueue()
    if (env.NODE_ENV === 'production') {
      console.warn('⚠️  No REDIS_URL in production — background jobs will not survive a restart.')
    } else {
      console.warn('⚠️  No REDIS_URL — using the in-memory queue. Scheduled work will not run.')
    }
  }

  /*
   * Real push, or a diary.
   *
   * This line said `new RecordingPushSender()` unconditionally, in production
   * too. Every notification the product sends — a job matched, a worker is on
   * the way, your money is released — was written to the notifications table
   * with sentAt set and then dropped on the floor. The system looked healthy
   * from the database and delivered nothing.
   */
  const pushEnabled = env.PUSH_ENABLED === 'true'
  const push = pushEnabled
    ? new ExpoPushSender({ accessToken: env.EXPO_ACCESS_TOKEN, db: prisma })
    : new RecordingPushSender()

  if (!pushEnabled) {
    console.warn(
      env.NODE_ENV === 'production'
        ? '⚠️  PUSH_ENABLED is not true — notifications will be recorded and NOT delivered.'
        : '⚠️  No push delivery — notifications are recorded only. Set PUSH_ENABLED=true to send.',
    )
  }

  /*
   * Email delivery.
   *
   * Same shape as push and for the same reason, with one addition: a
   * half-configured mail setup fails at BOOT rather than at the first reset.
   * EMAIL_ENABLED=true with no key or no from-address is somebody who believes
   * their password resets work. Finding out otherwise means finding out from a
   * locked-out user, which is the worst available moment.
   */
  const emailEnabled = env.EMAIL_ENABLED === 'true'
  if (emailEnabled && (!env.RESEND_API_KEY || !env.MAIL_FROM)) {
    throw new Error(
      'EMAIL_ENABLED=true but RESEND_API_KEY and MAIL_FROM are not both set.\n'
      + 'Password resets would be accepted and silently never delivered. Set both, '
      + 'or set EMAIL_ENABLED=false and accept that nobody can recover an account.',
    )
  }

  const mail = emailEnabled && env.RESEND_API_KEY && env.MAIL_FROM
    ? new ResendMailProvider({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM })
    : new ConsoleMailProvider(env.NODE_ENV !== 'production')

  if (!emailEnabled) {
    console.warn(
      env.NODE_ENV === 'production'
        ? '⚠️  EMAIL_ENABLED is not true — password reset emails will NOT be delivered, '
          + 'which means a locked-out user cannot recover their account.'
        : '⚠️  No email delivery — reset links are printed to this console instead.',
    )
  }

  const notifier = new Notifier(prisma, push)
  registerHandlers({
    db: prisma, provider, queue, notifier,
    ...(push instanceof ExpoPushSender ? { receipts: push } : {}),
  })
  await registerSchedules(queue)

  const app = await buildServer({
    db: prisma,
    provider,
    push,
    mail,
    config: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      ipSalt: env.JWT_REFRESH_SECRET,
      isProduction: env.NODE_ENV === 'production',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      // Development only. Set PUBLIC_BASE_URL to this machine's LAN address
      // (http://192.168.1.4:4000) and a phone on the same network can complete
      // a real photo upload against the local fake storage.
      publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
      resetLinkBase: env.RESET_LINK_BASE,
    },
  })

  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  console.log(`GrassAssassin API listening on :${env.PORT}`)

  // Drain in-flight requests before exiting, so a deploy does not drop a claim
  // mid-flight and leave a reservation stranded.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close()
        // Reset emails are sent behind the response, so closing the server is
        // not the same as having finished. Draining first means a deploy does
        // not leave somebody holding a token whose email was never sent.
        .then(() => app.settleBackground())
        .then(() => queue.close())
        .then(() => prisma.$disconnect())
        .then(() => process.exit(0))
    })
  }
}

main().catch((error) => {
  console.error('Failed to start:', error)
  process.exit(1)
})
