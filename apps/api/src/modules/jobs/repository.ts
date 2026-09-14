import { Prisma } from '@prisma/client'
import type { Db } from '../../lib/prisma.js'
import { newId } from '../../lib/id.js'
import {
  quoteJob, computeApproximateLocation, YARD_SIZE_ACRES,
  type LatLng, type FeeConfig, type YardSize,
} from '@grassassassin/shared'

/**
 * Writes for the two tables that carry required PostGIS geography columns.
 *
 * Prisma Client refuses `create` on a model with a required `Unsupported()`
 * column, so these inserts are raw SQL. That is a feature rather than a
 * workaround: inserting the row and its geography in ONE statement means a job
 * can never exist, even for a microsecond, without a location — which a
 * create-then-update pair would allow, and which would break the NOT NULL
 * guarantee the rest of the system relies on.
 *
 * All SQL here is tagged-template parameterized and therefore injection-safe.
 */

export interface CreatePropertyParams {
  ownerId: string
  label: string
  addressLine1: string
  addressLine2?: string | null
  city: string
  state: string
  postalCode: string
  countryCode?: string
  location: LatLng
  yardSize: YardSize
  gateCode?: string | null
  hasDog?: boolean
  accessNotes?: string | null
  geocodeProvider?: string | null
  geocodePlaceId?: string | null
}

export async function createProperty(db: Db, params: CreatePropertyParams): Promise<{ id: string }> {
  const id = newId()
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "properties" (
      "id", "ownerId", "label", "addressLine1", "addressLine2", "city", "state",
      "postalCode", "countryCode", "location", "yardSize", "lotSizeAcres",
      "gateCode", "hasDog", "accessNotes", "geocodeProvider", "geocodePlaceId",
      "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${params.ownerId}, ${params.label}, ${params.addressLine1},
      ${params.addressLine2 ?? null}, ${params.city}, ${params.state},
      ${params.postalCode}, ${params.countryCode ?? 'US'},
      ST_SetSRID(ST_MakePoint(${params.location.lng}::float8, ${params.location.lat}::float8), 4326)::geography,
      ${params.yardSize}::"YardSize", ${YARD_SIZE_ACRES[params.yardSize]}::float8,
      ${params.gateCode ?? null}, ${params.hasDog ?? false}, ${params.accessNotes ?? null},
      ${params.geocodeProvider ?? null}, ${params.geocodePlaceId ?? null},
      now(), now()
    )
  `)
  return { id }
}

export interface CreateJobParams {
  customerId: string
  propertyId: string
  categoryId: string
  title: string
  description?: string | null
  specialInstructions?: string | null
  priceCents: number
  location: LatLng
  generalArea: string
  dueAt: Date
  windowStartAt?: Date | null
  windowEndAt?: Date | null
  yardSize?: YardSize | null
  equipmentProvided?: boolean
  feeConfig?: FeeConfig
  /** Injected in tests so the privacy offset is reproducible. */
  random?: () => number
  status?: 'DRAFT' | 'POSTED'
  recurringJobId?: string | null
}

/** Duration estimate, used for pay-per-hour sorting and the difficulty bonus. */
export function estimateMinutes(baseMinutes: number, yardSize: YardSize | null | undefined): number {
  if (!yardSize) return baseMinutes
  // baseMinutes is calibrated for a quarter-acre lot; scale by acreage with a
  // sublinear curve because setup and teardown do not scale with lot size.
  const acres = YARD_SIZE_ACRES[yardSize]
  const factor = Math.pow(acres / YARD_SIZE_ACRES.QUARTER_TO_HALF, 0.75)
  return Math.max(15, Math.round(baseMinutes * factor))
}

export function difficultyFor(categoryDifficulty: number, yardSize: YardSize | null | undefined): 'EASY' | 'MODERATE' | 'HARD' {
  const acres = yardSize ? YARD_SIZE_ACRES[yardSize] : 0.375
  const score = categoryDifficulty + (acres >= 1 ? 2 : acres >= 0.5 ? 1 : 0)
  if (score >= 5) return 'HARD'
  if (score >= 3) return 'MODERATE'
  return 'EASY'
}

/**
 * Creates a job with both its exact and masked locations in one statement.
 *
 * The privacy offset is computed here, once, and persisted. It is never
 * recomputed on read — a fresh offset per request would let an observer average
 * many responses and recover the true coordinate (docs/01-architecture.md §6).
 */
export async function createJob(db: Db, params: CreateJobParams): Promise<{ id: string }> {
  const id = newId()
  const quote = quoteJob(params.priceCents, params.feeConfig)
  const approx = computeApproximateLocation(params.location, params.random)

  const category = await db.serviceCategory.findUniqueOrThrow({
    where: { id: params.categoryId },
    select: { baseMinutes: true, difficulty: true },
  })

  const minutes = estimateMinutes(category.baseMinutes, params.yardSize)
  const difficulty = difficultyFor(category.difficulty, params.yardSize)
  const status = params.status ?? 'POSTED'

  await db.$executeRaw(Prisma.sql`
    INSERT INTO "jobs" (
      "id", "customerId", "propertyId", "categoryId", "title", "description",
      "specialInstructions", "status", "exactLocation", "approxLocation", "generalArea",
      "priceCents", "serviceFeeCents", "customerTotalCents",
      "workerCommissionCents", "workerPayoutCents",
      "dueAt", "windowStartAt", "windowEndAt",
      "yardSize", "estimatedMinutes", "difficulty", "equipmentProvided",
      "isPremium", "isFeatured", "postedAt", "recurringJobId", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${params.customerId}, ${params.propertyId}, ${params.categoryId},
      ${params.title}, ${params.description ?? null}, ${params.specialInstructions ?? null},
      ${status}::"JobStatus",
      ST_SetSRID(ST_MakePoint(${params.location.lng}::float8, ${params.location.lat}::float8), 4326)::geography,
      ST_SetSRID(ST_MakePoint(${approx.lng}::float8, ${approx.lat}::float8), 4326)::geography,
      ${params.generalArea},
      ${quote.jobPriceCents}, ${quote.serviceFeeCents}, ${quote.customerTotalCents},
      ${quote.workerCommissionCents}, ${quote.workerPayoutCents},
      ${params.dueAt}, ${params.windowStartAt ?? null}, ${params.windowEndAt ?? null},
      ${params.yardSize ?? null}::"YardSize", ${minutes}, ${difficulty}::"Difficulty",
      ${params.equipmentProvided ?? false},
      false, false,
      ${status === 'POSTED' ? new Date() : null},
      ${params.recurringJobId ?? null},
      now(), now()
    )
  `)

  await db.jobStatusEvent.create({
    data: {
      jobId: id, fromStatus: null, toStatus: status,
      actorId: params.customerId, actorType: 'CUSTOMER',
      note: status === 'POSTED' ? 'Job published' : 'Draft created',
    },
  })

  return { id }
}

/**
 * Marks the top quartile of currently open jobs by payout as premium.
 *
 * Premium status is what makes a job eligible for the brief early-access
 * window. It is recomputed on a schedule rather than set at creation, because
 * "top quartile" is a property of the current market, not of the job alone.
 */
export async function refreshPremiumFlags(db: Db): Promise<number> {
  return db.$executeRaw(Prisma.sql`
    WITH ranked AS (
      SELECT "id",
             percent_rank() OVER (ORDER BY "workerPayoutCents") AS pr
        FROM "jobs"
       WHERE "status" = 'POSTED'::"JobStatus"
    )
    UPDATE "jobs" j
       SET "isPremium" = (r.pr >= 0.75)
      FROM ranked r
     WHERE j."id" = r."id"
       AND j."isPremium" IS DISTINCT FROM (r.pr >= 0.75)
  `)
}
