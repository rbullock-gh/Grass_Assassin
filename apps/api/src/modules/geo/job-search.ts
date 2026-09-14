import { Prisma } from '@prisma/client'
import type { Db } from '../../lib/prisma.js'
import { milesToMeters, type LatLng } from '@grassassassin/shared'

/**
 * Spatial job search.
 *
 * This is the only module permitted to touch PostGIS columns. Prisma cannot
 * represent `geography` types, so every query here is raw SQL — written with
 * tagged-template parameterization (`Prisma.sql` / `${}`), which parameterizes
 * rather than interpolates and is therefore injection-safe. String
 * concatenation into these queries is forbidden.
 *
 * PRIVACY (docs/01-architecture.md §6): the public search deliberately selects
 * `j."approxLocation"` and never `j."exactLocation"`, and never joins to
 * properties for the street address. The masked data is not filtered out after
 * loading — it is never loaded. That is what makes the guarantee structural
 * rather than a convention someone can forget.
 */

export interface JobSearchFilters {
  center: LatLng
  radiusMiles: number
  minPayoutCents?: number
  categoryIds?: string[]
  equipmentProvided?: boolean
  difficulty?: 'EASY' | 'MODERATE' | 'HARD'
  dueBefore?: Date
  sort: 'DISTANCE' | 'PAY_DESC' | 'NEWEST' | 'DUE_SOON' | 'PAY_PER_HOUR'
  limit: number
  /** Worker performing the search; used to exclude blocked counterparties. */
  viewerUserId?: string
}

export interface JobSearchRow {
  id: string
  title: string
  description: string | null
  categoryId: string
  categoryName: string
  categoryIcon: string | null
  status: string
  priceCents: number
  workerPayoutCents: number
  yardSize: string | null
  estimatedMinutes: number | null
  difficulty: string
  equipmentProvided: boolean
  dueAt: Date
  windowStartAt: Date | null
  windowEndAt: Date | null
  postedAt: Date
  generalArea: string
  approxLat: number
  approxLng: number
  distanceMeters: number
  customerRating: number | null
  customerCompletedJobs: number
  isPremium: boolean
  isFeatured: boolean
}

/**
 * Finds claimable jobs near a point.
 *
 * Performance notes (QUICKSILVER):
 *  · ST_DWithin is index-assisted by the GIST index; ST_Distance in a WHERE
 *    clause is not, and would force a sequential scan. Distance is computed in
 *    the SELECT list only, where it runs on the already-filtered rows.
 *  · The partial index jobs_open_approx_location_gist covers status='POSTED',
 *    which is the only status this query returns.
 *  · The result is hard-limited; an unbounded map query is a denial of service
 *    waiting to happen.
 */
export async function searchNearbyJobs(db: Db, filters: JobSearchFilters): Promise<JobSearchRow[]> {
  const { center, radiusMiles, limit } = filters
  const radiusMeters = milesToMeters(radiusMiles)

  // Built once and reused in both the distance projection and the radius
  // predicate so the two can never disagree.
  const searchPoint = Prisma.sql`ST_SetSRID(ST_MakePoint(${center.lng}::float8, ${center.lat}::float8), 4326)::geography`

  const conditions: Prisma.Sql[] = [
    Prisma.sql`j."status" = 'POSTED'::"JobStatus"`,
    Prisma.sql`j."dueAt" > now()`,
    Prisma.sql`ST_DWithin(j."approxLocation", ${searchPoint}, ${radiusMeters}::float8)`,
  ]

  if (filters.minPayoutCents !== undefined) {
    conditions.push(Prisma.sql`j."workerPayoutCents" >= ${filters.minPayoutCents}`)
  }
  if (filters.categoryIds?.length) {
    conditions.push(Prisma.sql`j."categoryId" IN (${Prisma.join(filters.categoryIds)})`)
  }
  if (filters.equipmentProvided !== undefined) {
    conditions.push(Prisma.sql`j."equipmentProvided" = ${filters.equipmentProvided}`)
  }
  if (filters.difficulty) {
    conditions.push(Prisma.sql`j."difficulty" = ${filters.difficulty}::"Difficulty"`)
  }
  if (filters.dueBefore) {
    conditions.push(Prisma.sql`j."dueAt" <= ${filters.dueBefore}`)
  }
  if (filters.viewerUserId) {
    // A worker never sees jobs from a customer either party has blocked.
    conditions.push(Prisma.sql`
      NOT EXISTS (
        SELECT 1 FROM "user_blocks" b
        WHERE (b."blockerId" = ${filters.viewerUserId} AND b."blockedId" = j."customerId")
           OR (b."blockerId" = j."customerId" AND b."blockedId" = ${filters.viewerUserId})
      )`)
    // Never show a worker their own posted job.
    conditions.push(Prisma.sql`j."customerId" <> ${filters.viewerUserId}`)
  }

  // Featured jobs sort first within every ordering — visibility only, never
  // claim priority (strategy §5: featured is a customer product, not pay-to-win).
  const orderBy = (() => {
    switch (filters.sort) {
      case 'PAY_DESC':
        return Prisma.sql`j."isFeatured" DESC, j."workerPayoutCents" DESC, distance_meters ASC`
      case 'NEWEST':
        return Prisma.sql`j."isFeatured" DESC, j."postedAt" DESC`
      case 'DUE_SOON':
        return Prisma.sql`j."isFeatured" DESC, j."dueAt" ASC`
      case 'PAY_PER_HOUR':
        // NULLS LAST so jobs without an estimate do not masquerade as infinite value.
        return Prisma.sql`j."isFeatured" DESC, pay_per_hour_cents DESC NULLS LAST, distance_meters ASC`
      case 'DISTANCE':
      default:
        return Prisma.sql`j."isFeatured" DESC, distance_meters ASC`
    }
  })()

  return db.$queryRaw<JobSearchRow[]>(Prisma.sql`
    SELECT
      j."id",
      j."title",
      j."description",
      j."categoryId",
      c."name"  AS "categoryName",
      c."icon"  AS "categoryIcon",
      j."status"::text AS "status",
      j."priceCents",
      j."workerPayoutCents",
      j."yardSize"::text AS "yardSize",
      j."estimatedMinutes",
      j."difficulty"::text AS "difficulty",
      j."equipmentProvided",
      j."dueAt",
      j."windowStartAt",
      j."windowEndAt",
      j."postedAt",
      j."generalArea",
      -- Approximate location only. The exact column is deliberately absent.
      ST_Y(j."approxLocation"::geometry) AS "approxLat",
      ST_X(j."approxLocation"::geometry) AS "approxLng",
      ST_Distance(j."approxLocation", ${searchPoint}) AS "distanceMeters",
      cp."averageRating"  AS "customerRating",
      cp."jobsCompleted"  AS "customerCompletedJobs",
      j."isPremium",
      j."isFeatured",
      CASE
        WHEN j."estimatedMinutes" IS NULL OR j."estimatedMinutes" <= 0 THEN NULL
        ELSE (j."workerPayoutCents"::float8 * 60.0 / j."estimatedMinutes"::float8)
      END AS pay_per_hour_cents,
      ST_Distance(j."approxLocation", ${searchPoint}) AS distance_meters
    FROM "jobs" j
    JOIN "service_categories" c ON c."id" = j."categoryId"
    LEFT JOIN "customer_profiles" cp ON cp."userId" = j."customerId"
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `)
}

/**
 * Writes a job's location pair.
 *
 * Both columns are set in one statement so a job can never exist with an exact
 * location but no mask. The approximate point is supplied by the caller (it is
 * computed once in domain code) rather than generated here, because a fresh
 * random offset per write would be unreproducible in tests and per-request
 * randomization would be a privacy bug.
 */
export async function setJobLocations(
  db: Db,
  jobId: string,
  exact: LatLng,
  approx: LatLng,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "jobs"
       SET "exactLocation"  = ST_SetSRID(ST_MakePoint(${exact.lng}::float8,  ${exact.lat}::float8),  4326)::geography,
           "approxLocation" = ST_SetSRID(ST_MakePoint(${approx.lng}::float8, ${approx.lat}::float8), 4326)::geography
     WHERE "id" = ${jobId}
  `)
}

export async function setPropertyLocation(db: Db, propertyId: string, point: LatLng): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "properties"
       SET "location" = ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography
     WHERE "id" = ${propertyId}
  `)
}

export async function setWorkerBaseLocation(db: Db, workerProfileId: string, point: LatLng): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    UPDATE "worker_profiles"
       SET "baseLocation" = ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography
     WHERE "id" = ${workerProfileId}
  `)
}

/**
 * Exact location for a job — the privileged read.
 *
 * Callers MUST have already established that the requester holds the active
 * claim. This function does not check authorization itself; that lives in the
 * route handler where the requester's identity is known. It is named
 * `...ForClaimedJob` to make an unguarded call site obvious in review.
 */
export async function getExactLocationForClaimedJob(
  db: Db,
  jobId: string,
): Promise<LatLng | null> {
  const rows = await db.$queryRaw<Array<{ lat: number; lng: number }>>(Prisma.sql`
    SELECT ST_Y("exactLocation"::geometry) AS lat,
           ST_X("exactLocation"::geometry) AS lng
      FROM "jobs"
     WHERE "id" = ${jobId}
  `)
  const row = rows[0]
  return row ? { lat: row.lat, lng: row.lng } : null
}

/**
 * Workers whose service radius covers a job, for match notifications.
 *
 * Note the radius lives on the worker, so the predicate is "is this job within
 * THIS worker's radius" — not a fixed distance. ST_DWithin with a column as the
 * distance argument still uses the GIST index for the bounding-box stage.
 */
export async function findWorkersToNotify(
  db: Db,
  jobLocation: LatLng,
  categoryId: string,
  limit = 200,
): Promise<Array<{ userId: string; workerProfileId: string; distanceMeters: number }>> {
  const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${jobLocation.lng}::float8, ${jobLocation.lat}::float8), 4326)::geography`

  return db.$queryRaw(Prisma.sql`
    SELECT w."userId", w."id" AS "workerProfileId",
           ST_Distance(w."baseLocation", ${point}) AS "distanceMeters"
      FROM "worker_profiles" w
      JOIN "users" u ON u."id" = w."userId"
      JOIN "worker_services" ws ON ws."workerProfileId" = w."id" AND ws."categoryId" = ${categoryId}
     WHERE w."status" = 'APPROVED'::"WorkerStatus"
       AND u."status" = 'ACTIVE'::"AccountStatus"
       AND w."baseLocation" IS NOT NULL
       AND ST_DWithin(w."baseLocation", ${point}, w."serviceRadiusMiles" * 1609.344)
     ORDER BY "distanceMeters" ASC
     LIMIT ${limit}
  `)
}

/** Service-area gate — honest "not in your area yet" instead of an empty map. */
export async function isWithinServiceArea(db: Db, point: LatLng): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ ok: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "service_areas" sa
       WHERE sa."active" = true
         AND (
           (sa."boundary" IS NOT NULL AND ST_Intersects(sa."boundary",
              ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography))
           OR
           (sa."boundary" IS NULL AND sa."centerLocation" IS NOT NULL AND sa."radiusMiles" IS NOT NULL
            AND ST_DWithin(sa."centerLocation",
              ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography,
              sa."radiusMiles" * 1609.344))
         )
    ) AS ok
  `)
  return rows[0]?.ok ?? false
}
