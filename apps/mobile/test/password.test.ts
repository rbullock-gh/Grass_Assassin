import { describe, it, expect } from 'vitest'
import { checkNewPassword, MIN_PASSWORD_LENGTH } from '../src/lib/password'
import { passwordSchema } from '@grassassassin/shared'

describe('the rule this form states is the rule the server enforces', () => {
  it('rejects one character under the stated minimum', () => {
    // Two copies of a rule drift, and then a form that says "looks good" gets
    // a 400 from the server with no explanation the person can act on.
    expect(passwordSchema.safeParse('x'.repeat(MIN_PASSWORD_LENGTH - 1)).success).toBe(false)
  })

  it('accepts exactly the stated minimum', () => {
    expect(passwordSchema.safeParse('x'.repeat(MIN_PASSWORD_LENGTH)).success).toBe(true)
  })
})

const check = (over: Partial<Parameters<typeof checkNewPassword>[0]> = {}) =>
  checkNewPassword({ current: 'OldPassword1', next: 'NewPassword1', confirm: 'NewPassword1', ...over })

describe('changing a password', () => {
  it('is ready when all three are filled and agree', () => {
    expect(check()).toEqual({ ok: true, problem: null })
  })

  it('says nothing while the form is still being filled in', () => {
    // A form that turns red before you have finished typing the first field is
    // a form that feels like it is arguing with you.
    expect(check({ current: '' }).problem).toBeNull()
    expect(check({ next: '', confirm: '' }).problem).toBeNull()
    expect(check({ confirm: '' }).problem).toBeNull()
  })

  it('counts down the characters still needed', () => {
    expect(check({ next: 'short', confirm: 'short' }).problem).toMatch(/5 more characters/)
  })

  it('gets the singular right at one character left', () => {
    const next = 'x'.repeat(MIN_PASSWORD_LENGTH - 1)
    expect(check({ next, confirm: next }).problem).toMatch(/1 more character\./)
  })

  it('refuses the password they already have', () => {
    // The server would accept it and revoke every session for no change.
    const same = 'SamePassword1'
    expect(check({ current: same, next: same, confirm: same }))
      .toEqual({ ok: false, problem: 'That is the password you already have.' })
  })

  it('catches a mistyped confirmation', () => {
    expect(check({ confirm: 'NewPassword2' }).problem).toMatch(/do not match/)
  })

  it('does not complain about a mismatch before they have typed it', () => {
    expect(check({ confirm: '' })).toEqual({ ok: false, problem: null })
  })

  it('never reports ok while anything is wrong', () => {
    for (const bad of [
      { current: '' },
      { next: 'tiny', confirm: 'tiny' },
      { confirm: 'different' },
    ]) {
      expect(check(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})
