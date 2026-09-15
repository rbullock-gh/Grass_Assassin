import { describe, it, expect } from 'vitest'
import {
  routeForNotification, shouldAskForPush, pushRationale, timezoneOffsetMinutes,
} from '../src/lib/push'

describe('where a tapped notification lands', () => {
  it('opens the job a worker was told about, on the worker screen', () => {
    expect(routeForNotification({ jobId: 'job_1', kind: 'JOB_MATCH' }, 'worker'))
      .toBe('/(worker)/job/job_1')
  })

  it('opens the same job on the customer screen for a customer', () => {
    // The same jobId means two different screens. Sending a customer to the
    // worker's view shows them a claim button for their own job.
    expect(routeForNotification({ jobId: 'job_1' }, 'customer'))
      .toBe('/(customer)/jobs/job_1')
  })

  it('opens the thread for a message, not the job', () => {
    expect(routeForNotification({ jobId: 'job_1', conversationId: 'c_1' }, 'worker'))
      .toBe('/(shared)/messages/job_1')
  })

  it('opens nothing rather than somewhere plausible', () => {
    // A tap that lands on an arbitrary job is worse than a tap that just brings
    // the app forward: it can show someone a listing that is not theirs.
    expect(routeForNotification({}, 'worker')).toBeNull()
    expect(routeForNotification(null, 'worker')).toBeNull()
    expect(routeForNotification(undefined, 'customer')).toBeNull()
    expect(routeForNotification({ jobId: '' }, 'worker')).toBeNull()
    expect(routeForNotification({ jobId: 42 as unknown as string }, 'worker')).toBeNull()
  })
})

describe('when to ask for permission', () => {
  const moment = (over: Partial<Parameters<typeof shouldAskForPush>[0]> = {}) => ({
    hasPostedOrClaimed: true, askedBefore: false, alreadyGranted: false, ...over,
  })

  it('asks once the person has done the thing notifications are for', () => {
    expect(shouldAskForPush(moment())).toBe(true)
  })

  it('does not ask on first launch', () => {
    // On iOS a declined prompt cannot be shown again, only replaced by a trip
    // to Settings. Spending it before the person knows what the app does is
    // spending it on a no.
    expect(shouldAskForPush(moment({ hasPostedOrClaimed: false }))).toBe(false)
  })

  it('does not ask twice', () => {
    expect(shouldAskForPush(moment({ askedBefore: true }))).toBe(false)
  })

  it('does not ask someone who already said yes', () => {
    expect(shouldAskForPush(moment({ alreadyGranted: true }))).toBe(false)
  })
})

describe('the reason shown before the system prompt', () => {
  it('speaks to what a worker actually wants', () => {
    const { title, body } = pushRationale('worker')
    expect(title).toMatch(/job/i)
    expect(body).toMatch(/money is released/i)
  })

  it('speaks to what a customer actually wants', () => {
    expect(pushRationale('customer').body).toMatch(/claims your job/i)
  })

  it('promises the quiet hours the server actually enforces', () => {
    // 9pm–7am is QUIET_HOURS_START/END on the server. A promise the backend
    // does not keep is worse than no promise.
    for (const audience of ['worker', 'customer'] as const) {
      expect(pushRationale(audience).body).toMatch(/9pm and 7am/)
    }
  })
})

describe('the timezone sent with a registration', () => {
  it('passes getTimezoneOffset through without flipping its sign', () => {
    // Negating this puts quiet hours exactly twelve hours out — 3am pushes for
    // everyone, and silence all afternoon.
    const now = new Date()
    expect(timezoneOffsetMinutes(now)).toBe(now.getTimezoneOffset())
  })
})
