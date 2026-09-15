import { describe, it, expect } from 'vitest'
import { resolveButtons, dialogText } from '../src/lib/dialog-mapping'

/**
 * Mapping a native alert onto a browser dialog.
 *
 * React Native Web's Alert is a no-op, so every one of these did nothing on the
 * web build — including the claim result on the map, which is the single most
 * important thing the app ever tells a worker.
 */

describe('which button a browser confirm maps to', () => {
  it('treats a single button as a message, not a question', () => {
    const resolved = resolveButtons([{ text: 'OK' }])
    expect(resolved.kind).toBe('message')
  })

  it('treats no buttons as a message', () => {
    expect(resolveButtons().kind).toBe('message')
    expect(resolveButtons([]).kind).toBe('message')
  })

  it('picks the cancel-styled button as cancel, wherever it sits', () => {
    const resolved = resolveButtons([
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel the job', style: 'destructive' },
    ])
    expect(resolved.kind).toBe('confirm')
    expect(resolved.cancel?.text).toBe('Keep it')
    // The destructive one is what OK means. Getting this backwards would cancel
    // somebody's job when they pressed the button meaning "do not".
    expect(resolved.confirm?.text).toBe('Cancel the job')
  })

  it('still resolves when the cancel button is second', () => {
    const resolved = resolveButtons([
      { text: 'Withdraw', style: 'default' },
      { text: 'Not now', style: 'cancel' },
    ])
    expect(resolved.cancel?.text).toBe('Not now')
    expect(resolved.confirm?.text).toBe('Withdraw')
  })

  it('falls back to position when nothing is marked cancel', () => {
    const resolved = resolveButtons([{ text: 'No' }, { text: 'Yes' }])
    expect(resolved.cancel?.text).toBe('No')
    expect(resolved.confirm?.text).toBe('Yes')
  })

  it('takes the last option when there are three', () => {
    const resolved = resolveButtons([
      { text: 'Cancel', style: 'cancel' },
      { text: 'Later' },
      { text: 'Do it now' },
    ])
    expect(resolved.cancel?.text).toBe('Cancel')
    expect(resolved.confirm).toBeDefined()
  })

  it('never returns the same button as both', () => {
    // Which would run the destructive handler when somebody pressed cancel.
    for (const buttons of [
      [{ text: 'a' }, { text: 'b' }],
      [{ text: 'a', style: 'cancel' as const }, { text: 'b' }],
      [{ text: 'a' }, { text: 'b', style: 'cancel' as const }],
    ]) {
      const resolved = resolveButtons(buttons)
      expect(resolved.confirm).not.toBe(resolved.cancel)
    }
  })
})

describe('what the browser dialog says', () => {
  it('joins the title and body, since a browser has one field', () => {
    expect(dialogText('Just missed it', 'Another pro claimed this job first.'))
      .toBe('Just missed it\n\nAnother pro claimed this job first.')
  })

  it('shows the title alone when there is no body', () => {
    expect(dialogText('Could not claim')).toBe('Could not claim')
  })
})
