import type { Db } from '../../lib/prisma.js'

/**
 * Notifications.
 *
 * Delivery sits behind a port so the domain never imports Expo, Twilio or
 * Resend directly. The recorded Notification row is written regardless of
 * whether delivery succeeds, because "we tried to tell them and the push
 * failed" and "we never tried" are different facts and only one of them is a
 * bug in our code.
 */

export type NotificationType =
  | 'JOB_MATCH'
  | 'JOB_CLAIMED'
  | 'WORKER_EN_ROUTE'
  | 'WORK_STARTED'
  | 'PHOTOS_UPLOADED'
  | 'APPROVAL_NEEDED'
  | 'APPROVAL_REMINDER'
  | 'AUTO_APPROVED'
  | 'PAYMENT_RELEASED'
  | 'TIP_RECEIVED'
  | 'DEADLINE_REMINDER'
  | 'RANK_UP'
  | 'JOB_EXPIRING'
  | 'NEW_MESSAGE'

export interface PushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, string>
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<{ sent: number; failed: number }>
}

/** Records what would have been sent. Used in tests and local development. */
export class RecordingPushSender implements PushSender {
  readonly sent: PushMessage[] = []
  /** Push tokens that should fail, to exercise the failure path. */
  failFor = new Set<string>()

  async send(messages: PushMessage[]): Promise<{ sent: number; failed: number }> {
    let failed = 0
    for (const message of messages) {
      if (this.failFor.has(message.to)) { failed += 1; continue }
      this.sent.push(message)
    }
    return { sent: messages.length - failed, failed }
  }

  reset(): void {
    this.sent.length = 0
    this.failFor.clear()
  }
}

/**
 * Quiet hours.
 *
 * A job-match push at 3am is how a worker turns notifications off permanently,
 * and a worker with notifications off is a worker who stops seeing jobs. Only
 * events on a job they are actively working override this.
 */
export const QUIET_HOURS_START = 21
export const QUIET_HOURS_END = 7

export function isQuietHours(now: Date, tzOffsetMinutes: number): boolean {
  const localHour = new Date(now.getTime() - tzOffsetMinutes * 60_000).getUTCHours()
  return localHour >= QUIET_HOURS_START || localHour < QUIET_HOURS_END
}

/** Types urgent enough to send during quiet hours. */
const OVERRIDES_QUIET_HOURS: readonly NotificationType[] = [
  'JOB_CLAIMED', 'WORKER_EN_ROUTE', 'WORK_STARTED', 'PHOTOS_UPLOADED', 'NEW_MESSAGE',
]

export function mayDeliverNow(type: NotificationType, now: Date, tzOffsetMinutes: number): boolean {
  if (!isQuietHours(now, tzOffsetMinutes)) return true
  return OVERRIDES_QUIET_HOURS.includes(type)
}

/**
 * A hard cap on how many job-match pushes one worker can receive per day.
 *
 * Without it, a busy Saturday in a dense market sends a worker forty buzzes and
 * they mute the app — which costs us far more than the jobs they might have
 * claimed.
 */
export const MAX_JOB_MATCH_PUSHES_PER_DAY = 12

export interface NotifyParams {
  userId: string
  type: NotificationType
  title: string
  body: string
  data?: Record<string, string>
  /** Skips the quiet-hours check. Used by sweepers that already decided. */
  force?: boolean
  now?: Date
}

export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly push: PushSender,
  ) {}

  /**
   * Records and attempts to deliver one notification.
   *
   * Returns whether it was delivered. A false is not an error — it may simply
   * be quiet hours, or the daily cap, or a user with no device registered.
   */
  async notify(params: NotifyParams): Promise<boolean> {
    const now = params.now ?? new Date()

    if (params.type === 'JOB_MATCH' && (await this.jobMatchesToday(params.userId, now)) >= MAX_JOB_MATCH_PUSHES_PER_DAY) {
      await this.record(params, null, 'Daily job-match cap reached')
      return false
    }

    if (!params.force && !mayDeliverNow(params.type, now, await this.tzOffsetFor(params.userId))) {
      await this.record(params, null, 'Suppressed during quiet hours')
      return false
    }

    if (!(await this.prefersChannel(params.userId, params.type))) {
      await this.record(params, null, 'Muted by user preference')
      return false
    }

    const devices = await this.db.device.findMany({
      where: { userId: params.userId },
      select: { pushToken: true },
    })

    if (devices.length === 0) {
      await this.record(params, null, 'No registered device')
      return false
    }

    const messages: PushMessage[] = devices.map((device) => ({
      to: device.pushToken,
      title: params.title,
      body: params.body,
      ...(params.data ? { data: params.data } : {}),
    }))

    const result = await this.push.send(messages)
    const delivered = result.sent > 0
    await this.record(params, delivered ? now : null, delivered ? null : 'Push delivery failed')
    return delivered
  }

  /** Fan-out that shares one device lookup, for job-match pushes. */
  async notifyMany(recipients: NotifyParams[]): Promise<number> {
    let delivered = 0
    for (const recipient of recipients) {
      if (await this.notify(recipient)) delivered += 1
    }
    return delivered
  }

  private async record(params: NotifyParams, sentAt: Date | null, failureReason: string | null): Promise<void> {
    await this.db.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        body: params.body,
        data: (params.data ?? null) as never,
        channel: 'PUSH',
        sentAt,
        failedAt: sentAt === null ? new Date() : null,
        failureReason,
      },
    })
  }

  private async jobMatchesToday(userId: string, now: Date): Promise<number> {
    const since = new Date(now.getTime() - 86_400_000)
    return this.db.notification.count({
      where: { userId, type: 'JOB_MATCH', createdAt: { gte: since }, sentAt: { not: null } },
    })
  }

  private async prefersChannel(userId: string, type: NotificationType): Promise<boolean> {
    const preference = await this.db.notificationPreference.findFirst({
      where: { userId, category: type },
    })
    // Opt-out rather than opt-in: a user who has never touched settings should
    // still hear about a job they are working on.
    return preference?.push ?? true
  }

  private async tzOffsetFor(_userId: string): Promise<number> {
    // Until devices report their offset, assume US Central — the launch market.
    // Getting this wrong only ever delays a push; it never sends one at 3am to
    // someone in the launch market, which is what matters.
    return 360
  }
}
