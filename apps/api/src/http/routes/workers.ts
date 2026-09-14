import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { latLngSchema } from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { setWorkerBaseLocation } from '../../modules/geo/job-search.js'
import { displayableRating } from '../../modules/gamification/points.js'

export async function registerWorkerRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {

  app.patch('/worker/profile', async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({
      bio: z.string().max(1000).optional(),
      serviceRadiusMiles: z.number().positive().max(100).optional(),
      baseLocation: latLngSchema.optional(),
      categoryIds: z.array(z.string()).max(30).optional(),
      equipmentIds: z.array(z.string()).max(30).optional(),
    }).parse(request.body)

    const profile = await deps.db.workerProfile.findUnique({
      where: { userId: identity.userId },
      select: { id: true },
    })
    if (!profile) throw new NotFoundError('Worker profile')

    await deps.db.workerProfile.update({
      where: { id: profile.id },
      data: {
        ...(body.bio !== undefined ? { bio: body.bio } : {}),
        ...(body.serviceRadiusMiles !== undefined ? { serviceRadiusMiles: body.serviceRadiusMiles } : {}),
      },
    })

    if (body.baseLocation) {
      await setWorkerBaseLocation(deps.db, profile.id, body.baseLocation)
    }

    // Replace rather than merge: the UI presents these as a checkbox set, so
    // an unchecked box must actually remove the skill.
    if (body.categoryIds) {
      await deps.db.workerService.deleteMany({ where: { workerProfileId: profile.id } })
      await deps.db.workerService.createMany({
        data: body.categoryIds.map((categoryId) => ({ workerProfileId: profile.id, categoryId })),
        skipDuplicates: true,
      })
    }
    if (body.equipmentIds) {
      await deps.db.workerEquipment.deleteMany({ where: { workerProfileId: profile.id } })
      await deps.db.workerEquipment.createMany({
        data: body.equipmentIds.map((equipmentId) => ({ workerProfileId: profile.id, equipmentId })),
        skipDuplicates: true,
      })
    }

    return { ok: true }
  })

  /** Public worker profile, as a customer sees it before or after hiring. */
  app.get<{ Params: { id: string } }>('/workers/:id', async (request) => {
    const worker = await deps.db.workerProfile.findFirst({
      where: { OR: [{ id: request.params.id }, { userId: request.params.id }] },
      select: {
        id: true, userId: true, bio: true, points: true, completedJobs: true,
        averageRating: true, ratingCount: true, completionRate: true, onTimeRate: true,
        currentStreak: true, longestStreak: true, repeatCustomers: true, createdAt: true,
        user: { select: { firstName: true, avatarUrl: true } },
        rank: { select: { key: true, name: true, verifiedBadge: true, colorHex: true } },
        services: { select: { category: { select: { id: true, name: true, icon: true } } } },
        equipment: { select: { equipment: { select: { id: true, name: true, icon: true } } } },
        badges: { select: { badge: { select: { key: true, name: true, description: true } }, awardedAt: true } },
      },
    })
    if (!worker) throw new NotFoundError('Worker')

    const reviews = await deps.db.review.findMany({
      where: { subjectId: worker.userId, direction: 'CUSTOMER_TO_WORKER', hidden: false },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        rating: true, comment: true, tags: true, createdAt: true,
        author: { select: { firstName: true, avatarUrl: true } },
      },
    })

    // Note what is absent: no email, no phone, no exact home location. A public
    // profile is a reputation surface, not a contact card.
    return {
      id: worker.id,
      firstName: worker.user.firstName,
      avatarUrl: worker.user.avatarUrl,
      bio: worker.bio,
      rank: worker.rank,
      points: worker.points,
      completedJobs: worker.completedJobs,
      rating: displayableRating(worker.averageRating, worker.ratingCount),
      ratingCount: worker.ratingCount,
      completionRate: Number(worker.completionRate.toFixed(3)),
      onTimeRate: Number(worker.onTimeRate.toFixed(3)),
      currentStreak: worker.currentStreak,
      repeatCustomers: worker.repeatCustomers,
      memberSince: worker.createdAt,
      services: worker.services.map((s) => s.category),
      equipment: worker.equipment.map((e) => e.equipment),
      badges: worker.badges.map((b) => ({ ...b.badge, awardedAt: b.awardedAt })),
      reviews,
    }
  })

  app.get('/worker/earnings', async (request) => {
    const identity = requireIdentity(request)
    const profile = await deps.db.workerProfile.findUnique({
      where: { userId: identity.userId },
      select: { id: true, availableBalanceCents: true, pendingBalanceCents: true, lifetimeEarningsCents: true },
    })
    if (!profile) throw new NotFoundError('Worker profile')

    const since = new Date(Date.now() - 7 * 86_400_000)
    const [weekJobs, tips, payouts] = await Promise.all([
      deps.db.job.aggregate({
        where: {
          claimedByWorkerId: identity.userId,
          status: { in: ['APPROVED', 'PAID', 'CLOSED'] },
          approvedAt: { gte: since },
        },
        _sum: { workerPayoutCents: true },
        _count: true,
      }),
      deps.db.tip.aggregate({
        where: { toWorkerId: identity.userId, createdAt: { gte: since } },
        _sum: { amountCents: true },
      }),
      deps.db.payout.findMany({
        where: { workerProfileId: profile.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, amountCents: true, status: true, instant: true, arrivalDate: true, createdAt: true },
      }),
    ])

    return {
      availableBalanceCents: profile.availableBalanceCents,
      pendingBalanceCents: profile.pendingBalanceCents,
      lifetimeEarningsCents: profile.lifetimeEarningsCents,
      thisWeek: {
        earningsCents: (weekJobs._sum.workerPayoutCents ?? 0) + (tips._sum.amountCents ?? 0),
        jobsCompleted: weekJobs._count,
        tipsCents: tips._sum.amountCents ?? 0,
      },
      payouts,
    }
  })

  /**
   * Leaderboard.
   *
   * The ROOKIE scope exists so newcomers compete with peers rather than losing
   * to someone with 1,200 jobs — a board you cannot place on is a board you
   * stop opening.
   */
  app.get('/leaderboard', async (request) => {
    const query = z.object({
      scope: z.enum(['LOCAL', 'CITY', 'ROOKIE']).default('CITY'),
      period: z.enum(['WEEKLY', 'MONTHLY', 'ALL_TIME']).default('WEEKLY'),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(request.query)

    const since = query.period === 'WEEKLY'
      ? new Date(Date.now() - 7 * 86_400_000)
      : query.period === 'MONTHLY'
        ? new Date(Date.now() - 30 * 86_400_000)
        : new Date(0)

    const rows = await deps.db.$queryRaw<Array<{
      workerProfileId: string; userId: string; firstName: string; avatarUrl: string | null
      rankName: string | null; points: bigint; jobsCompleted: bigint
    }>>(Prisma.sql`
      SELECT w."id" AS "workerProfileId", w."userId", u."firstName", u."avatarUrl",
             r."name" AS "rankName",
             COALESCE(SUM(GREATEST(pt."points", 0)), 0)::bigint AS points,
             -- Lifetime completions from the profile, which recalculateReputation
             -- derives from primary data. Counting distinct jobIds in the point
             -- ledger would undercount any award recorded without a job link.
             w."completedJobs"::bigint AS "jobsCompleted"
        FROM "worker_profiles" w
        JOIN "users" u ON u."id" = w."userId"
        LEFT JOIN "ranks" r ON r."id" = w."rankId"
        LEFT JOIN "point_transactions" pt
               ON pt."workerProfileId" = w."id" AND pt."createdAt" >= ${since}
       WHERE w."status" = 'APPROVED'::"WorkerStatus"
         AND u."status" = 'ACTIVE'::"AccountStatus"
         ${query.scope === 'ROOKIE' ? Prisma.sql`AND w."completedJobs" < 20` : Prisma.empty}
       GROUP BY w."id", w."userId", u."firstName", u."avatarUrl", r."name", w."completedJobs"
       HAVING COALESCE(SUM(GREATEST(pt."points", 0)), 0) > 0
       ORDER BY points DESC, "jobsCompleted" DESC
       LIMIT ${query.limit}
    `)

    return {
      scope: query.scope,
      period: query.period,
      entries: rows.map((row, index) => ({
        rank: index + 1,
        workerId: row.workerProfileId,
        firstName: row.firstName,
        avatarUrl: row.avatarUrl,
        rankName: row.rankName,
        points: Number(row.points),
        jobsCompleted: Number(row.jobsCompleted),
      })),
    }
  })

  app.get('/equipment', async () => {
    const equipment = await deps.db.equipment.findMany({ orderBy: { sortOrder: 'asc' } })
    return { equipment }
  })
}
