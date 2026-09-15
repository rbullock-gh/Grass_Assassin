/**
 * Opens a dispute on a finished job, so the admin render check has a decision
 * form to draw.
 *
 * Without one the disputes page shows a table and nothing else, and a visual
 * check of the dispute UI passes while rendering none of it. That happened; the
 * render script now fails instead of skipping, and this is what feeds it.
 *
 * Development and CI only. Refuses to run against production.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This opens a fake dispute. Not in production.')
  }

  const existing = await prisma.dispute.count({
    where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
  })
  if (existing > 0) {
    console.log(`${existing} dispute(s) already open; nothing to do.`)
    return
  }

  const job = await prisma.job.findFirst({
    where: {
      status: { in: ['PAID', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED'] },
      claimedByWorkerId: { not: null },
      disputes: { none: {} },
    },
    select: { id: true, customerId: true, claimedByWorkerId: true, customerTotalCents: true },
  })
  if (!job) {
    throw new Error('No finished job to dispute. Seed the database first.')
  }

  await prisma.job.update({ where: { id: job.id }, data: { status: 'DISPUTED' } })
  const dispute = await prisma.dispute.create({
    data: {
      jobId: job.id,
      openedById: job.customerId,
      againstId: job.claimedByWorkerId as string,
      reason: 'INCOMPLETE',
      description:
        'The back third of the lawn was never touched and the edging along the driveway ' +
        'was skipped entirely.',
      status: 'OPEN',
    },
    select: { id: true },
  })
  console.log(`Opened dispute ${dispute.id} on job ${job.id} (${job.customerTotalCents}c)`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
