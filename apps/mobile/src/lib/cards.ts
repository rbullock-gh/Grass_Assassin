import type { SavedCard } from '@grassassassin/client'

/**
 * Describing a saved card.
 *
 * Kept out of the screen so it can be tested without a renderer, and because
 * "which card is this" is a question people answer by glancing at four digits
 * and a brand — get it wrong and they pick the wrong one.
 */

const BRAND_NAMES: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
}

/**
 * A card in the words on the card itself.
 *
 * Never "card ending 4242" with no brand — someone with two Visas and a
 * Mastercard cannot tell those apart, and the whole point of this line is
 * telling them apart.
 */
export function describeCard(card: Pick<SavedCard, 'brand' | 'last4'>): string {
  const brand = card.brand ? BRAND_NAMES[card.brand.toLowerCase()] ?? titleCase(card.brand) : 'Card'
  return card.last4 ? `${brand} ···· ${card.last4}` : brand
}

/**
 * Anything wrong with this card, in words, or null if it is fine.
 *
 * A card that will fail is worth saying BEFORE a job is posted. Finding out at
 * the moment a worker claims means a job that dies on payment, which costs the
 * worker the trip.
 */
export function cardNeedsAttention(
  card: Pick<SavedCard, 'brand' | 'last4'> & { expMonth?: number; expYear?: number },
  now = new Date(),
): string | null {
  if (card.expMonth === undefined || card.expYear === undefined) return null
  if (!Number.isInteger(card.expMonth) || card.expMonth < 1 || card.expMonth > 12) return null

  // A card is good through the last day of its expiry month.
  const expiresAfter = new Date(card.expYear, card.expMonth, 1)
  if (expiresAfter.getTime() <= now.getTime()) return 'Expired — this card will be declined'

  const monthsLeft =
    (card.expYear - now.getFullYear()) * 12 + (card.expMonth - 1 - now.getMonth())
  if (monthsLeft <= 1) return 'Expires soon'

  return null
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}
