/**
 * Whether a new password can be submitted, and what to say if not.
 *
 * The rules are the server's, restated so somebody finds out before they press
 * the button rather than after. Restating them is a risk — two copies drift and
 * then a form that says "looks good" gets a 400 — so a test asserts this number
 * against the shared passwordSchema that actually enforces it.
 */

/** Must equal the minimum in passwordSchema. Tied by test, not by hope. */
export const MIN_PASSWORD_LENGTH = 10

/**
 * The length rule on its own, for a form that has no current password to
 * compare against — resetting from an emailed link is exactly that case.
 *
 * Shares the constant rather than restating the number, so the reset form and
 * the change form cannot disagree about what is long enough.
 *
 * Returns null while there is nothing useful to say: an empty field is not yet
 * a mistake, and scolding somebody for not having typed anything is noise.
 */
export function describePasswordProblem(password: string): string | null {
  if (password.length === 0) return null
  if (password.length >= MIN_PASSWORD_LENGTH) return null
  const short = MIN_PASSWORD_LENGTH - password.length
  return `${short} more character${short === 1 ? '' : 's'}.`
}

export interface PasswordCheck {
  ok: boolean
  /** Shown under the field. Null when there is nothing to say yet. */
  problem: string | null
}

export function checkNewPassword(params: {
  current: string
  next: string
  confirm: string
}): PasswordCheck {
  if (params.current.length === 0) {
    return { ok: false, problem: null }
  }
  if (params.next.length === 0) {
    return { ok: false, problem: null }
  }
  if (params.next.length < MIN_PASSWORD_LENGTH) {
    const short = MIN_PASSWORD_LENGTH - params.next.length
    return {
      ok: false,
      problem: `${short} more character${short === 1 ? '' : 's'}.`,
    }
  }
  if (params.next === params.current) {
    // The server would accept this and revoke every session for nothing.
    return { ok: false, problem: 'That is the password you already have.' }
  }
  if (params.confirm.length > 0 && params.confirm !== params.next) {
    return { ok: false, problem: 'The two new passwords do not match.' }
  }
  if (params.confirm !== params.next) {
    return { ok: false, problem: null }
  }
  return { ok: true, problem: null }
}
