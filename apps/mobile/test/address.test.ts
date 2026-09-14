import { describe, expect, it } from 'vitest'
import {
  addressComplete, addressFieldErrors, formatAddressLine, generalAreaFor, type AddressDraft,
} from '@/lib/address'

const VALID: AddressDraft = {
  label: 'Home',
  addressLine1: '128 Maple Street',
  addressLine2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78704',
}

describe('address validation', () => {
  it('accepts an ordinary address', () => {
    expect(addressFieldErrors(VALID)).toEqual({})
    expect(addressComplete(VALID)).toBe(true)
  })

  it('rejects a street with no number', () => {
    // "Maple Street" geocodes to the middle of the street, which is how a
    // worker ends up standing outside the wrong house.
    const errors = addressFieldErrors({ ...VALID, addressLine1: 'Maple Street' })
    expect(errors.addressLine1).toBe('Include the house number')
  })

  it('accepts the awkward-but-real house numbers', () => {
    for (const line of ['128B Maple Street', '1200 N Lamar Blvd', '4 1/2 Elm Ct', '07 Oak Ln']) {
      expect(addressFieldErrors({ ...VALID, addressLine1: line }).addressLine1, line).toBeUndefined()
    }
  })

  it('accepts ZIP+4 as well as five digits', () => {
    expect(addressComplete({ ...VALID, postalCode: '78704-1234' })).toBe(true)
  })

  it('rejects ZIPs that are the wrong length or not digits', () => {
    for (const zip of ['787', '787045', 'ABCDE', '7870A', '']) {
      expect(addressComplete({ ...VALID, postalCode: zip }), zip).toBe(false)
    }
  })

  it('accepts a lowercase state and normalises it when formatting', () => {
    // Typing "tx" on a phone keyboard is the common case, not an error.
    expect(addressComplete({ ...VALID, state: 'tx' })).toBe(true)
    expect(formatAddressLine({ ...VALID, state: 'tx' })).toContain('TX')
  })

  it('rejects a spelled-out state', () => {
    expect(addressFieldErrors({ ...VALID, state: 'Texas' }).state).toBe('Two-letter state, like TX')
  })

  it('does not require a unit number', () => {
    expect(addressComplete({ ...VALID, addressLine2: '' })).toBe(true)
  })

  it('tolerates surrounding whitespace everywhere', () => {
    expect(addressComplete({
      ...VALID,
      addressLine1: '  128 Maple Street ',
      city: ' Austin ',
      state: ' tx ',
      postalCode: ' 78704 ',
    })).toBe(true)
  })

  it('reports every bad field at once rather than one at a time', () => {
    const errors = addressFieldErrors({ ...VALID, addressLine1: '', city: '', state: '', postalCode: '' })
    expect(Object.keys(errors).sort()).toEqual(['addressLine1', 'city', 'postalCode', 'state'])
  })
})

describe('geocoder input', () => {
  it('leaves the unit number out', () => {
    // "Apt 4B" pushes most geocoders to a worse match or none, and says nothing
    // about where the yard is.
    const line = formatAddressLine({ ...VALID, addressLine2: 'Apt 4B' })
    expect(line).not.toContain('4B')
    expect(line).toBe('128 Maple Street, Austin, TX 78704')
  })

  it('does not emit empty segments or stray commas', () => {
    const line = formatAddressLine({ ...VALID, city: '' })
    expect(line).not.toMatch(/,\s*,/)
    expect(line.trim()).not.toMatch(/,$/)
  })
})

describe('general area', () => {
  it('is city and state only — never the street', () => {
    // This is what a worker sees on the map before anyone has claimed, so a
    // street name leaking in here is the privacy failure the whole design
    // exists to prevent.
    const area = generalAreaFor(VALID)
    expect(area).toBe('Austin, TX')
    expect(area).not.toContain('Maple')
    expect(area).not.toContain('128')
  })
})
