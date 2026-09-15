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
    // AA_NORMAL, not AA_LARGE. This case asked for 3:1 and green500 scored 3.30,
    // so it passed while every primary button in the app was failing for real:
    // the labels are 15px, and the large-text exemption starts at 18.66px bold.
    ['text on brand button',        semanticLight.onBrand,       semanticLight.brand,         CONTRAST_AA_NORMAL],
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
  /**
   * Rank names render at 13px, so they are normal text and owe 4.5:1.
   *
   * This suite used to check them at CONTRAST_AA_LARGE, and passed while the
   * rendered app showed Lawn Ranger at 3.30:1. A threshold that does not match
   * the size the thing is drawn at is not a check, it is a rubber stamp — the
   * same mistake the brand-button case in this file made.
   */
  const lightSurfaces = [
    ['surface', semanticLight.surface],
    ['background', semanticLight.background],
    ['surfaceSunken', semanticLight.surfaceSunken],
  ] as const
  const darkSurfaces = [
    ['surface', semanticDark.surface],
    ['background', semanticDark.background],
    ['surfaceSunken', semanticDark.surfaceSunken],
  ] as const

  it('is legible as 13px text on every light surface it can land on', () => {
    for (const [key, visual] of Object.entries(rankVisuals)) {
      for (const [surfaceName, surface] of lightSurfaces) {
        const ratio = contrastRatio(visual.light, surface)
        expect(ratio, `${key} light ${visual.light} on ${surfaceName} ${surface} = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
      }
    }
  })

  it('is legible as 13px text on every dark surface it can land on', () => {
    for (const [key, visual] of Object.entries(rankVisuals)) {
      for (const [surfaceName, surface] of darkSurfaces) {
        const ratio = contrastRatio(visual.dark, surface)
        expect(ratio, `${key} dark ${visual.dark} on ${surfaceName} ${surface} = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
      }
    }
  })

  it('keeps the ladder distinguishable after the darkening', () => {
    // Fixing contrast by pushing every rank to the same near-black would pass
    // the two tests above and destroy the thing ranks are for. Adjacent ranks
    // must stay apart: the progression is the feature.
    const order = ['ROOKIE', 'TRIMMER', 'LAWN_RANGER', 'YARD_HUNTER', 'GRASS_ASSASSIN', 'ELITE_ASSASSIN', 'LEGEND']
    const seen = new Set<string>()
    for (const key of order) {
      const light = rankVisuals[key]!.light.toUpperCase()
      expect(seen.has(light), `${key} reuses ${light}`).toBe(false)
      seen.add(light)
    }
    // Within the green run, each step is visibly deeper than the last.
    const greenRun = ['TRIMMER', 'LAWN_RANGER', 'YARD_HUNTER', 'GRASS_ASSASSIN']
    for (let i = 1; i < greenRun.length; i += 1) {
      const previous = contrastRatio(rankVisuals[greenRun[i - 1]!]!.light, semanticLight.surface)
      const current = contrastRatio(rankVisuals[greenRun[i]!]!.light, semanticLight.surface)
      expect(current, `${greenRun[i]} is no deeper than ${greenRun[i - 1]}`).toBeGreaterThan(previous + 0.5)
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

describe('the "not ready yet" button state', () => {
  /**
   * A primary button whose step is incomplete looks greyed out, but it is NOT
   * disabled: tapping it is how someone finds out what is missing. That makes
   * its label active text, so WCAG's exemption for inactive components does not
   * apply and it owes the full 4.5:1.
   *
   * Found by measuring a screenshot: the label was textTertiary on
   * surfaceSunken, which is 2.86:1.
   */
  it('keeps the label readable in both themes', () => {
    for (const [name, theme] of [['light', semanticLight], ['dark', semanticDark]] as const) {
      const ratio = contrastRatio(theme.textSecondary, theme.surfaceSunken)
      expect(ratio, `${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
    }
  })

  /**
   * This used to assert the opposite: that textTertiary was NOT readable enough
   * for this button, as a guard against someone swapping the cheaper-looking
   * token back in.
   *
   * An automated audit across every screen then found that the same token was
   * failing AA everywhere else it appeared — the price bands, the overlines,
   * every caption — so it was darkened from ink400 to ink500 rather than
   * avoided in one place. The guard's intent survives as the stronger rule
   * below: no text token may be too faint on any surface it is used on, so
   * there is no longer a cheap one to swap in.
   */
  it('has no text token that fails on any surface it sits on', () => {
    const surfaces = ['background', 'surface', 'surfaceSunken'] as const
    const texts = ['textPrimary', 'textSecondary', 'textTertiary'] as const

    for (const [name, theme] of [['light', semanticLight], ['dark', semanticDark]] as const) {
      for (const text of texts) {
        for (const surface of surfaces) {
          const ratio = contrastRatio(theme[text], theme[surface])
          expect(
            ratio,
            `${name}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
        }
      }
    }
  })

  it('keeps white legible on every brand surface that carries a label', () => {
    // Every primary button in the product. White on green500 measured 3.30:1,
    // which is why brand is green600.
    for (const [name, theme] of [['light', semanticLight], ['dark', semanticDark]] as const) {
      for (const surface of ['brand', 'brandHover', 'brandPressed'] as const) {
        const ratio = contrastRatio(theme.onBrand, theme[surface])
        expect(
          ratio,
          `${name}: onBrand on ${surface} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
      }
    }
  })

  it('keeps the rank colour readable, since the leaderboard exists to be read', () => {
    for (const [name, theme] of [['light', semanticLight], ['dark', semanticDark]] as const) {
      const ratio = contrastRatio(theme.rank, theme.surface)
      expect(ratio, `${name}: rank is ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(CONTRAST_AA_NORMAL)
    }
  })
})
