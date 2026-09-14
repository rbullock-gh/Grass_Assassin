import { PrismaClient, Prisma } from '@prisma/client'
import type { LatLng } from '@grassassassin/shared'
import { createProperty as repoCreateProperty, createJob as repoCreateJob } from '../src/modules/jobs/repository.js'

export const prisma = new PrismaClient()

export const NASHVILLE: LatLng = { lat: 36.1627, lng: -86.7816 }

let counter = 0
const uid = () => `t${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * Truncates every table between tests.
 *
 * RESTART IDENTITY CASCADE rather than DELETE so foreign keys do not require a
 * dependency-ordered teardown that drifts as the schema grows.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>(Prisma.sql`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '_prisma%'
       AND tablename NOT IN ('spatial_ref_sys')
  `)
  if (tables.length === 0) return
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}

export async function createCategory(overrides: Partial<{ slug: string; name: string; difficulty: number }> = {}) {
  const slug = overrides.slug ?? `cat-${uid()}`
  return prisma.serviceCategory.create({
    data: {
      slug,
      name: overrides.name ?? 'Lawn Mowing',
      difficulty: overrides.difficulty ?? 1,
      baseMinutes: 45,
      typicalLowCents: 4500,
      typicalHighCents: 7500,
      active: true,
    },
  })
}

export async function createCustomer(overrides: Partial<{ email: string; rating: number; completedJobs: number }> = {}) {
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `cust-${uid()}@example.com`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Casey',
      roles: ['CUSTOMER'],
      emailVerifiedAt: new Date(),
    },
  })
  await prisma.customerProfile.create({
    data: {
      userId: user.id,
      averageRating: overrides.rating ?? 4.8,
      ratingCount: 12,
      jobsCompleted: overrides.completedJobs ?? 10,
    },
  })
  return user
}

export interface CreateWorkerOptions {
  email?: string
  status?: 'PENDING_ONBOARDING' | 'PENDING_REVIEW' | 'APPROVED' | 'SUSPENDED' | 'REJECTED'
  points?: number
  completedJobs?: number
  averageRating?: number
  completionRate?: number
  onTimeRate?: number
  serviceRadiusMiles?: number
  maxActiveJobs?: number
  baseLocation?: LatLng
  categoryId?: string
}

export async function createWorker(opts: CreateWorkerOptions = {}) {
  const user = await prisma.user.create({
    data: {
      email: opts.email ?? `worker-${uid()}@example.com`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Riley',
      roles: ['WORKER'],
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    },
  })

  const profile = await prisma.workerProfile.create({
    data: {
      userId: user.id,
      status: opts.status ?? 'APPROVED',
      points: opts.points ?? 0,
      completedJobs: opts.completedJobs ?? 25,
      averageRating: opts.averageRating ?? 4.9,
      completionRate: opts.completionRate ?? 1,
      onTimeRate: opts.onTimeRate ?? 1,
      serviceRadiusMiles: opts.serviceRadiusMiles ?? 15,
      maxActiveJobs: opts.maxActiveJobs ?? 3,
      payoutsEnabled: true,
      chargesEnabled: true,
      backgroundCheckStatus: 'CLEAR',
    },
  })

  const base = opts.baseLocation ?? NASHVILLE
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "worker_profiles"
       SET "baseLocation" = ST_SetSRID(ST_MakePoint(${base.lng}::float8, ${base.lat}::float8), 4326)::geography
     WHERE "id" = ${profile.id}
  `)

  if (opts.categoryId) {
    await prisma.workerService.create({
      data: { workerProfileId: profile.id, categoryId: opts.categoryId },
    })
  }

  return { user, profile }
}

export async function createProperty(ownerId: string, location: LatLng = NASHVILLE) {
  // Uses the production repository rather than a parallel insert, so the tests
  // exercise the same code path the API does.
  const { id } = await repoCreateProperty(prisma, {
    ownerId,
    label: 'Home',
    addressLine1: '742 Evergreen Terrace',
    city: 'Nashville',
    state: 'TN',
    postalCode: '37201',
    location,
    yardSize: 'QUARTER_TO_HALF',
  })
  return prisma.property.findUniqueOrThrow({ where: { id } })
}

export interface CreateJobOptions {
  customerId: string
  propertyId: string
  categoryId: string
  priceCents?: number
  status?: 'DRAFT' | 'POSTED' | 'CLAIM_PENDING_PAYMENT' | 'CLAIMED'
  location?: LatLng
  dueAt?: Date
  estimatedMinutes?: number
  equipmentProvided?: boolean
  difficulty?: 'EASY' | 'MODERATE' | 'HARD'
  isPremium?: boolean
  isFeatured?: boolean
  postedAt?: Date
  title?: string
}

export async function createJob(opts: CreateJobOptions) {
  const location = opts.location ?? NASHVILLE
  const status = opts.status ?? 'POSTED'

  const { id } = await repoCreateJob(prisma, {
    customerId: opts.customerId,
    propertyId: opts.propertyId,
    categoryId: opts.categoryId,
    title: opts.title ?? 'Mow the lawn',
    description: 'Front and back, please.',
    priceCents: opts.priceCents ?? 6000,
    location,
    generalArea: 'Nashville, TN',
    dueAt: opts.dueAt ?? new Date(Date.now() + 86_400_000),
    yardSize: 'QUARTER_TO_HALF',
    equipmentProvided: opts.equipmentProvided ?? false,
    // Fixed source so the privacy offset is reproducible across runs.
    random: () => 0.5,
    status: status === 'DRAFT' ? 'DRAFT' : 'POSTED',
  })

  // Test-only fixture states the repository does not produce directly.
  const patch: Record<string, unknown> = {}
  if (opts.estimatedMinutes !== undefined) patch['estimatedMinutes'] = opts.estimatedMinutes
  if (opts.difficulty !== undefined) patch['difficulty'] = opts.difficulty
  if (opts.isPremium !== undefined) patch['isPremium'] = opts.isPremium
  if (opts.isFeatured !== undefined) patch['isFeatured'] = opts.isFeatured
  if (opts.postedAt !== undefined) patch['postedAt'] = opts.postedAt
  if (status === 'CLAIM_PENDING_PAYMENT' || status === 'CLAIMED') patch['status'] = status
  if (Object.keys(patch).length > 0) {
    await prisma.job.update({ where: { id }, data: patch as never })
  }

  return prisma.job.findUniqueOrThrow({ where: { id } })
}
