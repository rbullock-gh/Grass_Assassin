/**
 * What a notification means, decided without touching the notification API.
 *
 * Kept separate from the Expo wiring so the two questions that actually go
 * wrong — where a tap should land, and when it is fair to ask for permission —
 * can be tested without a device.
 */

/** The audience a screen belongs to. The same job has two different screens. */
export type Audience = 'customer' | 'worker'

export interface NotificationData {
  jobId?: string
  conversationId?: string
  kind?: string
  [key: string]: unknown
}

/**
 * Where tapping a notification should land.
 *
 * Returns null when the payload names nothing we can open, and the app should
 * simply come to the foreground. Opening "somewhere plausible" instead is worse
 * than opening nowhere: a customer tapping a payment notification and landing
 * on a stranger's job listing has been shown something they should not see.
 */
export function routeForNotification(
  data: NotificationData | null | undefined,
  audience: Audience,
): string | null {
  if (!data) return null

  // A message thread is keyed by job, because that is what the thread is about.
  if (typeof data.conversationId === 'string' && typeof data.jobId === 'string') {
    return `/(shared)/messages/${data.jobId}`
  }

  if (typeof data.jobId === 'string' && data.jobId.length > 0) {
    return audience === 'worker'
      ? `/(worker)/job/${data.jobId}`
      : `/(customer)/jobs/${data.jobId}`
  }

  return null
}

/**
 * Whether to ask for notification permission yet.
 *
 * Not on first launch. A permission prompt shown to someone who has not seen
 * what the app does is a prompt they decline, and on iOS declining is close to
 * permanent — the app cannot ask again, only send them to Settings. So the ask
 * waits until the person has done the thing notifications are FOR: a worker who
 * has claimed a job wants to know about that job; a customer who has posted one
 * wants to know when somebody takes it.
 *
 * `askedBefore` covers the other half: having asked once and been told no, the
 * answer does not change by asking again.
 */
export interface PermissionMoment {
  hasPostedOrClaimed: boolean
  askedBefore: boolean
  alreadyGranted: boolean
}

export function shouldAskForPush(moment: PermissionMoment): boolean {
  if (moment.alreadyGranted) return false
  if (moment.askedBefore) return false
  return moment.hasPostedOrClaimed
}

/**
 * The reason to show someone, in their words, before the system prompt.
 *
 * Shown as our own explanation first so the system dialog is a yes/no on
 * something they already understand, rather than the first they hear of it.
 */
export function pushRationale(audience: Audience): { title: string; body: string } {
  return audience === 'worker'
    ? {
        title: 'Know the moment a job lands',
        body:
          'Jobs near you get claimed fast. Turn on notifications and we will tell you ' +
          'when one appears, when a customer replies, and when your money is released. ' +
          'Nothing between 9pm and 7am unless it is a job you are already working.',
      }
    : {
        title: 'Know when a pro takes your job',
        body:
          'We will tell you when someone claims your job, when they are on their way, ' +
          'and when the work is done and needs your approval. Nothing between 9pm and ' +
          '7am unless it is a job in progress.',
      }
}

/**
 * The offset to send with a device registration.
 *
 * getTimezoneOffset() already returns minutes to SUBTRACT from UTC, which is
 * the sign the server expects — so this exists to stop the next person from
 * negating it, which flips quiet hours to exactly the wrong twelve hours.
 */
export function timezoneOffsetMinutes(now: Date = new Date()): number {
  return now.getTimezoneOffset()
}
