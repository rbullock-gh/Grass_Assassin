import type { FastifyInstance } from 'fastify'
import { registerSchema, loginSchema, refreshSchema } from '@grassassassin/shared'
import { z } from 'zod'
import type { ServerDeps } from '../server.js'
import { register, login, changePassword, addRole } from '../../modules/auth/service.js'
import { rotateSession, revokeSession, revokeAllSessions } from '../../modules/auth/tokens.js'
import { hashIp } from '../../modules/auth/password.js'
import { requireIdentity } from '../context.js'
import { deleteAccount, deletionBlockers } from '../../modules/auth/deletion.js'
import { requestPasswordReset, resetPassword } from '../../modules/auth/password-reset.js'
import { ConsoleMailProvider } from '../../modules/mail/console-provider.js'

export async function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const authConfig = {
    accessSecret: deps.config.accessSecret,
    accessTtlSeconds: deps.config.accessTtlSeconds,
    refreshTtlDays: deps.config.refreshTtlDays,
  }

  // buildServer resolves this; the fallback keeps the route file usable on its
  // own and never sends, which is the right default for a thing that mails people.
  const mail = deps.mail ?? new ConsoleMailProvider(false)

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

  /**
   * What stands between this person and deleting their account.
   *
   * Separate from the delete itself so the confirmation screen can show every
   * blocker at once. Finding out about three of them one refusal at a time is
   * its own small cruelty.
   */
  app.get('/auth/delete-account', async (request) => {
    const identity = requireIdentity(request)
    return { blockers: await deletionBlockers(deps.db, identity.userId) }
  })

  /**
   * Deleting an account. Required by both app stores.
   *
   * The password is required: an account is not something an unattended phone
   * should be able to destroy, and a confirm dialog is no barrier to somebody
   * who has already picked the thing up.
   */
  app.post('/auth/delete-account', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 5, timeWindow: '15 minutes' } }
      : {},
  }, async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({ password: z.string().min(1) }).parse(request.body)
    return deleteAccount(deps.db, { userId: identity.userId, password: body.password })
  })

  /**
   * "I forgot my password."
   *
   * Public, because the whole point is that the person cannot authenticate.
   *
   * ALWAYS 202, always the same body, whether or not the address has an
   * account — and it replies BEFORE doing any of the work. That ordering is
   * the substance of the guarantee, not decoration: looking an address up,
   * writing a token and handing a message to a mail provider take measurably
   * longer than finding nothing, so any version that awaits the work leaks the
   * answer in the response time no matter how carefully the body is worded.
   *
   * A marketplace that knows where people live must not let anyone type
   * addresses into a public endpoint and learn which ones are customers.
   *
   * The rate limit is tight and keyed the same way the rest are. It is the
   * only thing standing between this and somebody walking a list of addresses
   * to generate mail, and — because the response says nothing — the abuse
   * worth stopping here is the mail volume, not the enumeration.
   */
  app.post('/auth/forgot-password', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 5, timeWindow: '15 minutes' } }
      : {},
  }, async (request, reply) => {
    const body = z.object({ email: z.string().email() }).parse(request.body)

    /*
     * Deliberately NOT awaited — but registered, so a shutdown drains it rather
     * than killing a reset between writing the token and sending the link.
     */
    app.background(requestPasswordReset(deps.db, mail, {
      email: body.email,
      ipHash: hashIp(request.ip, deps.config.ipSalt),
      ...(deps.config.resetLinkBase ? { linkBase: deps.config.resetLinkBase } : {}),
    }))

    return reply.status(202).send({
      message: 'If that address has an account, a reset link is on its way.',
    })
  })

  /**
   * Spending a reset link.
   *
   * Public for the same reason. Every failure — unknown, expired, already
   * used, suspended account — gives one identical message, so a stolen or
   * guessed token cannot be used to learn which guesses were once real.
   *
   * Succeeding signs the person out everywhere, including whoever else was in
   * the account, which is usually why somebody is doing this.
   */
  app.post('/auth/reset-password', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 10, timeWindow: '15 minutes' } }
      : {},
  }, async (request, reply) => {
    const body = z.object({
      token: z.string().min(1),
      newPassword: z.string().min(10).max(200),
    }).parse(request.body)

    await resetPassword(deps.db, body)
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
            // Counted, not listed. The app only needs to know whether this
            // worker has finished setup — a worker with no declared services
            // has nothing for job matching to match on, so they would never
            // hear about work and would conclude there is none.
            _count: { select: { services: true, equipment: true } },
          },
        },
      },
    })
    if (!user) return user

    return {
      ...user,
      workerProfile: user.workerProfile
        ? {
            ...user.workerProfile,
            serviceCount: user.workerProfile._count.services,
            equipmentCount: user.workerProfile._count.equipment,
            _count: undefined,
          }
        : null,
    }
  })
}
