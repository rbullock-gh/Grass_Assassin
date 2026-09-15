import { describe, it, expect } from 'vitest'
import { describeCard, cardNeedsAttention } from '../src/lib/cards'

describe('naming a saved card', () => {
  it('uses the brand people see on the card, not the API slug', () => {
    expect(describeCard({ brand: 'mastercard', last4: '4444' })).toBe('Mastercard ···· 4444')
    expect(describeCard({ brand: 'amex', last4: '0005' })).toBe('American Express ···· 0005')
  })

  it('always includes the brand, so two cards ending differently are still distinguishable', () => {
    // "Card ending 4242" is useless to someone holding two Visas and a
    // Mastercard, which is the only situation this line exists for.
    const a = describeCard({ brand: 'visa', last4: '4242' })
    const b = describeCard({ brand: 'mastercard', last4: '4242' })
    expect(a).not.toBe(b)
  })

  it('falls back gracefully when the provider sends a brand we do not know', () => {
    expect(describeCard({ brand: 'cartes_bancaires', last4: '1234' })).toMatch(/1234/)
  })

  it('does not print "undefined" when details are missing', () => {
    expect(describeCard({ brand: undefined, last4: undefined })).toBe('Card')
    expect(describeCard({ brand: 'visa', last4: undefined })).toBe('Visa')
  })
})

describe('warning about a card before it fails', () => {
  const now = new Date('2026-06-15T12:00:00Z')

  it('says nothing about a healthy card', () => {
    expect(cardNeedsAttention({ brand: 'visa', last4: '4242', expMonth: 12, expYear: 2029 }, now))
      .toBeNull()
  })

  it('treats a card as good through the last day of its expiry month', () => {
    // A card expiring 06/2026 still works on 30 June 2026. Calling it expired on
    // the 1st would refuse a card that banks still accept.
    expect(cardNeedsAttention({ brand: 'visa', last4: '4242', expMonth: 6, expYear: 2026 }, now))
      .toBe('Expires soon')
  })

  it('flags a card whose month has passed', () => {
    expect(cardNeedsAttention({ brand: 'visa', last4: '4242', expMonth: 5, expYear: 2026 }, now))
      .toMatch(/expired/i)
  })

  it('warns about one expiring next month, while it still works', () => {
    expect(cardNeedsAttention({ brand: 'visa', last4: '4242', expMonth: 7, expYear: 2026 }, now))
      .toBe('Expires soon')
  })

  it('says nothing when the provider did not send an expiry', () => {
    expect(cardNeedsAttention({ brand: 'visa', last4: '4242' }, now)).toBeNull()
  })

  it('ignores an impossible month rather than calling a good card expired', () => {
    expect(cardNeedsAttention({ brand: 'visa', last4: '4242', expMonth: 13, expYear: 2029 }, now))
      .toBeNull()
  })
})
