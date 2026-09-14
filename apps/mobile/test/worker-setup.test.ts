import { describe, expect, it } from 'vitest'
import {
  SETUP_STEPS, EMPTY_SETUP, RADIUS_PRESETS, MAX_RADIUS_MILES, DEFAULT_RADIUS_MILES,
  validateSetupStep, nextSetupStep, previousSetupStep, setupComplete, toggle,
  radiusAdvice, toProfilePatch,
} from '@/lib/worker-setup'

describe('worker setup steps', () => {
  it('asks what they do before anything else', () => {
    // Services drive job matching. Asked last, a worker who drops out midway
    // has an account that can never be notified about work.
    expect(SETUP_STEPS[0]).toBe('SERVICES')
  })

  it('will not continue without at least one kind of work', () => {
    const state = validateSetupStep('SERVICES', EMPTY_SETUP)
    expect(state.complete).toBe(false)
    expect(state.message).toBe('Pick at least one kind of work')
  })

  it('accepts a single service', () => {
    expect(validateSetupStep('SERVICES', { ...EMPTY_SETUP, categoryIds: ['mow'] }).complete).toBe(true)
  })

  it('starts with a usable radius rather than zero', () => {
    // A worker who skips past this must not land on an empty map.
    expect(EMPTY_SETUP.serviceRadiusMiles).toBe(DEFAULT_RADIUS_MILES)
    expect(validateSetupStep('AREA', EMPTY_SETUP).complete).toBe(true)
  })

  it('never offers a radius the server will reject', () => {
    for (const miles of RADIUS_PRESETS) {
      expect(miles, `${miles}mi`).toBeLessThanOrEqual(MAX_RADIUS_MILES)
      expect(validateSetupStep('AREA', { ...EMPTY_SETUP, serviceRadiusMiles: miles }).complete).toBe(true)
    }
  })

  it('rejects a radius beyond the server cap', () => {
    const state = validateSetupStep('AREA', { ...EMPTY_SETUP, serviceRadiusMiles: 250 })
    expect(state.complete).toBe(false)
    expect(state.message).toContain('100')
  })

  it('keeps equipment optional', () => {
    // A worker with no gear can still take jobs where the customer provides it.
    // Blocking here turns away exactly the people who most need the work.
    expect(validateSetupStep('EQUIPMENT', EMPTY_SETUP).complete).toBe(true)
  })

  it('is finishable with only a service picked', () => {
    expect(setupComplete({ ...EMPTY_SETUP, categoryIds: ['mow'] })).toBe(true)
    expect(setupComplete(EMPTY_SETUP)).toBe(false)
  })

  it('walks forward and back without falling off either end', () => {
    expect(previousSetupStep('SERVICES')).toBeNull()
    expect(nextSetupStep('EQUIPMENT')).toBeNull()
    expect(nextSetupStep('SERVICES')).toBe('AREA')
    expect(previousSetupStep('AREA')).toBe('SERVICES')
  })
})

describe('selection toggling', () => {
  it('adds and removes', () => {
    expect(toggle([], 'a')).toEqual(['a'])
    expect(toggle(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('never duplicates', () => {
    expect(toggle(toggle(['a'], 'b'), 'b')).toEqual(['a'])
  })

  it('does not mutate the original', () => {
    const original = ['a']
    toggle(original, 'b')
    expect(original).toEqual(['a'])
  })
})

describe('radius advice', () => {
  it('warns when the area is too small to see work', () => {
    // The choice that leaves a worker with an empty map and no idea why.
    expect(radiusAdvice(3)).toContain('small area')
  })

  it('warns when the drive may not be worth it', () => {
    expect(radiusAdvice(40)).toContain('fuel')
  })

  it('says nothing about an ordinary choice', () => {
    for (const miles of [5, 10, 15, 25]) {
      expect(radiusAdvice(miles), `${miles}mi`).toBeNull()
    }
  })
})

describe('what gets sent to the server', () => {
  it('always sends equipment, even when empty', () => {
    // The endpoint REPLACES rather than merges, so an omitted list silently
    // keeps whatever was there before — which on a re-run of setup would mean
    // gear the worker just unchecked stays attached.
    const patch = toProfilePatch({ ...EMPTY_SETUP, categoryIds: ['mow'] })
    expect(patch.equipmentIds).toEqual([])
    expect('equipmentIds' in patch).toBe(true)
  })

  it('sends exactly what was chosen', () => {
    const patch = toProfilePatch({
      categoryIds: ['mow', 'leaves'], serviceRadiusMiles: 10, equipmentIds: ['mower'],
    })
    expect(patch).toEqual({
      categoryIds: ['mow', 'leaves'], serviceRadiusMiles: 10, equipmentIds: ['mower'],
    })
  })
})
