import type { FastifyInstance } from 'fastify'
import { registerSchema, loginSchema, refreshSchema } from '@grassassassin/shared'
import { z } from 'zod'
import type { ServerDeps } from '../server.js'
import { register, login, changePassword, addRole } from '../../modules/auth/service.js'
import { rotateSession, revokeSession, revokeAllSessions } from '../../modules/auth/tokens.js'
import { hashIp } from '../../modules/auth/password.js'
import { requireIdentity } from '../context.js'

export async function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const authConfig = {
    accessSecret: deps.config.accessSecret,
    accessTtlSeconds: deps.config.accessTtlSeconds,
    refreshTtlDays: deps.config.refreshTtlDays,
  }

  const requestMeta = (request: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
    ipHash: hashIp(request.ip, deps.config.ipSalt),
  })

  app.post('/auth/register', {
    // Registration is the one endpoint where account existence leaks, so it is
    // rate limited far more tightly than the global default.
    config: app.rateLimits.enabled
      ? { rateLimit: { max: app.rateLimits.registerMax, timeWindow: '10 minutes' } }
      : {},
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body)
    const result = await register(deps.db, authConfig, { ...body, ...requestMeta(request) })
    return reply.status(201).send(result)
  })

  app.post('/auth/login', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: app.rateLimits.loginMax, timeWindow: '5 minutes' } }
      : {},
  }, async (request) => {
    const body = loginSchema.parse(request.body)
    return login(deps.db, authConfig, { ...body, ...requestMeta(request) })
  })

  app.post('/auth/refresh', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 60, timeWindow: '5 minutes' } }
      : {},
  }, async (request) => {
    const body = refreshSchema.parse(request.body)
    const result = await rotateSession(deps.db, {
      refreshToken: body.refreshToken, ...authConfig, ...requestMeta(request),
    })
    return result.tokens
  })

  app.post('/auth/logout', async (request, reply) => {
    const body = refreshSchema.parse(request.body)
    await revokeSession(deps.db, body.refreshToken)
    return reply.status(204).send()
  })

  app.post('/auth/logout-all', async (request, reply) => {
    const identity = requireIdentity(request)
    await revokeAllSessions(deps.db, identity.userId)
    return reply.status(204).send()
  })

  app.post('/auth/change-password', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(10).max(200),
    }).parse(request.body)

    await changePassword(deps.db, { userId: identity.userId, ...body })
    return reply.status(204).send()
  })

  app.post('/auth/add-role', async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({ role: z.enum(['CUSTOMER', 'WORKER']) }).parse(request.body)
    const roles = await addRole(deps.db, identity.userId, body.role)
    return { roles }
  })

  app.get('/me', async (request) => {
    const identity = requireIdentity(request)
    const user = await deps.db.user.findUniqueOrThrow({
      where: { id: identity.userId },
      select: {
        id: true, email: true, firstName: true, lastName: true, avatarUrl: true,
        roles: true, emailVerifiedAt: true, phoneVerifiedAt: true,
        customerProfile: {
          select: { averageRating: true, ratingCount: true, jobsPosted: true, jobsCompleted: true },
        },
        workerProfile: {
          select: {
            id: true, status: true, bio: true, serviceRadiusMiles: true,
            points: true, completedJobs: true, averageRating: true, ratingCount: true,
            completionRate: true, onTimeRate: true, currentStreak: true,
            availableBalanceCents: true, lifetimeEarningsCents: true,
            payoutsEnabled: true, backgroundCheckStatus: true,
            rank: { select: { key: true, name: true, minPoints: true, commissionDiscountBps: true, verifiedBadge: true } },
          },
        },
      },
    })
    return user
  })
}
