import { describe, it, expect } from 'vitest'
import {
  semanticLight, semanticDark, contrastRatio, mapMarker, rankVisuals,
  CONTRAST_AA_NORMAL, CONTRAST_AA_LARGE, sizeClassFor, breakpoints, minTouchTarget,
  textStyles, palette,
} from '../src/tokens.js'

/**
 * FRIDAY — accessibility is verified, not asserted.
 *
 * A design system that claims WCAG compliance without measuring it is just a
 * claim. These run the real contrast formula over the real tokens, so a future
 * palette tweak that breaks legibility fails CI instead of shipping.
 */

describe('text contrast — light theme', () => {
  const cases: Array<[string, string, string, number]> = [
    ['primary text on background',  semanticLight.textPrimary,   semanticLight.background,    CONTRAST_AA_NORMAL],
    ['primary text on surface',     semanticLight.textPrimary,   semanticLight.surface,       CONTRAST_AA_NORMAL],
    ['secondary text on surface',   semanticLight.textSecondary, semanticLight.surface,       CONTRAST_AA_NORMAL],
    ['secondary text on background',semanticLight.textSecondary, semanticLight.background,    CONTRAST_AA_NORMAL],
    ['text on brand button',        semanticLight.onBrand,       semanticLight.brand,         CONTRAST_AA_LARGE],
    ['brand text on subtle brand',  palette.green700,            semanticLight.brandSubtle,   CONTRAST_AA_NORMAL],
    ['danger text on subtle',       palette.red500,              semanticLight.dangerSubtle,  CONTRAST_AA_LARGE],
    ['payout figure on surface',    semanticLight.payout,        semanticLight.surface,       CONTRAST_AA_NORMAL],
  ]

  for (const [label, fg, bg, minimum] of cases) {
    it(`${label} meets ${minimum}:1`, () => {
      const ratio = contrastRatio(fg, bg)
      expect(ratio, `${label}: ${fg} on ${bg} scored ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum)
    })
  }
})

describe('text contrast — dark theme', () => {
  const cases: Array<[string, string, string, number]> = [
    ['primary text on background',   semanticDark.textPrimary,   semanticDark.background,  CONTRAST_AA_NORMAL],
    ['primary text on surface',      semanticDark.textPrimary,   semanticDark.surface,     CONTRAST_AA_NORMAL],
    ['secondary text on surface',    semanticDark.textSecondary, semanticDark.surface,     CONTRAST_AA_NORMAL],
    ['text on brand button',         semanticDark.onBrand,       semanticDark.brand,       CONTRAST_AA_NORMAL],
    ['payout figure on surface',     semanticDark.payout,        semanticDark.surface,     CONTRAST_AA_NORMAL],
  ]

  for (const [label, fg, bg, minimum] of cases) {
    it(`${label} meets ${minimum}:1`, () => {
      const ratio = contrastRatio(fg, bg)
      expect(ratio, `${label}: ${fg} on ${bg} scored ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum)
    })
  }

  it('lifts brand green in dark mode rather than reusing the light value', () => {
    // green500 does technically clear AA on the dark surface (5.03:1), so this
    // is not a pass/fail correction — it is a legibility margin. Dark-mode UI is
    // typically read in low ambient light where thin weights lose more contrast
    // than the formula predicts, so the dark theme steps up to green400.
    const reused = contrastRatio(palette.green500, semanticDark.surface)
    const lifted = contrastRatio(semanticDark.brand, semanticDark.surface)
    expect(lifted).toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
    expect(lifted).toBeGreaterThan(reused)
  })
})

describe('map markers stay legible at a glance', () => {
  // The marker is the product. A price a worker cannot read while driving past
  // is worse than no marker at all.
  const markers = [
    ['default', mapMarker.default],
    ['premium', mapMarker.premium],
    ['featured', mapMarker.featured],
    ['urgent', mapMarker.urgent],
    ['claimed', mapMarker.claimed],
  ] as const

  for (const [name, marker] of markers) {
    it(`${name} marker text passes AA large`, () => {
      const ratio = contrastRatio(marker.text, marker.background)
      expect(ratio, `${name}: ${marker.text} on ${marker.background} = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(CONTRAST_AA_LARGE)
    })
  }

  it('cluster bubbles are legible', () => {
    expect(contrastRatio(mapMarker.cluster.text, mapMarker.cluster.background))
      .toBeGreaterThanOrEqual(CONTRAST_AA_LARGE)
  })

  it('gives every marker a touch target at or above the 48pt minimum once padded', () => {
    for (const [name, marker] of markers) {
      // Markers render inside a transparent hit slop; the visual height plus
      // 8pt slop each side must clear the minimum.
      expect(marker.height + 16, `${name}`).toBeGreaterThanOrEqual(minTouchTarget)
    }
  })
})

describe('rank visuals', () => {
  it('is legible on light surfaces', () => {
    for (const [key, visual] of Object.entries(rankVisuals)) {
      const ratio = contrastRatio(visual.light, semanticLight.surface)
      expect(ratio, `${key} light ${visual.light} on ${semanticLight.surface} = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(CONTRAST_AA_LARGE)
    }
  })

  it('is legible on dark surfaces', () => {
    // The original single-colour-per-rank design passed this suite only because
    // it was never checked against the dark surface: Grass Assassin scored
    // 6.92:1 on white and 2.40:1 on dark. Hence per-theme values.
    for (const [key, visual] of Object.entries(rankVisuals)) {
      const ratio = contrastRatio(visual.dark, semanticDark.surface)
      expect(ratio, `${key} dark ${visual.dark} on ${semanticDark.surface} = ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(CONTRAST_AA_LARGE)
    }
  })

  it('never reuses the same colour for both themes', () => {
    // If a rank's two values are identical, one of the two surfaces is almost
    // certainly being shortchanged.
    for (const [key, visual] of Object.entries(rankVisuals)) {
      expect(visual.light, `${key} uses one colour for both themes`).not.toBe(visual.dark)
    }
  })

  it('covers every rank in the domain model', () => {
    const domainRanks = ['ROOKIE', 'TRIMMER', 'LAWN_RANGER', 'YARD_HUNTER', 'GRASS_ASSASSIN', 'ELITE_ASSASSIN', 'LEGEND']
    for (const r of domainRanks) expect(rankVisuals[r], `missing visual for ${r}`).toBeDefined()
  })
})

describe('responsive size classes', () => {
  it('maps real device widths to the intended layout', () => {
    expect(sizeClassFor(375)).toBe('compact')   // iPhone SE / 13 mini
    expect(sizeClassFor(390)).toBe('compact')   // iPhone 15
    expect(sizeClassFor(430)).toBe('compact')   // iPhone 15 Pro Max
    expect(sizeClassFor(344)).toBe('compact')   // Galaxy Fold, folded
    expect(sizeClassFor(768)).toBe('medium')    // iPad portrait
    expect(sizeClassFor(904)).toBe('medium')
    expect(sizeClassFor(905)).toBe('expanded')  // Fold, unfolded
    expect(sizeClassFor(1024)).toBe('expanded') // iPad landscape
    expect(sizeClassFor(1440)).toBe('large')    // desktop
    expect(sizeClassFor(1920)).toBe('large')
  })

  it('is monotonic — a wider screen never gets a narrower layout', () => {
    const order = ['compact', 'medium', 'expanded', 'large']
    let previous = -1
    for (let w = 200; w <= 2400; w += 13) {
      const index = order.indexOf(sizeClassFor(w))
      expect(index).toBeGreaterThanOrEqual(previous)
      previous = index
    }
  })

  it('has strictly increasing breakpoints', () => {
    const values = Object.values(breakpoints)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
  })
})

describe('typography', () => {
  it('uses tabular figures everywhere money is displayed', () => {
    // A column of prices whose digits jitter reads as amateur, and price is the
    // most-scanned element in the product.
    // fontVariant, not fontVariantNumeric: the latter is CSS and React Native
    // ignores it silently, so this assertion used to pass while the app got no
    // tabular numerals at all.
    expect(textStyles.price.fontVariant).toEqual(['tabular-nums'])
    expect(textStyles.priceLarge.fontVariant).toEqual(['tabular-nums'])
  })

  it('keeps body text at or above 15px for outdoor legibility', () => {
    expect(textStyles.body.fontSize).toBeGreaterThanOrEqual(15)
    expect(textStyles.bodyLarge.fontSize).toBeGreaterThanOrEqual(15)
  })

  it('has a monotonically increasing type scale', () => {
    const sizes = [
      textStyles.caption.fontSize, textStyles.body.fontSize, textStyles.bodyLarge.fontSize,
      textStyles.subheading.fontSize, textStyles.heading.fontSize,
      textStyles.title.fontSize, textStyles.display.fontSize, textStyles.displayLarge.fontSize,
    ]
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!)
  })
})
