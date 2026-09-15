/**
 * Wire contracts shared by the API, the mobile app, the web app, and the admin panel.
 *
 * These zod schemas are the single source of truth. The server validates with them,
 * the clients infer types from them, and the OpenAPI document is generated from them,
 * so a drift between client and server expectations is a compile error rather than a
 * production incident.
 */

import { z } from 'zod'
import { JOB_STATUSES } from '../domain/job-status.js'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const latitudeSchema = z.number().min(-90).max(90)
export const longitudeSchema = z.number().min(-180).max(180)

export const latLngSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
})

export const cuidSchema = z.string().min(1)

/** E.164. Storing anything else makes SMS delivery and dedup unreliable. */
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164 format, e.g. +15551234567')

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200)

// ---------------------------------------------------------------------------
// Query-string coercion
// ---------------------------------------------------------------------------

/**
 * HTTP query strings carry only strings, so a schema written for a JSON body
 * rejects them. These helpers bridge that gap correctly.
 *
 * `z.coerce.boolean()` is NOT usable here and is a genuine trap: it applies
 * JavaScript's Boolean(), and `Boolean("false") === true`. A filter written
 * with it silently returns the opposite of what the user asked for — which is
 * far worse than a validation error, because nobody notices.
 */
export const queryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => (typeof value === 'boolean' ? value : value === 'true' || value === '1'))

/**
 * A repeated query parameter arrives as an array, but a SINGLE occurrence
 * arrives as a bare string. Both must be accepted, or filtering by exactly one
 * category — the common case — fails.
 */
export function queryArray<T extends z.ZodTypeAny>(item: T) {
  return z.union([z.array(item), item.transform((value: z.infer<T>) => [value])])
}

/** Numbers from a query string, rejecting garbage rather than defaulting silently. */
export const queryNumber = z.coerce.number()

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  email: z.string().email().max(255),
  password: passwordSchema,
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80).optional(),
  phone: phoneSchema.optional(),
  /** Which side of the marketplace the user is signing up for first. */
  intent: z.enum(['CUSTOMER', 'WORKER']).default('CUSTOMER'),
})
export type RegisterInput = z.infer<typeof registerSchema>

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
})
export type LoginInput = z.infer<typeof loginSchema>

export const refreshSchema = z.object({ refreshToken: z.string().min(1) })

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
})
export type AuthTokens = z.infer<typeof authTokensSchema>

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export const yardSizeSchema = z.enum(['UNDER_QUARTER_ACRE', 'QUARTER_TO_HALF', 'HALF_TO_ONE', 'ONE_TO_TWO', 'OVER_TWO'])
export type YardSize = z.infer<typeof yardSizeSchema>

/** Midpoint acreage per bucket, used for duration and difficulty estimates. */
export const YARD_SIZE_ACRES: Record<YardSize, number> = {
  UNDER_QUARTER_ACRE: 0.15,
  QUARTER_TO_HALF: 0.375,
  HALF_TO_ONE: 0.75,
  ONE_TO_TWO: 1.5,
  OVER_TWO: 3,
}

export const createPropertySchema = z.object({
  label: z.string().min(1).max(80).default('Home'),
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(50),
  postalCode: z.string().min(3).max(20),
  countryCode: z.string().length(2).default('US'),
  location: latLngSchema,
  yardSize: yardSizeSchema,
  gateCode: z.string().max(60).optional(),
  hasDog: z.boolean().default(false),
  accessNotes: z.string().max(1000).optional(),
})
export type CreatePropertyInput = z.infer<typeof createPropertySchema>

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobStatusSchema = z.enum(JOB_STATUSES)

export const createJobSchema = z.object({
  propertyId: cuidSchema,
  categoryId: cuidSchema,
  title: z.string().min(3).max(120).optional(),
  description: z.string().max(2000).optional(),
  /** Job price in cents, excluding the customer service fee. */
  priceCents: z.number().int().positive(),
  yardSize: yardSizeSchema.optional(),
  dueAt: z.coerce.date(),
  windowStartAt: z.coerce.date().optional(),
  windowEndAt: z.coerce.date().optional(),
  equipmentProvided: z.boolean().default(false),
  specialInstructions: z.string().max(2000).optional(),
  photoIds: z.array(cuidSchema).max(10).default([]),
})
  .refine((v) => !v.windowStartAt || !v.windowEndAt || v.windowEndAt > v.windowStartAt, {
    message: 'Time window must end after it starts',
    path: ['windowEndAt'],
  })
export type CreateJobInput = z.infer<typeof createJobSchema>

export const jobSortSchema = z.enum(['DISTANCE', 'PAY_DESC', 'NEWEST', 'DUE_SOON', 'PAY_PER_HOUR'])
export type JobSort = z.infer<typeof jobSortSchema>

export const difficultySchema = z.enum(['EASY', 'MODERATE', 'HARD'])

/** Worker-facing job search. Every filter in the brief maps to a field here. */
export const searchJobsSchema = z.object({
  /** Search center. Defaults to the worker's current location on the client. */
  lat: latitudeSchema,
  lng: longitudeSchema,
  /** Search radius in miles. Capped server-side by the worker's allowed radius. */
  radiusMiles: z.number().positive().max(100).default(15),
  minPayoutCents: z.number().int().nonnegative().optional(),
  categoryIds: z.array(cuidSchema).max(20).optional(),
  equipmentProvided: z.boolean().optional(),
  difficulty: difficultySchema.optional(),
  /** Deadline falls today (worker-local). */
  dueToday: z.boolean().optional(),
  /** Deadline falls within the next 7 days. */
  dueThisWeek: z.boolean().optional(),
  sort: jobSortSchema.default('DISTANCE'),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type SearchJobsInput = z.infer<typeof searchJobsSchema>

/**
 * The same search, as it arrives over a query string.
 *
 * Kept as a separate schema rather than making the canonical one lenient: the
 * JSON body schema should still reject a string where a boolean belongs, and
 * only the HTTP edge needs the coercion.
 */
export const searchJobsQuerySchema = z.object({
  lat: queryNumber.pipe(latitudeSchema),
  lng: queryNumber.pipe(longitudeSchema),
  radiusMiles: queryNumber.pipe(z.number().positive().max(100)).default(15),
  minPayoutCents: queryNumber.pipe(z.number().int().nonnegative()).optional(),
  categoryIds: queryArray(cuidSchema).optional(),
  equipmentProvided: queryBoolean.optional(),
  difficulty: difficultySchema.optional(),
  dueToday: queryBoolean.optional(),
  dueThisWeek: queryBoolean.optional(),
  /**
   * The client's UTC offset in minutes, as Date.getTimezoneOffset() reports it
   * (positive WEST of UTC).
   *
   * Without this, "due today" means today in the SERVER's timezone. A worker in
   * Honolulu querying a UTC server would be shown jobs due tomorrow morning
   * their time as "today", and would miss jobs actually due today. For a
   * location-based marketplace that is not an edge case.
   */
  tzOffsetMinutes: queryNumber.pipe(z.number().int().min(-840).max(840)).optional(),
  sort: jobSortSchema.default('DISTANCE'),
  limit: queryNumber.pipe(z.number().int().min(1).max(100)).default(50),
  cursor: z.string().optional(),
})
export type SearchJobsQuery = z.infer<typeof searchJobsQuerySchema>

/**
 * A job as seen by a worker who has NOT claimed it.
 *
 * Note what is absent: no street address, no exact coordinate, no customer name,
 * no phone. The API never populates those fields for an unclaimed job — they are
 * not omitted by the client. See docs/01-architecture.md §6.
 */
export const publicJobSchema = z.object({
  id: cuidSchema,
  title: z.string(),
  description: z.string().nullable(),
  categoryId: cuidSchema,
  categoryName: z.string(),
  categoryIcon: z.string().nullable(),
  status: jobStatusSchema,
  priceCents: z.number().int(),
  workerPayoutCents: z.number().int(),
  yardSize: yardSizeSchema.nullable(),
  estimatedMinutes: z.number().int().nullable(),
  payPerHourCents: z.number().int().nullable(),
  difficulty: difficultySchema,
  equipmentProvided: z.boolean(),
  dueAt: z.date(),
  windowStartAt: z.date().nullable(),
  windowEndAt: z.date().nullable(),
  postedAt: z.date(),
  /** Offset location, 100-250m from the true point. */
  approximateLocation: latLngSchema,
  distanceMeters: z.number(),
  /** Coarse locality for display, e.g. "Brentwood, TN". Never a street address. */
  generalArea: z.string(),
  customerRating: z.number().nullable(),
  customerCompletedJobs: z.number().int(),
  photoUrls: z.array(z.string()).default([]),
  isPremium: z.boolean().default(false),
})
export type PublicJob = z.infer<typeof publicJobSchema>

export const claimJobSchema = z.object({
  jobId: cuidSchema,
  /** Worker's location at claim time. Used for fraud signals and distance audit. */
  workerLocation: latLngSchema.optional(),
})

export const claimResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('WON'),
    jobId: cuidSchema,
    claimId: cuidSchema,
    expiresAt: z.date(),
  }),
  z.object({
    outcome: z.literal('LOST'),
    jobId: cuidSchema,
    reason: z.enum([
      'ALREADY_CLAIMED',
      'NOT_AVAILABLE',
      'NOT_ELIGIBLE',
      'OUT_OF_RANGE',
      'PAYMENT_FAILED',
      'WORKER_NOT_APPROVED',
      'TOO_MANY_ACTIVE_JOBS',
      'EARLY_ACCESS_WINDOW',
    ]),
    message: z.string(),
  }),
])
export type ClaimResult = z.infer<typeof claimResultSchema>

export const jobStatusUpdateSchema = z.object({
  jobId: cuidSchema,
  to: jobStatusSchema,
  workerLocation: latLngSchema.optional(),
  note: z.string().max(1000).optional(),
})

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const createReviewSchema = z.object({
  jobId: cuidSchema,
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
  /** Structured tags reduce free-text moderation load and give us usable data. */
  tags: z.array(z.string().max(40)).max(6).default([]),
})
export type CreateReviewInput = z.infer<typeof createReviewSchema>

export const tipSchema = z.object({
  jobId: cuidSchema,
  amountCents: z.number().int().positive().max(100_000),
})

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Registering a device for push.
 *
 * The token shape is checked rather than accepted as any string. An Expo token
 * is `ExponentPushToken[…]` or `ExpertPushToken[…]`; anything else is either a
 * bug in the client or somebody probing, and either way sending it to Expo
 * burns a request to be told what we already knew.
 */
export const expoPushTokenSchema = z
  .string()
  .regex(/^Ex(ponent|pert)PushToken\[[^\]]+\]$/, 'That is not an Expo push token')

export const registerDeviceSchema = z.object({
  pushToken: expoPushTokenSchema,
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().max(32).optional(),
  /**
   * Minutes to SUBTRACT from UTC to get local time — the sign JavaScript's
   * getTimezoneOffset() uses, so a client can pass it through unchanged rather
   * than negating it and getting quiet hours backwards.
   */
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
})
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>

export const deregisterDeviceSchema = z.object({
  pushToken: expoPushTokenSchema,
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ApiError = z.infer<typeof apiErrorSchema>
