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
  }
}

export interface ServerDeps {
  db: Db
  provider: PaymentProvider
  config: {
    accessSecret: string
    accessTtlSeconds: number
    refreshTtlDays: number
    ipSalt: string
    isProduction: boolean
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

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.isProduction
      ? { level: 'info' }
      : { level: 'warn' },
    // Trust the proxy so rate limiting keys on the real client IP rather than
    // the load balancer's, which would rate-limit every user as one.
    trustProxy: true,
  })

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
  }, { prefix: '/v1' })

  return app
}
