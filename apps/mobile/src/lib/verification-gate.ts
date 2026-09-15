import { ApiError } from '@grassassassin/client'

/**
 * The one 403 that has somewhere to go.
 *
 * Posting a job and claiming one both require a verified email address. Every
 * other refusal in this product is a dead end by design — you cannot claim
 * somebody else's job, and there is no screen that fixes that. This one is the
 * opposite: there is a code sitting in the person's inbox and a screen that
 * takes it, and the whole value of the check is lost if the app shows a
 * refusal and stops.
 *
 * Kept as a pure function in its own file so it can be tested without pulling
 * in react-native, which vitest cannot parse.
 */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED'

export function isVerificationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === EMAIL_NOT_VERIFIED
}

/**
 * Where to send somebody, and what to tell them when they land.
 *
 * `next` is where they were trying to get to, so finishing the code puts them
 * back on the task instead of at the top of the app. `reason` is written for
 * the specific thing they just tried, because "verify your email" arriving
 * unprompted after tapping CLAIM reads as an unrelated interruption.
 */
export function verificationRoute(params: {
  action: 'post' | 'claim'
  next?: string
}): { pathname: string; params: Record<string, string> } {
  const reason = params.action === 'post'
    ? 'Before a pro comes to your home, we check that we can reach you at your email address.'
    : 'Before you can claim work at somebody’s home, we check that we can reach you at your email address.'

  return {
    pathname: '/(shared)/verify-email',
    params: { reason, ...(params.next ? { next: params.next } : {}) },
  }
}
