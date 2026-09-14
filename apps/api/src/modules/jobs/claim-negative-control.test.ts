import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob,
} from '../../../test/factories.js'
import { attemptClaim } from './claim.js'

/**
 * NEGATIVE CONTROL — does the concurrency test actually have teeth?
 *
 * A green concurrency test proves nothing on its own. If the test harness never
 * produces real contention (because the pool serialises, or because the claims
 * do not actually overlap in time), then "exactly one winner" would pass even
 * against a hopelessly broken implementation, and we would ship a race to
 * production believing it was covered.
 *
 * So this file runs the SAME contention scenario against a deliberately naive
 * check-then-act claim — the implementation a reasonable engineer writes first —
 * and asserts that it DOES double-book. If this test ever starts failing
 * (i.e. the naive version stops producing multiple winners), the harness has
 * stopped generating real concurrency and claim.test.ts has quietly become
 * worthless. That is a much more useful alarm than a green checkmark.
 */

/** The broken implementation. Never used in production — only as a control. */
async function naiveClaim(jobId: string, workerUserId: string): Promise<'WON' | 'LOST'> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true },
  })
  if (!job || job.status !== 'POSTED') return 'LOST'

  // Widen the check-then-act window so the race is reliably observable rather
  // than dependent on scheduler luck. The bug is present without this; the
  // delay only makes the demonstration deterministic.
  await new Promise((resolve) => setTimeout(resolve, 25))

  await prisma.job.update({
    where: { id: jobId },
    data: { status: 'CLAIM_PENDING_PAYMENT', claimedByWorkerId: workerUserId, claimExpiresAt: new Date(Date.now() + 90_000) },
  })
  return 'WON'
}

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

describe('negative control: the harness produces real contention', () => {
  it('shows the naive check-then-act claim DOES double-book the same job', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    const workers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createWorker({ email: `naive${i}-${Date.now()}@x.com`, categoryId })),
    )

    const results = await Promise.all(workers.map((w) => naiveClaim(job.id, w.user.id)))
    const winners = results.filter((r) => r === 'WON')

    // This is the bug, reproduced. If this assertion ever fails, the test
    // harness has stopped generating real concurrency — and the real claim
    // test's guarantee is no longer being exercised.
    expect(
      winners.length,
      'Expected the naive implementation to double-book. If it did not, the ' +
      'harness is no longer producing concurrent contention and claim.test.ts ' +
      'is not actually testing anything.',
    ).toBeGreaterThan(1)
  })

  it('shows the real implementation survives the identical scenario', async () => {
    // Same job count, same worker count, same tick — the only difference is
    // which claim implementation runs.
    const job = await createJob({ customerId, propertyId, categoryId })
    const workers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createWorker({ email: `real${i}-${Date.now()}@x.com`, categoryId })),
    )

    const results = await Promise.all(
      workers.map((w) => attemptClaim(prisma, { jobId: job.id, workerUserId: w.user.id })),
    )

    expect(results.filter((r) => r.outcome === 'WON')).toHaveLength(1)
  })
})
