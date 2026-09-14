/**
 * Worker onboarding.
 *
 * A worker who signs up and is dropped straight onto the map has a default
 * service radius and no declared services, which quietly breaks the thing the
 * product runs on: job-match notifications have nothing to match against, so
 * they are never told when work appears. They conclude there is no work here.
 *
 * So this asks three questions — what do you do, how far will you go, what gear
 * do you have — and nothing else. No documents, no interview, no bio. Every
 * extra field here is a worker who does not finish signing up, and a
 * marketplace with no supply has no demand either.
 */

export const SETUP_STEPS = ['SERVICES', 'AREA', 'EQUIPMENT'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export interface WorkerSetup {
  categoryIds: string[]
  serviceRadiusMiles: number
  equipmentIds: string[]
}

/**
 * Fifteen miles is the default because it is the median of what workers
 * actually choose elsewhere, and because a too-small radius on day one produces
 * an empty map, which is the worst possible first impression.
 */
export const DEFAULT_RADIUS_MILES = 15

export const RADIUS_PRESETS = [3, 5, 10, 15, 25, 40] as const

export const EMPTY_SETUP: WorkerSetup = {
  categoryIds: [],
  serviceRadiusMiles: DEFAULT_RADIUS_MILES,
  equipmentIds: [],
}

/** The server caps the radius; the UI must not offer more than it will accept. */
export const MAX_RADIUS_MILES = 100

export interface StepState {
  complete: boolean
  message?: string
}

export function validateSetupStep(step: SetupStep, setup: WorkerSetup): StepState {
  switch (step) {
    case 'SERVICES':
      return setup.categoryIds.length > 0
        ? { complete: true }
        : { complete: false, message: 'Pick at least one kind of work' }

    case 'AREA':
      if (setup.serviceRadiusMiles <= 0) {
        return { complete: false, message: 'Choose how far you will travel' }
      }
      if (setup.serviceRadiusMiles > MAX_RADIUS_MILES) {
        return { complete: false, message: `The maximum is ${MAX_RADIUS_MILES} miles` }
      }
      return { complete: true }

    case 'EQUIPMENT':
      // Deliberately optional. A worker with no gear of their own can still
      // take jobs where the customer provides it, and blocking here would turn
      // away exactly the people who most need the work.
      return { complete: true }
  }
}

export function nextSetupStep(step: SetupStep): SetupStep | null {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1] ?? null
}

export function previousSetupStep(step: SetupStep): SetupStep | null {
  const index = SETUP_STEPS.indexOf(step)
  return index <= 0 ? null : SETUP_STEPS[index - 1] ?? null
}

export function setupComplete(setup: WorkerSetup): boolean {
  return SETUP_STEPS.every((step) => validateSetupStep(step, setup).complete)
}

export function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
}

/**
 * How many jobs a radius is likely to reach, in words rather than a number.
 *
 * A raw count would be a promise we cannot keep — today's count is not next
 * week's. What a worker actually needs to know is whether they have chosen
 * something unusually narrow, which is the choice that leaves them with an
 * empty map and no idea why.
 */
export function radiusAdvice(miles: number): string | null {
  if (miles <= 3) return 'That is a small area — you may not see much. You can widen it any time.'
  if (miles >= 40) return 'A long way to drive. Check the pay covers the fuel before you claim.'
  return null
}

/** What the server is sent once all three questions are answered. */
export function toProfilePatch(setup: WorkerSetup): {
  categoryIds: string[]
  serviceRadiusMiles: number
  equipmentIds: string[]
} {
  return {
    categoryIds: setup.categoryIds,
    serviceRadiusMiles: setup.serviceRadiusMiles,
    // Sent even when empty: the endpoint REPLACES rather than merges, so an
    // omitted list would silently keep whatever was there before.
    equipmentIds: setup.equipmentIds,
  }
}
