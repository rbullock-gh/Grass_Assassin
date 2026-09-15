import { REPORT_CATEGORIES, type ReportCategory } from '@grassassassin/shared'

/**
 * Reporting a person, in words a person would use.
 *
 * The API names these for the moderation queue; nobody has ever said
 * "off-platform payment" out loud. The wording matters more here than on most
 * screens: somebody opening this has usually had a bad experience with a
 * stranger at their house, and a list of jargon is one more thing between them
 * and telling us about it.
 */

export interface ReportOption {
  value: ReportCategory
  label: string
  detail: string
}

const WORDS: Record<ReportCategory, { label: string; detail: string }> = {
  UNSAFE_BEHAVIOUR: {
    label: 'They behaved unsafely',
    detail: 'Threatening, intoxicated, or using equipment in a way that could hurt someone.',
  },
  HARASSMENT: {
    label: 'Harassment or unwanted contact',
    detail: 'Messages, comments or contact that made you uncomfortable.',
  },
  PROPERTY_DAMAGE: {
    label: 'They damaged something',
    detail: 'Damage to the property, a vehicle, or belongings.',
  },
  IMPERSONATION: {
    label: 'Someone else turned up',
    detail: 'The person who arrived was not the pro who claimed the job.',
  },
  OFF_PLATFORM_PAYMENT: {
    label: 'They asked to be paid outside the app',
    detail: 'Cash, transfer, or anything that leaves you without cover if it goes wrong.',
  },
  NO_SHOW: {
    label: 'They did not turn up',
    detail: 'No arrival and no message.',
  },
  OTHER: {
    label: 'Something else',
    detail: 'Tell us what happened and a person will read it.',
  },
}

/** The list, in the order it should be offered: danger first, admin last. */
export function reportOptions(): ReportOption[] {
  return REPORT_CATEGORIES.map((value) => ({ value, ...WORDS[value] }))
}

export const MIN_REPORT_DESCRIPTION = 20

/**
 * Why the report cannot be sent yet, or null.
 *
 * The minimum length is the server's, restated here so somebody finds out
 * before they press send rather than after. It exists because a reviewer
 * cannot act on "bad", and an unactionable report clogs the one queue that
 * exists for safety.
 */
export function whyCannotReport(
  category: string | null,
  description: string,
): string | null {
  if (!category) return 'Pick what happened.'
  const short = MIN_REPORT_DESCRIPTION - description.trim().length
  if (short > 0) {
    return `Tell us a bit more — ${short} more character${short === 1 ? '' : 's'}.`
  }
  return null
}

/**
 * What blocking someone actually does, said plainly before they do it.
 *
 * "Block" means different things in different apps. Here it is specific and
 * worth stating: their work disappears from your map, yours from theirs, and
 * the thread closes. It is not a report, and saying so stops somebody assuming
 * they have told us about a dangerous person when they have only hidden them.
 */
export function blockConsequences(role: 'worker' | 'customer'): string[] {
  return [
    role === 'worker'
      ? 'Their jobs stop appearing on your map.'
      : 'They will not see your jobs, and cannot claim them.',
    'Neither of you can message the other.',
    'You can undo this at any time.',
    'Blocking does not tell us anything — report them if something happened.',
  ]
}
