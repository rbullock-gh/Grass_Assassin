import { describe, it, expect } from 'vitest'
import {
  NOTIFICATION_GROUPS, ALL_NOTIFICATION_CATEGORIES, groupsFor, groupForCategory,
} from '../src/domain/notification-groups.js'

/**
 * Grouping the fourteen categories into five switches.
 *
 * The failure worth guarding is a category that belongs to no group: the
 * notifier would keep sending it and the settings screen would offer no way to
 * stop it, which is exactly the state this whole screen exists to fix.
 */

// The notifier's own union, restated. If these ever diverge, a notification
// becomes unmutable and nothing else in the system notices.
const NOTIFIER_CATEGORIES = [
  'JOB_MATCH', 'JOB_CLAIMED', 'WORKER_EN_ROUTE', 'WORK_STARTED', 'PHOTOS_UPLOADED',
  'APPROVAL_NEEDED', 'APPROVAL_REMINDER', 'AUTO_APPROVED', 'PAYMENT_RELEASED',
  'TIP_RECEIVED', 'DEADLINE_REMINDER', 'RANK_UP', 'JOB_EXPIRING', 'NEW_MESSAGE',
]

describe('every notification can be turned off', () => {
  it('covers every category the notifier can send', () => {
    for (const category of NOTIFIER_CATEGORIES) {
      expect(groupForCategory(category), `${category} belongs to no group`).not.toBeNull()
    }
  })

  it('invents no category the notifier does not send', () => {
    for (const category of ALL_NOTIFICATION_CATEGORIES) {
      expect(NOTIFIER_CATEGORIES, `${category} is not a real category`).toContain(category)
    }
  })

  it('puts each category in exactly one group', () => {
    // Two groups owning one category means turning it off in one place and
    // having it come back on in the other.
    const seen = new Set<string>()
    for (const category of ALL_NOTIFICATION_CATEGORIES) {
      expect(seen.has(category), `${category} is in two groups`).toBe(false)
      seen.add(category)
    }
  })
})

describe('what each person is shown', () => {
  it('does not offer a customer the worker-only groups', () => {
    const keys = groupsFor(['CUSTOMER']).map((g) => g.key)
    expect(keys).not.toContain('nearby-work')
    expect(keys).not.toContain('ranks')
    expect(keys).toContain('messages')
  })

  it('offers a worker the work groups', () => {
    const keys = groupsFor(['WORKER']).map((g) => g.key)
    expect(keys).toContain('nearby-work')
    expect(keys).toContain('ranks')
  })

  it('shows somebody who is both everything', () => {
    expect(groupsFor(['WORKER', 'CUSTOMER'])).toHaveLength(NOTIFICATION_GROUPS.length)
  })

  it('still shows the shared groups to somebody with no role yet', () => {
    // A brand-new account should not see an empty settings screen.
    const keys = groupsFor([]).map((g) => g.key)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).toContain('job-progress')
  })
})

describe('how the list reads', () => {
  it('leads with the one people actually come here to turn off', () => {
    expect(NOTIFICATION_GROUPS[0]!.key).toBe('nearby-work')
  })

  it('ends with the one that costs nothing to lose', () => {
    expect(NOTIFICATION_GROUPS.at(-1)!.key).toBe('ranks')
  })

  it('says what turning off the consequential ones costs', () => {
    // Silently letting someone mute the notification that says a stranger is
    // arriving at their house is not a neutral act.
    const progress = NOTIFICATION_GROUPS.find((g) => g.key === 'job-progress')!
    expect(progress.cost).toMatch(/arrive at your house/i)
    const money = NOTIFICATION_GROUPS.find((g) => g.key === 'money')!
    expect(money.cost).toMatch(/auto-approving/i)
  })

  it('never shows an API constant to a person', () => {
    for (const group of NOTIFICATION_GROUPS) {
      expect(group.label).not.toMatch(/_/)
      expect(group.detail.length).toBeGreaterThan(20)
    }
  })
})
