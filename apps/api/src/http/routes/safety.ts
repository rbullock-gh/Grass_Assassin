import type { FastifyInstance } from 'fastify'
import { createReportSchema, createBlockSchema } from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { NotFoundError, ConflictError } from '../../lib/errors.js'

/**
 * Reporting a person, and refusing to be matched with them again.
 *
 * Both halves of this already existed except for the part that lets anyone use
 * them. The admin dashboard shipped a full reports-and-moderation queue reading
 * a table nothing could write to, so the queue was permanently empty. Job
 * search already excluded jobs between blocked pairs — correct SQL, an index on
 * the table — and nothing could create a block. In a product where a stranger
 * comes onto your property with a trimmer, that is the gap that matters most.
 *
 * The two are deliberately different in kind:
 *
 * A BLOCK is immediate, personal and needs no permission. Somebody who feels
 * unsafe should not have to wait for a review, and the cost of a wrong block is
 * that two people are not shown each other's work.
 *
 * A REPORT goes to a human. The brief was explicit that suspicious behaviour is
 * flagged for review rather than acted on automatically, and this is the
 * clearest case for it: an automated ban on a false accusation takes away
 * somebody's income, and there is no undo that gives the week back.
 */
export async function registerSafetyRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  app.post('/reports', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = createReportSchema.parse(request.body)

    if (body.subjectUserId === identity.userId) {
      throw new ConflictError('CANNOT_REPORT_SELF', 'You cannot report yourself.')
    }

    const subject = await deps.db.user.findUnique({
      where: { id: body.subjectUserId },
      select: { id: true, deletedAt: true },
    })
    if (!subject || subject.deletedAt) throw new NotFoundError('That person')

    /*
     * A job link is only accepted from someone who was actually on the job.
     *
     * Otherwise a report can be used to attach an accusation to a stranger's
     * job, and a reviewer opening the queue sees a case file that looks
     * corroborated and is not. Silently dropped rather than refused: the report
     * itself is still worth having, and arguing with someone about metadata
     * while they are trying to report being threatened is the wrong trade.
     */
    let jobId: string | null = null
    if (body.jobId) {
      const job = await deps.db.job.findUnique({
        where: { id: body.jobId },
        select: { id: true, customerId: true, claimedByWorkerId: true },
      })
      const involved = job
        && (job.customerId === identity.userId || job.claimedByWorkerId === identity.userId)
        && (job.customerId === body.subjectUserId || job.claimedByWorkerId === body.subjectUserId)
      if (involved) jobId = job.id
    }

    /*
     * Duplicate reports are folded rather than stacked.
     *
     * Somebody upset enough to file will often file twice. Three copies of the
     * same complaint in the queue is three times the review time and makes a
     * single incident look like a pattern, which is exactly the judgement a
     * reviewer is there to make for themselves.
     */
    const recent = await deps.db.report.findFirst({
      where: {
        reporterId: identity.userId,
        subjectId: body.subjectUserId,
        status: { in: ['OPEN', 'REVIEWING'] },
      },
      select: { id: true },
    })

    const report = recent
      ? await deps.db.report.update({
        where: { id: recent.id },
        data: {
          category: body.category,
          description: body.description,
          ...(jobId ? { jobId } : {}),
        },
        select: { id: true, status: true, createdAt: true },
      })
      : await deps.db.report.create({
        data: {
          reporterId: identity.userId,
          subjectId: body.subjectUserId,
          category: body.category,
          description: body.description,
          jobId,
        },
        select: { id: true, status: true, createdAt: true },
      })

    let blocked = false
    if (body.alsoBlock) {
      blocked = await block(deps, identity.userId, body.subjectUserId, `Reported: ${body.category}`)
    }

    return reply.status(201).send({
      report: { id: report.id, status: report.status, createdAt: report.createdAt },
      blocked,
      // Said back plainly, because "submitted" leaves someone wondering whether
      // anything happens next, and the honest answer is that a person reads it.
      message: 'Thanks — a person on our team reads every report. We will not '
        + 'tell them who reported them.',
    })
  })

  app.get('/blocks', async (request) => {
    const identity = requireIdentity(request)
    const blocks = await deps.db.userBlock.findMany({
      where: { blockerId: identity.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, createdAt: true, reason: true,
        blocked: { select: { id: true, firstName: true, avatarUrl: true } },
      },
    })
    return { blocks }
  })

  app.post('/blocks', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = createBlockSchema.parse(request.body)

    if (body.blockedUserId === identity.userId) {
      throw new ConflictError('CANNOT_BLOCK_SELF', 'You cannot block yourself.')
    }

    const subject = await deps.db.user.findUnique({
      where: { id: body.blockedUserId },
      select: { id: true, deletedAt: true },
    })
    if (!subject || subject.deletedAt) throw new NotFoundError('That person')

    await block(deps, identity.userId, body.blockedUserId, body.reason ?? null)
    return reply.status(201).send({ blocked: true })
  })

  app.delete<{ Params: { userId: string } }>('/blocks/:userId', async (request, reply) => {
    const identity = requireIdentity(request)
    await deps.db.userBlock.deleteMany({
      where: { blockerId: identity.userId, blockedId: request.params.userId },
    })
    // 204 whether or not a row went. Unblocking something already unblocked is
    // not an error worth showing anybody.
    return reply.status(204).send()
  })
}

/** Idempotent: blocking twice is what a frustrated person does. */
async function block(
  deps: ServerDeps,
  blockerId: string,
  blockedId: string,
  reason: string | null,
): Promise<boolean> {
  await deps.db.userBlock.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId, reason },
    update: {},
    select: { id: true },
  })
  return true
}
