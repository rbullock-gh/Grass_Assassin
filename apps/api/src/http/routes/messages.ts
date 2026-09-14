import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  screenMessage, conversationIsOpen, closedReason, MAX_MESSAGE_LENGTH,
} from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { NotFoundError, ForbiddenError, ConflictError } from '../../lib/errors.js'
import { Notifier, RecordingPushSender } from '../../modules/notifications/notifier.js'

/**
 * In-app messaging.
 *
 * This is not a chat feature bolted on for completeness — it is what makes the
 * privacy promise keepable. The product says a personal phone number is not
 * exposed by default, and that is only honest if the two people on a job have
 * another way to reach each other. Without this, "what gate do I use?" has
 * exactly one answer, and it is a phone number.
 *
 * A thread exists only for a job, is visible only to its two parties, and
 * closes a week after the job ends. There is no way to message someone you have
 * no job with — a directory of strangers' names, searchable, is a different and
 * much worse product.
 */
export async function registerMessageRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  // The recording sender is the local/dev default: it stores what would have
  // been sent so the notification path is exercised rather than stubbed out,
  // and a real sender is injected in production.
  const notifier = new Notifier(deps.db, deps.push ?? new RecordingPushSender())

  /** Every thread the caller is a party to. */
  app.get('/conversations', async (request) => {
    const identity = requireIdentity(request)

    const conversations = await deps.db.conversation.findMany({
      where: { OR: [{ customerId: identity.userId }, { workerId: identity.userId }] },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        id: true, jobId: true, customerId: true, workerId: true,
        lastMessageAt: true, closedAt: true, createdAt: true,
        job: {
          select: {
            id: true, title: true, status: true, dueAt: true,
            closedAt: true, cancelledAt: true,
            category: { select: { name: true, icon: true } },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { body: true, kind: true, senderId: true, createdAt: true },
        },
      },
    })

    // Counted in one grouped query rather than per row: a worker with sixty
    // threads would otherwise cost sixty round trips to render one list.
    const unreadRows = await deps.db.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: conversations.map((c) => c.id) },
        readAt: null,
        senderId: { not: identity.userId },
      },
      _count: { _all: true },
    })
    const unread = new Map(unreadRows.map((row) => [row.conversationId, row._count._all]))

    return {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        jobId: conversation.jobId,
        job: conversation.job,
        counterpartId: counterpartOf(conversation, identity.userId),
        lastMessage: conversation.messages[0] ?? null,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: unread.get(conversation.id) ?? 0,
        open: openness(conversation).open,
      })),
    }
  })

  /**
   * One thread, addressed by its job.
   *
   * By job rather than by conversation id because that is what every caller
   * actually has: the job screen opens the thread for the job it is showing.
   */
  app.get<{ Params: { id: string } }>('/jobs/:id/messages', async (request) => {
    const identity = requireIdentity(request)
    const { conversation, counterpart } = await loadThread(deps, request.params.id, identity.userId)

    const messages = await deps.db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true, senderId: true, kind: true, body: true, attachmentUrl: true,
        readAt: true, createdAt: true,
      },
    })

    // Marking read on open, not on send: the sender already knows what they
    // wrote, and a read receipt that fires before anyone looked is a lie.
    await deps.db.message.updateMany({
      where: { conversationId: conversation.id, readAt: null, senderId: { not: identity.userId } },
      data: { readAt: new Date() },
    })

    const state = openness(conversation)
    return {
      conversationId: conversation.id,
      jobId: conversation.jobId,
      open: state.open,
      closedReason: state.reason,
      counterpart,
      messages,
    }
  })

  /** Sends a message. */
  app.post<{ Params: { id: string } }>('/jobs/:id/messages', {
    // A per-sender limit. Not to stop conversation — nobody types forty
    // messages a minute — but to stop a script using the thread as a firehose
    // at somebody's push notifications.
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 40, timeWindow: '1 minute' } }
      : {},
  }, async (request, reply) => {
    const identity = requireIdentity(request)
    const body = z.object({
      body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    }).parse(request.body)

    const { conversation, counterpart } = await loadThread(deps, request.params.id, identity.userId)

    const state = openness(conversation)
    if (!state.open) {
      throw new ConflictError('CONVERSATION_CLOSED', state.reason ?? 'This conversation is closed')
    }

    // Screened, never blocked. A flagged message is delivered and a human
    // reviews it — see the reasoning in the shared domain module.
    const screening = screenMessage(body.body)

    const now = new Date()
    const message = await deps.db.message.create({
      data: {
        conversationId: conversation.id,
        senderId: identity.userId,
        kind: 'TEXT',
        body: body.body,
        flagged: screening.flagged,
        flagReason: screening.reasons.join(',') || null,
        createdAt: now,
      },
      select: { id: true, senderId: true, kind: true, body: true, readAt: true, createdAt: true },
    })

    await deps.db.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now },
    })

    // The push carries the sender's name but NOT the message body: a lock
    // screen is a public surface, and a gate code on it defeats the point of
    // withholding the address.
    await notifier.notify({
      userId: counterpart.id,
      type: 'NEW_MESSAGE',
      title: `${identity.userId === conversation.customerId ? 'Your customer' : 'Your pro'} sent a message`,
      body: 'Open GrassAssassin to read it.',
      data: { jobId: conversation.jobId, conversationId: conversation.id },
    }).catch(() => undefined)

    return reply.status(201).send({ message, notice: screening.notice })
  })
}

function counterpartOf(
  conversation: { customerId: string; workerId: string },
  viewerId: string,
): string {
  return conversation.customerId === viewerId ? conversation.workerId : conversation.customerId
}

type LoadedConversation = {
  id: string
  jobId: string
  customerId: string
  workerId: string
  closedAt: Date | null
  job: { status: string; closedAt: Date | null; cancelledAt: Date | null }
}

function openness(conversation: LoadedConversation | {
  closedAt: Date | null
  job: { status: string; closedAt: Date | null; cancelledAt: Date | null }
}): { open: boolean; reason: string | null } {
  const params = {
    jobStatus: conversation.job.status,
    jobEndedAt: conversation.job.closedAt ?? conversation.job.cancelledAt ?? null,
    closedAt: conversation.closedAt,
  }
  return { open: conversationIsOpen(params), reason: closedReason(params) }
}

/**
 * Loads a thread and proves the caller belongs in it.
 *
 * Membership is checked against the conversation's own customerId/workerId
 * rather than the job's current claim holder. A worker who did the work and
 * was later released must keep access to the thread that is the evidence
 * record of that job — and a worker who claims the job afterwards must not
 * inherit the previous conversation.
 */
async function loadThread(deps: ServerDeps, jobId: string, viewerId: string) {
  const conversation = await deps.db.conversation.findUnique({
    where: { jobId },
    select: {
      id: true, jobId: true, customerId: true, workerId: true, closedAt: true,
      job: { select: { status: true, closedAt: true, cancelledAt: true } },
    },
  })
  if (!conversation) throw new NotFoundError('Conversation')

  if (conversation.customerId !== viewerId && conversation.workerId !== viewerId) {
    // Deliberately Forbidden and not Not Found: the caller knows the job
    // exists — they had to name it — so pretending otherwise buys nothing and
    // makes a real bug indistinguishable from a permission error.
    throw new ForbiddenError('You are not part of this conversation')
  }

  const counterpartId = counterpartOf(conversation, viewerId)
  const counterpart = await deps.db.user.findUnique({
    where: { id: counterpartId },
    select: { id: true, firstName: true, avatarUrl: true },
  })
  if (!counterpart) throw new NotFoundError('User')

  return { conversation, counterpart }
}
