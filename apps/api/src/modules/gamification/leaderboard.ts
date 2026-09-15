import { Prisma } from '@prisma/client'
import type { Db } from '../../lib/prisma.js'
import { periodBoundsFor, type LeaderboardPeriodKey } from '@grassassassin/shared'

/**
 * Reading a leaderboard.
 *
 * Three things were wrong with the version this replaces, and all three were
 * invisible from the code that produced them:
 *
 * The recompute worker wrote a full snapshot every fifteen minutes and NOTHING
 * READ IT. The endpoint recomputed from the point ledger on every request —
 * a GROUP BY across every point ever awarded, on the screen workers open most.
 *
 * The endpoint's window was ROLLING: "this week" meant the last 168 hours. The
 * worker used snapped calendar boundaries, and its own comment explains why:
 * "a weekly board that never resets is not weekly". The app labels the chip
 * "This week". So a worker's standing drifted as old points aged out of a
 * window that never restarted, and nobody ever won a week.
 *
 * And `scope: LOCAL` was accepted and then ignored — the SQL branched only on
 * ROOKIE. The app's "Near me" chip returned the identical list as "City".
 *
 * So: CITY and ROOKIE are served from the snapshot the worker already
 * computes. LOCAL is computed per request, because "near me" is a different
 * board for every caller and precomputing it would mean one board per worker.
 * All three use the same snapped boundaries.
 */

export type LeaderboardScopeKey = 'LOCAL' | 'CITY' | 'ROOKIE'

export interface LeaderboardEntryView {
  rank: number
  workerId: string
  firstName: string
  avatarUrl: string | null
  rankName: string | null
  points: number
  jobsCompleted: number
}

export interface LeaderboardView {
  /** The scope actually served, which is not always the one asked for. */
  scope: LeaderboardScopeKey
  period: LeaderboardPeriodKey
  periodStart: string
  periodEnd: string
  /** When these standings were computed. Null means they were computed now. */
  computedAt: string | null
  /**
   * Set when LOCAL was asked for and could not be answered — an anonymous
   * caller, or a worker who has not set a home base. The client says so rather
   * than silently showing the city board under a "Near me" heading.
   */
  fellBackFrom?: LeaderboardScopeKey
  entries: LeaderboardEntryView[]
}

export interface LeaderboardQuery {
  scope: LeaderboardScopeKey
  period: LeaderboardPeriodKey
  limit: number
  /** The signed-in user, when there is one. Only LOCAL needs it. */
  userId?: string
  now?: Date
}

/** How far "near me" reaches. Wide enough to be a real field, small enough to be local. */
export const LOCAL_RADIUS_MILES = 25

/** A worker is a rookie for their first twenty jobs. Mirrored in the recompute worker. */
export const ROOKIE_MAX_COMPLETED_JOBS = 20

const METERS_PER_MILE = 1609.344

interface Row {
  workerProfileId: string
  firstName: string
  avatarUrl: string | null
  rankName: string | null
  points: bigint | number
  jobsCompleted: bigint | number
}

export async function readLeaderboard(db: Db, query: LeaderboardQuery): Promise<LeaderboardView> {
  const now = query.now ?? new Date()
  const { start, end } = periodBoundsFor(query.period, now)

  if (query.scope === 'LOCAL') {
    const base = query.userId ? await homeBaseFor(db, query.userId) : null
    if (base) {
      return {
        scope: 'LOCAL',
        period: query.period,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        // Computed for this caller, right now: there is no snapshot to be stale.
        computedAt: null,
        entries: view(await liveRows(db, {
          since: start, limit: query.limit, rookieOnly: false, near: base,
        })),
      }
    }

    // Asked for LOCAL, cannot answer it. Serve the city board and SAY SO —
    // returning it silently under a "Near me" heading is the bug being fixed.
    const city = await readLeaderboard(db, { ...query, scope: 'CITY', now })
    return { ...city, fellBackFrom: 'LOCAL' }
  }

  const rookieOnly = query.scope === 'ROOKIE'
  const snapshot = await db.leaderboard.findFirst({
    where: {
      scope: query.scope,
      period: query.period,
      periodStart: start,
    },
    select: {
      computedAt: true,
      entries: {
        orderBy: { rank: 'asc' },
        take: query.limit,
        select: {
          rank: true, points: true, jobsCompleted: true,
          workerProfile: {
            select: {
              id: true,
              rank: { select: { name: true } },
              user: { select: { firstName: true, avatarUrl: true } },
            },
          },
        },
      },
    },
  })

  /*
   * Fall back to computing when there is no snapshot for this period yet.
   *
   * A board is empty for the first fifteen minutes of every week otherwise, and
   * on a fresh deployment it is empty until the worker first runs. An empty
   * leaderboard does not read as "not computed yet", it reads as broken.
   */
  if (!snapshot || snapshot.entries.length === 0) {
    return {
      scope: query.scope,
      period: query.period,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      computedAt: null,
      entries: view(await liveRows(db, {
        since: start, limit: query.limit, rookieOnly, near: null,
      })),
    }
  }

  return {
    scope: query.scope,
    period: query.period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    computedAt: snapshot.computedAt?.toISOString() ?? null,
    entries: snapshot.entries.map((entry) => ({
      rank: entry.rank,
      workerId: entry.workerProfile.id,
      firstName: entry.workerProfile.user.firstName,
      avatarUrl: entry.workerProfile.user.avatarUrl,
      rankName: entry.workerProfile.rank?.name ?? null,
      points: entry.points,
      jobsCompleted: entry.jobsCompleted,
    })),
  }
}

/** The caller's home base, if they are a worker who has set one. */
async function homeBaseFor(db: Db, userId: string): Promise<{ lat: number; lng: number } | null> {
  const rows = await db.$queryRaw<Array<{ lat: number | null; lng: number | null }>>(Prisma.sql`
    SELECT ST_Y("baseLocation"::geometry) AS lat, ST_X("baseLocation"::geometry) AS lng
      FROM "worker_profiles"
     WHERE "userId" = ${userId}
     LIMIT 1
  `)
  const row = rows[0]
  if (!row || row.lat === null || row.lng === null) return null
  return { lat: row.lat, lng: row.lng }
}

async function liveRows(db: Db, params: {
  since: Date
  limit: number
  rookieOnly: boolean
  near: { lat: number; lng: number } | null
}): Promise<Row[]> {
  const { since, limit, rookieOnly, near } = params

  return db.$queryRaw<Row[]>(Prisma.sql`
    SELECT w."id" AS "workerProfileId", u."firstName", u."avatarUrl",
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
       ${rookieOnly ? Prisma.sql`AND w."completedJobs" < ${ROOKIE_MAX_COMPLETED_JOBS}` : Prisma.empty}
       ${near
         ? Prisma.sql`AND w."baseLocation" IS NOT NULL
                      AND ST_DWithin(
                            w."baseLocation",
                            ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326)::geography,
                            ${LOCAL_RADIUS_MILES * METERS_PER_MILE}
                          )`
         : Prisma.empty}
     GROUP BY w."id", u."firstName", u."avatarUrl", r."name", w."completedJobs"
    HAVING COALESCE(SUM(GREATEST(pt."points", 0)), 0) > 0
     ORDER BY points DESC, "jobsCompleted" DESC, w."id" ASC
     LIMIT ${limit}
  `)
}

function view(rows: Row[]): LeaderboardEntryView[] {
  return rows.map((row, index) => ({
    rank: index + 1,
    workerId: row.workerProfileId,
    firstName: row.firstName,
    avatarUrl: row.avatarUrl,
    rankName: row.rankName,
    points: Number(row.points),
    jobsCompleted: Number(row.jobsCompleted),
  }))
}
