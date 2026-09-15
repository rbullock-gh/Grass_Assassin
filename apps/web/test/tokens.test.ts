/**
 * The marketing site's CSS custom properties must equal the design tokens they
 * claim to mirror.
 *
 * apps/admin restates the tokens by hand and says so; nothing checks it, so the
 * dashboard's --brand has already drifted a step darker than semanticLight.brand.
 * That is survivable on an internal tool. It is not survivable on the page a
 * customer sees immediately before opening the app, so here the mirror is
 * asserted rather than intended.
 *
 * Each declaration names its source in a trailing comment:
 *     --ga-brand: #0F833B;      /* brand *\/            -> semanticLight.brand
 *     --ga-hero-bg: #0B1410;    /* palette.ink900 *\/   -> palette.ink900
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { palette, semanticDark, semanticLight } from '@grassassassin/design'

const CSS = readFileSync(
  fileURLToPath(new URL('../src/app/globals.css', import.meta.url)),
  'utf8',
)

const DARK_MARKER = '@media (prefers-color-scheme: dark)'
const DECL = /--ga-([a-z0-9-]+)\s*:\s*([^;]+);\s*\/\*\s*([^*]+?)\s*\*\//g

type Decl = { cssVar: string; value: string; source: string }

const declarationsIn = (css: string): Decl[] =>
  [...css.matchAll(DECL)].map((m) => ({
    cssVar: `--ga-${m[1]}`,
    value: m[2].trim(),
    source: m[3].trim(),
  }))

/** The token a declaration claims to mirror, or undefined if it names nothing real. */
const tokenFor = (source: string, scheme: 'light' | 'dark'): string | undefined => {
  if (source.startsWith('palette.')) {
    return (palette as Record<string, string>)[source.slice('palette.'.length)]
  }
  const semantic = scheme === 'light' ? semanticLight : semanticDark
  return (semantic as Record<string, string>)[source]
}

const darkStart = CSS.indexOf(DARK_MARKER)

const blocks = {
  light: declarationsIn(CSS.slice(0, darkStart)),
  dark: declarationsIn(CSS.slice(darkStart)),
} as const

describe('the stylesheet mirrors @grassassassin/design', () => {
  it('finds the dark-scheme block', () => {
    expect(darkStart).toBeGreaterThan(-1)
  })

  // A guard against the mirror being quietly gutted: deleting declarations, or
  // just deleting their source comments, would otherwise make this suite pass
  // by having nothing left to check.
  it.each([
    ['light', 18],
    ['dark', 18],
  ] as const)('keeps at least %i mirrored declarations in the %s block', (scheme, least) => {
    expect(blocks[scheme].length).toBeGreaterThanOrEqual(least)
  })

  describe.each(['light', 'dark'] as const)('%s scheme', (scheme) => {
    it.each(blocks[scheme].map((d) => [d.cssVar, d] as const))(
      '%s equals the token it names',
      (_cssVar, decl) => {
        const token = tokenFor(decl.source, scheme)
        expect(token, `${decl.cssVar} names "${decl.source}", which is not a token`)
          .toBeDefined()
        expect(decl.value.toLowerCase()).toBe(String(token).toLowerCase())
      },
    )
  })

  // The two things most likely to be "fixed" by someone matching the admin
  // dashboard by eye, and the two that break button legibility when they are.
  it('uses semanticLight.brand, not the darker green the admin drifted to', () => {
    const brand = blocks.light.find((d) => d.cssVar === '--ga-brand')
    expect(brand?.value.toLowerCase()).toBe(semanticLight.brand.toLowerCase())
    expect(brand?.value.toLowerCase()).not.toBe(palette.green700.toLowerCase())
  })

  it('lifts brand in dark mode, because green600 on a dark ground fails AA', () => {
    const brand = blocks.dark.find((d) => d.cssVar === '--ga-brand')
    expect(brand?.value.toLowerCase()).toBe(semanticDark.brand.toLowerCase())
  })
})
