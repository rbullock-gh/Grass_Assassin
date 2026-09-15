import { describe, it, expect } from 'vitest'
import { ApiError } from '@grassassassin/client'
import {
  isVerificationRequired, verificationRoute, EMAIL_NOT_VERIFIED,
} from '../src/lib/verification-gate'

describe('recognising the one recoverable 403', () => {
  it('matches the verification refusal', () => {
    expect(isVerificationRequired(
      new ApiError(EMAIL_NOT_VERIFIED, 'Verify your email address first', 403),
    )).toBe(true)
  })

  it('does not match an ordinary 403', () => {
    // Claiming somebody else's job is also a 403 and has nowhere to go.
    // Routing that to the code screen would be worse than showing the refusal.
    expect(isVerificationRequired(
      new ApiError('FORBIDDEN', 'You do not have permission to do that', 403),
    )).toBe(false)
  })

  it('does not match a network failure or a plain Error', () => {
    expect(isVerificationRequired(new Error('offline'))).toBe(false)
    expect(isVerificationRequired(null)).toBe(false)
    expect(isVerificationRequired({ code: EMAIL_NOT_VERIFIED })).toBe(false)
  })
})

describe('where it sends them', () => {
  it('carries where they were going, so the task is not lost', () => {
    const route = verificationRoute({ action: 'claim', next: '/jobs/abc123' })
    expect(route.pathname).toBe('/(shared)/verify-email')
    expect(route.params.next).toBe('/jobs/abc123')
  })

  it('omits next rather than sending an empty one', () => {
    expect(verificationRoute({ action: 'post' }).params).not.toHaveProperty('next')
  })

  it('explains the refusal in terms of what they just tried', () => {
    // "Verify your email" arriving unprompted after tapping CLAIM reads as an
    // unrelated interruption rather than as an answer.
    expect(verificationRoute({ action: 'post' }).params.reason).toMatch(/comes to your home/i)
    expect(verificationRoute({ action: 'claim' }).params.reason).toMatch(/claim work/i)
  })
})
