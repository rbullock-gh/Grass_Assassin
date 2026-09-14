import { describe, expect, it } from 'vitest'
import { textStyles } from '../src/tokens.js'

describe('text styles are valid React Native, not CSS', () => {
  const entries = Object.entries(textStyles) as Array<[string, Record<string, unknown>]>

  it('expresses lineHeight in points, never as a ratio', () => {
    // The bug this caught, found by rendering rather than reading: React Native
    // reads lineHeight as an ABSOLUTE measurement, so the CSS-style ratio 1.5
    // collapsed every line box to one and a half points and text overlapped
    // whatever was above it. It passed typecheck (a number either way) and the
    // entire unit suite (which never renders).
    for (const [name, style] of entries) {
      const lineHeight = style.lineHeight as number
      const fontSize = style.fontSize as number
      expect(lineHeight, `${name} lineHeight looks like a ratio`).toBeGreaterThan(fontSize)
    }
  })

  it('keeps line height within a sane multiple of the font size', () => {
    for (const [name, style] of entries) {
      const ratio = (style.lineHeight as number) / (style.fontSize as number)
      expect(ratio, `${name} ratio ${ratio}`).toBeGreaterThanOrEqual(1.1)
      expect(ratio, `${name} ratio ${ratio}`).toBeLessThanOrEqual(1.7)
    }
  })

  it('uses whole-point line heights so adjacent rows share a baseline', () => {
    for (const [name, style] of entries) {
      expect(Number.isInteger(style.lineHeight), `${name}`).toBe(true)
    }
  })

  it('uses fontVariant for tabular numerals, not the CSS property name', () => {
    // fontVariantNumeric is CSS. React Native ignores it silently, so prices
    // would not have aligned and nothing would have said so.
    for (const [name, style] of entries) {
      expect(style.fontVariantNumeric, `${name} uses a CSS-only property`).toBeUndefined()
    }
    expect(textStyles.price.fontVariant).toEqual(['tabular-nums'])
    expect(textStyles.priceLarge.fontVariant).toEqual(['tabular-nums'])
  })
})
