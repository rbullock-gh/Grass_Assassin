import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob, NASHVILLE,
} from '../../../test/factories.js'
import { searchNearbyJobs, getExactLocationForClaimedJob, findWorkersToNotify, isWithinServiceArea } from './job-search.js'
import { attemptClaim } from '../jobs/claim.js'
import {
  destinationPoint, milesToMeters, haversineMeters, metersToMiles,
  PRIVACY_OFFSET_MIN_METERS, PRIVACY_OFFSET_MAX_METERS,
} from '@grassassassin/shared'
import { Prisma } from '@prisma/client'

let categoryId: string
let customerId: string
let propertyId: string

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })

beforeEach(async () => {
  await resetDatabase()
  const category = await createCategory()
  const customer = await createCustomer()
  const property = await createProperty(customer.id)
  categoryId = category.id
  customerId = customer.id
  propertyId = property.id
})

const search = (overrides: Partial<Parameters<typeof searchNearbyJobs>[1]> = {}) =>
  searchNearbyJobs(prisma, {
    center: NASHVILLE, radiusMiles: 15, sort: 'DISTANCE', limit: 50, ...overrides,
  })

describe('address privacy — the guarantee must be structural', () => {
  it('never returns a street address or exact coordinate to an unclaimed worker', async () => {
    await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })

    const results = await search()
    expect(results).toHaveLength(1)
    const job = results[0]!

    // The serialised response must not contain the property's street address
    // anywhere, under any key.
    const serialised = JSON.stringify(job)
    expect(serialised).not.toContain('742 Evergreen Terrace')
    expect(serialised).not.toContain('Evergreen')

    // No key resembling an exact location is present at all — not empty, absent.
    expect(job).not.toHaveProperty('exactLocation')
    expect(job).not.toHaveProperty('exactLat')
    expect(job).not.toHaveProperty('addressLine1')

    // Only the coarse locality is exposed.
    expect(job.generalArea).toBe('Nashville, TN')
  })

  it('returns a location offset into the documented privacy band', async () => {
    await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })

    const job = (await search())[0]!
    const offset = haversineMeters(NASHVILLE, { lat: job.approxLat, lng: job.approxLng })

    expect(offset).toBeGreaterThanOrEqual(PRIVACY_OFFSET_MIN_METERS - 1)
    expect(offset).toBeLessThanOrEqual(PRIVACY_OFFSET_MAX_METERS + 1)
    expect(offset).toBeGreaterThan(0)
  })

  it('returns a stable offset across repeated searches, so it cannot be averaged away', async () => {
    // If the offset were recomputed per request, an observer could average many
    // samples and recover the true rooftop coordinate. It is persisted at write
    // time precisely to prevent that.
    await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })

    const samples = await Promise.all(Array.from({ length: 12 }, () => search()))
    const points = samples.map((s) => `${s[0]!.approxLat.toFixed(9)},${s[0]!.approxLng.toFixed(9)}`)

    expect(new Set(points).size).toBe(1)
  })

  it('releases the exact location only through the privileged claimed-job read', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })
    const { user } = await createWorker({ categoryId })
    const claim = await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })
    expect(claim.outcome).toBe('WON')

    const exact = await getExactLocationForClaimedJob(prisma, job.id)
    expect(exact).not.toBeNull()
    expect(exact!.lat).toBeCloseTo(NASHVILLE.lat, 5)
    expect(exact!.lng).toBeCloseTo(NASHVILLE.lng, 5)
  })

  it('drops a claimed job out of public search entirely', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, location: NASHVILLE })
    expect(await search()).toHaveLength(1)

    const { user } = await createWorker({ categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId: user.id })

    expect(await search()).toHaveLength(0)
  })
})

describe('radius search', () => {
  it('includes jobs inside the radius and excludes those outside', async () => {
    const near = destinationPoint(NASHVILLE, 0, milesToMeters(3))
    const far = destinationPoint(NASHVILLE, 0, milesToMeters(40))

    await createJob({ customerId, propertyId, categoryId, location: near, title: 'Near job' })
    await createJob({ customerId, propertyId, categoryId, location: far, title: 'Far job' })

    const results = await search({ radiusMiles: 10 })
    expect(results.map((r) => r.title)).toEqual(['Near job'])
  })

  it('reports a distance consistent with the returned point', async () => {
    const location = destinationPoint(NASHVILLE, 90, milesToMeters(5))
    await createJob({ customerId, propertyId, categoryId, location })

    const job = (await search())[0]!
    const computed = haversineMeters(NASHVILLE, { lat: job.approxLat, lng: job.approxLng })

    // PostGIS uses a spheroid and our client helper uses a sphere, so allow a
    // small divergence — but they must agree to well within a city block.
    expect(Math.abs(job.distanceMeters - computed)).toBeLessThan(60)
    expect(metersToMiles(job.distanceMeters)).toBeGreaterThan(4.5)
    expect(metersToMiles(job.distanceMeters)).toBeLessThan(5.5)
  })

  it('excludes jobs that are not POSTED', async () => {
    await createJob({ customerId, propertyId, categoryId, status: 'DRAFT', title: 'Draft' })
    await createJob({ customerId, propertyId, categoryId, status: 'POSTED', title: 'Live' })
    expect((await search()).map((r) => r.title)).toEqual(['Live'])
  })

  it('excludes jobs whose deadline has already passed', async () => {
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() - 3_600_000), title: 'Expired' })
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 3_600_000), title: 'Live' })
    expect((await search()).map((r) => r.title)).toEqual(['Live'])
  })

  it('honours the result limit so a wide search cannot be weaponised', async () => {
    for (let i = 0; i < 12; i++) {
      await createJob({ customerId, propertyId, categoryId, title: `Job ${i}` })
    }
    expect(await search({ limit: 5 })).toHaveLength(5)
  })
})

describe('filters', () => {
  it('filters by minimum payout', async () => {
    await createJob({ customerId, propertyId, categoryId, priceCents: 3000, title: 'Cheap' })
    await createJob({ customerId, propertyId, categoryId, priceCents: 12_000, title: 'Rich' })

    // $30 job pays out $26.40; $120 job pays out $105.60.
    const results = await search({ minPayoutCents: 5000 })
    expect(results.map((r) => r.title)).toEqual(['Rich'])
  })

  it('filters by category', async () => {
    const other = await createCategory({ slug: `leaves-${Date.now()}`, name: 'Leaf Removal' })
    await createJob({ customerId, propertyId, categoryId, title: 'Mow' })
    await createJob({ customerId, propertyId, categoryId: other.id, title: 'Leaves' })

    const results = await search({ categoryIds: [other.id] })
    expect(results.map((r) => r.title)).toEqual(['Leaves'])
  })

  it('filters by whether equipment is provided', async () => {
    await createJob({ customerId, propertyId, categoryId, equipmentProvided: true, title: 'Provided' })
    await createJob({ customerId, propertyId, categoryId, equipmentProvided: false, title: 'BYO' })

    expect((await search({ equipmentProvided: true })).map((r) => r.title)).toEqual(['Provided'])
    expect((await search({ equipmentProvided: false })).map((r) => r.title)).toEqual(['BYO'])
  })

  it('filters by deadline for the "today" and "this week" chips', async () => {
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 3 * 3_600_000), title: 'Today' })
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 5 * 86_400_000), title: 'Next week' })

    const results = await search({ dueBefore: new Date(Date.now() + 86_400_000) })
    expect(results.map((r) => r.title)).toEqual(['Today'])
  })

  it('hides a worker\'s own posted jobs from their map', async () => {
    const dualRole = await createCustomer()
    await prisma.workerProfile.create({
      data: { userId: dualRole.id, status: 'APPROVED', completedJobs: 20, averageRating: 4.9, completionRate: 1, onTimeRate: 1 },
    })
    const ownProperty = await createProperty(dualRole.id)
    await createJob({ customerId: dualRole.id, propertyId: ownProperty.id, categoryId, title: 'My own yard' })
    await createJob({ customerId, propertyId, categoryId, title: 'Someone else' })

    const results = await search({ viewerUserId: dualRole.id })
    expect(results.map((r) => r.title)).toEqual(['Someone else'])
  })

  it('hides jobs from a blocked customer', async () => {
    const { user: worker } = await createWorker({ categoryId })
    await createJob({ customerId, propertyId, categoryId, title: 'Blocked customer job' })
    await prisma.userBlock.create({ data: { blockerId: worker.id, blockedId: customerId } })

    expect(await search({ viewerUserId: worker.id })).toHaveLength(0)
  })

  it('hides jobs in both block directions', async () => {
    const { user: worker } = await createWorker({ categoryId })
    await createJob({ customerId, propertyId, categoryId, title: 'Job' })
    // Customer blocked the worker, rather than the other way round.
    await prisma.userBlock.create({ data: { blockerId: customerId, blockedId: worker.id } })

    expect(await search({ viewerUserId: worker.id })).toHaveLength(0)
  })
})

describe('sorting', () => {
  it('sorts by distance ascending', async () => {
    await createJob({ customerId, propertyId, categoryId, location: destinationPoint(NASHVILLE, 0, milesToMeters(8)), title: 'Far' })
    await createJob({ customerId, propertyId, categoryId, location: destinationPoint(NASHVILLE, 0, milesToMeters(1)), title: 'Close' })

    expect((await search({ sort: 'DISTANCE' })).map((r) => r.title)).toEqual(['Close', 'Far'])
  })

  it('sorts by payout descending', async () => {
    await createJob({ customerId, propertyId, categoryId, priceCents: 4000, title: 'Low' })
    await createJob({ customerId, propertyId, categoryId, priceCents: 15_000, title: 'High' })

    expect((await search({ sort: 'PAY_DESC' })).map((r) => r.title)).toEqual(['High', 'Low'])
  })

  it('sorts by soonest deadline', async () => {
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 5 * 86_400_000), title: 'Later' })
    await createJob({ customerId, propertyId, categoryId, dueAt: new Date(Date.now() + 3_600_000), title: 'Urgent' })

    expect((await search({ sort: 'DUE_SOON' })).map((r) => r.title)).toEqual(['Urgent', 'Later'])
  })

  it('sorts by pay per hour, not raw payout', async () => {
    // A $100 three-hour job pays less per hour than a $60 one-hour job. The
    // worker-facing point of this sort is that raw payout misleads.
    const big = await createJob({ customerId, propertyId, categoryId, priceCents: 10_000, title: 'Big but slow' })
    const quick = await createJob({ customerId, propertyId, categoryId, priceCents: 6000, title: 'Quick' })
    await prisma.job.update({ where: { id: big.id }, data: { estimatedMinutes: 180 } })
    await prisma.job.update({ where: { id: quick.id }, data: { estimatedMinutes: 45 } })

    const results = await search({ sort: 'PAY_PER_HOUR' })
    expect(results.map((r) => r.title)).toEqual(['Quick', 'Big but slow'])
  })

  it('does not let a job with no estimate masquerade as infinite value', async () => {
    const noEstimate = await createJob({ customerId, propertyId, categoryId, priceCents: 5000, title: 'Unknown' })
    const known = await createJob({ customerId, propertyId, categoryId, priceCents: 6000, title: 'Known' })
    await prisma.job.update({ where: { id: noEstimate.id }, data: { estimatedMinutes: null } })
    await prisma.job.update({ where: { id: known.id }, data: { estimatedMinutes: 30 } })

    const results = await search({ sort: 'PAY_PER_HOUR' })
    expect(results[0]!.title).toBe('Known')
    expect(results[1]!.title).toBe('Unknown')
  })

  it('floats featured jobs to the top without excluding anything', async () => {
    const featured = await createJob({ customerId, propertyId, categoryId, location: destinationPoint(NASHVILLE, 0, milesToMeters(9)), title: 'Featured far' })
    await createJob({ customerId, propertyId, categoryId, location: NASHVILLE, title: 'Ordinary close' })
    await prisma.job.update({ where: { id: featured.id }, data: { isFeatured: true } })

    const results = await search({ sort: 'DISTANCE' })
    expect(results.map((r) => r.title)).toEqual(['Featured far', 'Ordinary close'])
    // Critically: nothing was hidden. Featured buys position, never exclusivity.
    expect(results).toHaveLength(2)
  })
})

describe('worker match notifications', () => {
  it('finds approved workers whose radius covers the job and who do that work', async () => {
    const inRange = await createWorker({
      baseLocation: destinationPoint(NASHVILLE, 0, milesToMeters(4)),
      serviceRadiusMiles: 10, categoryId,
    })
    await createWorker({
      baseLocation: destinationPoint(NASHVILLE, 0, milesToMeters(40)),
      serviceRadiusMiles: 10, categoryId,
    })

    const matches = await findWorkersToNotify(prisma, NASHVILLE, categoryId)
    expect(matches.map((m) => m.userId)).toEqual([inRange.user.id])
  })

  it('skips workers who have not been approved', async () => {
    await createWorker({ status: 'PENDING_REVIEW', baseLocation: NASHVILLE, categoryId })
    expect(await findWorkersToNotify(prisma, NASHVILLE, categoryId)).toHaveLength(0)
  })

  it('skips workers who do not offer that category', async () => {
    const other = await createCategory({ slug: `pressure-${Date.now()}` })
    await createWorker({ baseLocation: NASHVILLE, categoryId: other.id })
    expect(await findWorkersToNotify(prisma, NASHVILLE, categoryId)).toHaveLength(0)
  })

  it('respects each worker\'s own radius rather than a fixed distance', async () => {
    const wide = await createWorker({
      baseLocation: destinationPoint(NASHVILLE, 0, milesToMeters(20)),
      serviceRadiusMiles: 30, categoryId,
    })
    await createWorker({
      baseLocation: destinationPoint(NASHVILLE, 0, milesToMeters(20)),
      serviceRadiusMiles: 5, categoryId,
    })

    const matches = await findWorkersToNotify(prisma, NASHVILLE, categoryId)
    expect(matches.map((m) => m.userId)).toEqual([wide.user.id])
  })
})

describe('service area gate', () => {
  it('reports false when no service area is active, rather than showing an empty map', async () => {
    expect(await isWithinServiceArea(prisma, NASHVILLE)).toBe(false)
  })

  it('matches a radius-defined service area', async () => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "service_areas" ("id","name","slug","centerLocation","radiusMiles","active","createdAt","updatedAt")
      VALUES ('sa1','Nashville','nashville',
        ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
        25, true, now(), now())
    `)
    expect(await isWithinServiceArea(prisma, NASHVILLE)).toBe(true)
    expect(await isWithinServiceArea(prisma, destinationPoint(NASHVILLE, 0, milesToMeters(60)))).toBe(false)
  })

  it('ignores an inactive service area', async () => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "service_areas" ("id","name","slug","centerLocation","radiusMiles","active","createdAt","updatedAt")
      VALUES ('sa2','Nashville','nashville',
        ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
        25, false, now(), now())
    `)
    expect(await isWithinServiceArea(prisma, NASHVILLE)).toBe(false)
  })
})
