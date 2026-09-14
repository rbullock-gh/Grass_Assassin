/**
 * Message screening.
 *
 * Two different problems share one mechanism, and it matters that neither is
 * solved by blocking:
 *
 * 1. DISINTERMEDIATION — "text me at 555-0123 and skip the app fee". It is the
 *    single largest revenue leak in every marketplace of this shape.
 * 2. SAFETY — the product promises that a personal phone number is not exposed
 *    by default. That promise is worth nothing if the first message in every
 *    thread is a phone number.
 *
 * Both are handled by FLAGGING for human review, never by refusing to send.
 * Blocking is wrong on both counts: the false positives are ordinary
 * ("$120.00 for the front and back, gate code 4417"), and a worker whose
 * legitimate message vanishes concludes the app is broken and moves to text
 * messages — achieving exactly the leak the block was meant to prevent.
 *
 * So: the message is always delivered, and a human decides.
 */

export type MessageFlagReason = 'PHONE_NUMBER' | 'EMAIL_ADDRESS' | 'PAYMENT_HANDLE' | 'OFF_PLATFORM'

export interface MessageScreening {
  flagged: boolean
  reasons: MessageFlagReason[]
  /** Shown to the sender. Null when nothing was flagged. */
  notice: string | null
}

/**
 * Ten or eleven digits, however they are spaced.
 *
 * Written against the digit count rather than a format because "5 5 5 0 1 2 3"
 * and "555.0123" are the same intent, and anyone avoiding a naive check will
 * reach for exactly those.
 */
const PHONE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/

/** Digits spelled out, the obvious next move once a numeric check exists. */
const SPELLED_DIGITS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine)(?:[\s,.-]+(?:zero|one|two|three|four|five|six|seven|eight|nine)){6,}\b/i

const EMAIL = /[A-Za-z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\sat\s)\s*[A-Za-z0-9.-]+\s*(?:\.|\(dot\)|\sdot\s)\s*[A-Za-z]{2,}/i

/** Cash apps, which is how an off-platform deal actually gets paid. */
const PAYMENT_HANDLE = /\b(?:venmo|cash\s?app|zelle|paypal|\$cashtag)\b/i

/**
 * Phrases that propose leaving the platform.
 *
 * Deliberately narrow. "Cash" alone is not a signal — a customer asking
 * "do you take cash?" is asking an ordinary question — but "pay you cash
 * directly" is proposing something else.
 */
const OFF_PLATFORM = /\b(?:off\s?the\s?app|outside\s?the\s?app|off\s?platform|skip\s?the\s?(?:app|fee)|avoid\s?the\s?fee|cash\s?(?:directly|in\s?hand)|pay\s?you\s?(?:directly|cash)|text\s?me\s?(?:at|on)?)\b/i

/**
 * A price is not a phone number.
 *
 * "$120.00" and "1200 N Lamar" both hit a loose digit pattern, and a job about
 * an address, at a price, is the entire subject of these conversations. Money
 * and street numbers are stripped before the phone check runs.
 */
function withoutPricesAndAddresses(text: string): string {
  return text
    .replace(/\$\s?\d[\d,]*(?:\.\d{2})?/g, ' ')
    .replace(/\b\d[\d,]*(?:\.\d{2})?\s?(?:dollars?|bucks|usd)\b/gi, ' ')
    .replace(/\b\d{1,5}\s+[NSEW]?\.?\s*[A-Z][a-z]+\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|ter|terrace|pl|place)\b/gi, ' ')
}

export function screenMessage(body: string): MessageScreening {
  const reasons: MessageFlagReason[] = []
  const scrubbed = withoutPricesAndAddresses(body)

  if (PHONE.test(scrubbed) || SPELLED_DIGITS.test(scrubbed)) reasons.push('PHONE_NUMBER')
  if (EMAIL.test(body)) reasons.push('EMAIL_ADDRESS')
  if (PAYMENT_HANDLE.test(body)) reasons.push('PAYMENT_HANDLE')
  if (OFF_PLATFORM.test(body)) reasons.push('OFF_PLATFORM')

  if (reasons.length === 0) return { flagged: false, reasons: [], notice: null }

  return { flagged: true, reasons, notice: noticeFor(reasons) }
}

/**
 * What the sender is told.
 *
 * Told, not warned. The message went through; this explains why the exchange
 * is worth keeping on the platform, in terms of what THEY lose by leaving —
 * payment protection and a dispute record — rather than what we lose. A notice
 * that reads as a threat teaches people to evade the check instead.
 */
function noticeFor(reasons: MessageFlagReason[]): string {
  if (reasons.includes('PAYMENT_HANDLE') || reasons.includes('OFF_PLATFORM')) {
    return 'Sent. Keep in mind that work paid for outside GrassAssassin has no payment protection, no dispute support, and does not count toward your rank.'
  }
  if (reasons.includes('PHONE_NUMBER') || reasons.includes('EMAIL_ADDRESS')) {
    return 'Sent. You do not need to share a phone number or email — messages here reach them directly, and keeping it in the app means there is a record if anything goes wrong.'
  }
  return 'Sent.'
}

/**
 * Whether a message may be sent at all.
 *
 * The one hard rule, and it is about access rather than content: a conversation
 * is attached to a job, so it must not outlive it into an open-ended channel
 * between two strangers who now have each other's names.
 *
 * It does stay open for a week after the job ends, because the questions that
 * matter most arrive after the fact — a gate left open, a missed spot, a
 * conversation about a tip. Closing on the instant of completion would push
 * every one of those to a phone number.
 */
export const MESSAGE_WINDOW_DAYS_AFTER_END = 7

const ENDED_STATUSES = ['CLOSED', 'CANCELLED', 'EXPIRED']

export function conversationIsOpen(params: {
  jobStatus: string
  /** When the job reached a terminal status. Null while it is still running. */
  jobEndedAt: Date | null
  /** Set by an admin to end a thread early — abuse, or a resolved dispute. */
  closedAt: Date | null
  now?: Date
}): boolean {
  const { jobStatus, jobEndedAt, closedAt, now = new Date() } = params

  // An admin closing the thread wins over everything else.
  if (closedAt !== null) return false
  if (!ENDED_STATUSES.includes(jobStatus)) return true

  // Terminal but no timestamp: treat it as just ended rather than silently
  // locking people out of a thread they are mid-conversation in.
  if (jobEndedAt === null) return true

  const windowMs = MESSAGE_WINDOW_DAYS_AFTER_END * 86_400_000
  return now.getTime() - jobEndedAt.getTime() < windowMs
}

/** Why the thread is read-only, in words the person can act on. */
export function closedReason(params: {
  jobStatus: string
  jobEndedAt: Date | null
  closedAt: Date | null
  now?: Date
}): string | null {
  if (conversationIsOpen(params)) return null
  if (params.closedAt !== null) return 'This conversation was closed by GrassAssassin support.'
  return `This job finished more than ${MESSAGE_WINDOW_DAYS_AFTER_END} days ago, so the conversation is closed. Post a new job to get back in touch.`
}

export const MAX_MESSAGE_LENGTH = 2000
