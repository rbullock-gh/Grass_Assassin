import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'
import { AppError } from '../lib/errors.js'
import { InvalidTransitionError } from '@grassassassin/shared'
import { UnbalancedLedgerError } from '../modules/payments/ledger.js'
import { verifyAccessToken } from '../modules/auth/tokens.js'
import type { Db } from '../lib/prisma.js'
import type { PaymentProvider } from '../modules/payments/provider.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerJobRoutes } from './routes/jobs.js'
import { registerPropertyRoutes } from './routes/properties.js'
import { registerWorkerRoutes } from './routes/workers.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerPhotoRoutes } from './routes/photos.js'
import { registerRecurringRoutes } from './routes/recurring.js'
import { registerMessageRoutes } from './routes/messages.js'
import { registerDevStorageRoutes } from './routes/dev-storage.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerBillingRoutes } from './routes/billing.js'
import { registerDeviceRoutes } from './routes/devices.js'
import { registerSafetyRoutes } from './routes/safety.js'
import type { PushSender } from '../modules/notifications/notifier.js'
import { FakeStorageProvider, type StorageProvider } from '../modules/storage/provider.js'

export interface RateLimitSettings {
  enabled: boolean
  globalMax: number
  registerMax: number
  loginMax: number
  claimMax: number
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimits: RateLimitSettings
    routeManifest: RouteRecord[]
  }
}

export interface ServerDeps {
  db: Db
  provider: PaymentProvider
  /** Object storage for photos. Defaults to the in-memory fake. */
  storage?: StorageProvider
  /** Push delivery. Defaults to the recording sender in local development. */
  push?: PushSender
  config: {
    accessSecret: string
    accessTtlSeconds: number
    refreshTtlDays: number
    ipSalt: string
    isProduction: boolean
    /** Provider webhook signing secret. Webhooks are refused without it. */
    webhookSecret?: string
    /**
     * Where this server is reachable, e.g. http://192.168.1.4:4000.
     *
     * Used only in development, to make the fake storage provider hand out
     * upload URLs a phone on the same network can actually reach.
     */
    publicBaseUrl?: string
    /**
     * Rate limits, configurable so they can be tuned per environment and
     * disabled in tests. Production values are the defaults below — a test
     * suite must not be a reason to weaken a real limit.
     */
    rateLimits?: {
      enabled?: boolean
      globalMax?: number
      registerMax?: number
      loginMax?: number
      claimMax?: number
    }
  }
}

const DEFAULT_RATE_LIMITS = {
  enabled: true,
  globalMax: 300,
  registerMax: 10,
  loginMax: 10,
  claimMax: 30,
} as const

/** One registered route. Used by the suite that proves each one is protected. */
export interface RouteRecord {
  method: string
  url: string
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const resolved: ServerDeps & { storage: StorageProvider } = {
    ...deps,
    // publicBaseUrl makes the fake provider issue upload URLs that point back
    // at this server, so the presign → PUT → confirm chain actually works in
    // development. Without it the URL names a host that does not exist and the
    // app's upload path cannot be exercised anywhere but production.
    storage: deps.storage ?? new FakeStorageProvider(
      deps.config.isProduction ? null : (deps.config.publicBaseUrl ?? null),
    ),
  }

  const app = Fastify({
    logger: {
      level: deps.config.isProduction ? 'info' : 'warn',
      /**
       * Redaction.
       *
       * Fastify's default request serializer does not log headers, but an
       * unhandled error logged with its full context can carry a bearer token,
       * a password from a rejected request body, a customer's street address
       * or a gate code straight into a log aggregator that a far wider group
       * of people can read than should ever see them.
       *
       * Redacting at the logger is the only place this can be enforced once
       * rather than remembered at every call site.
       */
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["stripe-signature"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.currentPassword',
          '*.newPassword',
          '*.passwordHash',
          '*.accessToken',
          '*.refreshToken',
          '*.tokenHash',
          '*.gateCode',
          '*.addressLine1',
          '*.addressLine2',
          '*.phone',
          'err.meta.password',
        ],
        censor: '[redacted]',
      },
    },
    // Trust the proxy so rate limiting keys on the real client IP rather than
    // the load balancer's, which would rate-limit every user as one.
    trustProxy: true,
  })

  /*
   * Every route this server ends up serving, recorded as it is registered.
   *
   * Registered before anything else so it catches all of them. It exists so
   * that "does every route that should require a token actually require one"
   * can be asked of the server rather than of a hand-written list — the list
   * version silently passed the day /v1/devices was added, because nobody
   * remembered to add it, which is exactly how a route ships unprotected.
   */
  const routeManifest: RouteRecord[] = []
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      routeManifest.push({ method, url: route.url })
    }
  })
  app.decorate('routeManifest', routeManifest)

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, {
    origin: deps.config.isProduction ? [/\.grassassassin\.com$/] : true,
    credentials: true,
  })
  const limits = { ...DEFAULT_RATE_LIMITS, ...deps.config.rateLimits }
  if (limits.enabled) {
    await app.register(rateLimit, {
      max: limits.globalMax,
      timeWindow: '1 minute',
      // Key on the authenticated user when we have one, so a shared NAT does
      // not throttle a whole apartment block onto one bucket.
      keyGenerator: (request) => request.identity?.userId ?? request.ip,
    })
  }
  app.decorate('rateLimits', limits)

  // --- authentication -----------------------------------------------------

  app.decorateRequest('identity', undefined)

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) return
    const token = header.slice(7)
    try {
      const claims = await verifyAccessToken(token, deps.config.accessSecret)
      request.identity = { userId: claims.sub, roles: claims.roles }
    } catch {
      // A bad token is treated as no token. Routes that require identity will
      // reject with 401; routes that do not are unaffected.
    }
  })

  // --- error handling -----------------------------------------------------

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }

    if (error instanceof InvalidTransitionError) {
      return reply.status(409).send({
        error: { code: error.code, message: error.message },
      })
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request was not valid',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      })
    }

    if (error instanceof UnbalancedLedgerError) {
      // This must never reach a user. It means our books would have been
      // corrupted, so it is logged loudly and reported as a generic failure.
      request.log.error({ err: error }, 'Ledger imbalance prevented')
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our end' },
      })
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.status(409).send({
          error: { code: 'DUPLICATE', message: 'That already exists' },
        })
      }
      if (error.code === 'P2025') {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Not found' },
        })
      }
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
      })
    }

    /*
     * Fastify's own 4xx are the CLIENT's mistake, not ours.
     *
     * A DELETE sent with `content-type: application/json` and no body is
     * refused by the body parser with FST_ERR_CTP_EMPTY_JSON_BODY and
     * statusCode 400. Falling through to the catch-all below turned that into
     * a 500 and an error-level log line reading "Unhandled error" — so a
     * malformed request looked, to anyone watching the logs, exactly like the
     * server breaking. Found by sending one by hand; the test suite never saw
     * it because inject() does not set a content-type for an empty body.
     *
     * The code is passed through because Fastify's are already machine-
     * readable and specific; the message is not, because Fastify's can name
     * internals.
     */
    const status = (error as { statusCode?: number }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      request.log.info({ err: error }, 'Rejected a malformed request')
      return reply.status(status).send({
        error: {
          code: (error as { code?: string }).code ?? 'BAD_REQUEST',
          message: 'The request was not valid',
        },
      })
    }

    // Anything unrecognised is a bug. Log the detail, tell the client nothing —
    // stack traces and driver errors are an information leak.
    request.log.error({ err: error }, 'Unhandled error')
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our end' },
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } })
  })

  // --- routes -------------------------------------------------------------

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }))

  await app.register(async (instance) => {
    await registerAuthRoutes(instance, deps)
    await registerPropertyRoutes(instance, deps)
    await registerJobRoutes(instance, deps)
    await registerWorkerRoutes(instance, deps)
    await registerWebhookRoutes(instance, deps)
    await registerPhotoRoutes(instance, resolved)
    await registerRecurringRoutes(instance, resolved)
    await registerMessageRoutes(instance, deps)
    await registerAdminRoutes(instance, deps)
    await registerBillingRoutes(instance, deps)
    await registerDeviceRoutes(instance, deps)
    await registerSafetyRoutes(instance, deps)
  }, { prefix: '/v1' })

  // Outside /v1 on purpose: this stands in for S3, which is not part of our
  // versioned API. Development only, and it refuses to register itself against
  // a real storage provider.
  await registerDevStorageRoutes(app, resolved)

  return app
}
