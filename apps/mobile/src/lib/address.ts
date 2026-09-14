/**
 * Address entry rules.
 *
 * Pure, because getting this wrong has two expensive failure modes and both are
 * worth a test: accepting an address the geocoder cannot resolve (the job lands
 * on the wrong side of town and a worker drives there for nothing), and
 * rejecting a legitimate one (the customer gives up on the spot).
 */

export interface AddressDraft {
  label: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
}

/** US ZIP, five digits or ZIP+4. */
const POSTAL_CODE = /^\d{5}(-\d{4})?$/

/** Two-letter state abbreviation. Case-insensitive; normalised on save. */
const STATE = /^[A-Za-z]{2}$/

/**
 * A street address needs a number and a name.
 *
 * "Maple Street" with no number geocodes to the middle of the street, which is
 * how a worker ends up outside the wrong house. Requiring a leading digit is
 * crude but catches the common case without rejecting "128B" or
 * "1200 N Lamar Blvd".
 */
const HAS_STREET_NUMBER = /^\s*\d/

export function addressFieldErrors(draft: AddressDraft): Partial<Record<keyof AddressDraft, string>> {
  const errors: Partial<Record<keyof AddressDraft, string>> = {}

  if (!draft.addressLine1.trim()) errors.addressLine1 = 'Enter the street address'
  else if (!HAS_STREET_NUMBER.test(draft.addressLine1)) errors.addressLine1 = 'Include the house number'

  if (!draft.city.trim()) errors.city = 'Enter the city'
  if (!STATE.test(draft.state.trim())) errors.state = 'Two-letter state, like TX'
  if (!POSTAL_CODE.test(draft.postalCode.trim())) errors.postalCode = 'Five-digit ZIP'

  return errors
}

export function addressComplete(draft: AddressDraft): boolean {
  return Object.keys(addressFieldErrors(draft)).length === 0
}

/**
 * The single line handed to the geocoder.
 *
 * Unit numbers are deliberately left out: "Apt 4B" confuses most geocoders into
 * a worse match or none at all, and it tells us nothing about where the yard is.
 */
export function formatAddressLine(draft: AddressDraft): string {
  return [
    draft.addressLine1.trim(),
    draft.city.trim(),
    `${draft.state.trim().toUpperCase()} ${draft.postalCode.trim()}`.trim(),
  ].filter(Boolean).join(', ')
}

/** What a worker sees on the map before anyone has claimed. */
export function generalAreaFor(draft: Pick<AddressDraft, 'city' | 'state'>): string {
  return [draft.city.trim(), draft.state.trim().toUpperCase()].filter(Boolean).join(', ')
}
