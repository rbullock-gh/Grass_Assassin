/**
 * Files a report, so the admin render check has a decision form to draw.
 *
 * Same reason as open-dispute.ts: without an OPEN report the reports page shows
 * two tables and none of the moderation UI, and a visual check of that UI
 * passes while rendering nothing of it. The decision form on this page is where
 * somebody suspends a person's account; it is worth drawing.
 *
 * Development and CI only. Refuses to run against production.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This files a fake report. Not in production.')
  }

  const existing = await prisma.report.count({
    where: { status: { in: ['OPEN', 'REVIEWING'] } },
  })
  if (existing > 0) {
    console.log(`${existing} report(s) already open; nothing to do.`)
    return
  }

  const subject = await prisma.user.findFirst({
    where: { roles: { has: 'WORKER' }, status: 'ACTIVE', deletedAt: null },
    select: { id: true, firstName: true },
  })
  const reporter = await prisma.user.findFirst({
    where: { roles: { has: 'CUSTOMER' }, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  })
  if (!subject || !reporter) {
    throw new Error('Need a worker and a customer to file a report between. Seed first.')
  }

  const report = await prisma.report.create({
    data: {
      reporterId: reporter.id,
      subjectId: subject.id,
      category: 'UNSAFE_BEHAVIOUR',
      description:
        'He was running the mower with the discharge guard removed and shouted at my son '
        + 'when he came out to the porch.',
      status: 'OPEN',
    },
    select: { id: true },
  })
  console.log(`Filed report ${report.id} about ${subject.firstName}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
