/**
 * Notifications, grouped the way a person would think about them.
 *
 * The notifier works in fourteen categories because that is what the code that
 * sends them needs to distinguish. A settings screen with fourteen switches is
 * a settings screen nobody finishes reading, and the one thing someone came to
 * turn off is buried among thirteen they have no opinion about.
 *
 * So: five groups, ordered by how likely somebody is to want them off. "Work
 * near you" is first because it is the high-volume one and the actual reason
 * people reach for this screen. Ranks are last because turning them off costs
 * nothing.
 *
 * Every group IS mutable, including the operational ones. A product that will
 * not let you turn off its notifications teaches you to turn them off at the
 * operating system instead, and then you never hear from it again — including
 * the message from the person standing at your gate.
 */

export type NotificationCategory =
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

export type NotificationAudience = 'worker' | 'customer' | 'both'

export interface NotificationGroup {
  key: string
  label: string
  /** What arrives if this is on, in the words of someone receiving it. */
  detail: string
  /** What you stop hearing about if you turn it off, when that costs something. */
  cost?: string
  audience: NotificationAudience
  categories: readonly NotificationCategory[]
}

export const NOTIFICATION_GROUPS: readonly NotificationGroup[] = [
  {
    key: 'nearby-work',
    label: 'Work near you',
    detail: 'A job is posted inside your service area that matches what you do.',
    audience: 'worker',
    categories: ['JOB_MATCH'],
  },
  {
    key: 'messages',
    label: 'Messages',
    detail: 'Someone on a job you are on sends you a message.',
    cost: 'The message still arrives in the app — you just will not be told.',
    audience: 'both',
    categories: ['NEW_MESSAGE'],
  },
  {
    key: 'job-progress',
    label: 'Jobs you are on',
    detail:
      'A job you posted gets claimed, a pro is on the way, work starts, photos '
      + 'land, a deadline is close.',
    cost: 'This is the group that tells you somebody is about to arrive at your house.',
    audience: 'both',
    categories: [
      'JOB_CLAIMED',
      'WORKER_EN_ROUTE',
      'WORK_STARTED',
      'PHOTOS_UPLOADED',
      'DEADLINE_REMINDER',
      'JOB_EXPIRING',
    ],
  },
  {
    key: 'money',
    label: 'Approvals and money',
    detail: 'Work is waiting for your approval, a payment is released, a tip arrives.',
    cost:
      'Approval reminders are what stop a job auto-approving without you looking '
      + 'at it.',
    audience: 'both',
    categories: ['APPROVAL_NEEDED', 'APPROVAL_REMINDER', 'AUTO_APPROVED', 'PAYMENT_RELEASED', 'TIP_RECEIVED'],
  },
  {
    key: 'ranks',
    label: 'Ranks',
    detail: 'You reach a new rank.',
    audience: 'worker',
    categories: ['RANK_UP'],
  },
] as const

/** Every category, flattened. Used to check nothing was dropped on the floor. */
export const ALL_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] =
  NOTIFICATION_GROUPS.flatMap((group) => group.categories)

/** The groups worth showing someone, given what they use the app for. */
export function groupsFor(roles: readonly string[]): NotificationGroup[] {
  const isWorker = roles.includes('WORKER')
  const isCustomer = roles.includes('CUSTOMER')
  return NOTIFICATION_GROUPS.filter((group) => {
    if (group.audience === 'both') return true
    if (group.audience === 'worker') return isWorker
    return isCustomer
  })
}

/** The group a category belongs to, or null if it somehow belongs to none. */
export function groupForCategory(category: string): NotificationGroup | null {
  return NOTIFICATION_GROUPS.find((group) =>
    (group.categories as readonly string[]).includes(category)) ?? null
}
