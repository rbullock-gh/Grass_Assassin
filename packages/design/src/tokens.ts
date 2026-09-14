/**
 * GrassAssassin design tokens.
 *
 * One source of truth consumed by the Expo app, the Next.js web app, and the
 * admin panel. Tokens are plain data — no styling library is assumed — so the
 * same values drive React Native StyleSheet, Tailwind config, and CSS custom
 * properties without translation drift.
 *
 * Direction (docs/00-strategy.md Q3): premium with a competitive edge. The
 * customer is inviting a stranger onto their property and handing over money,
 * so the surface must read as trustworthy and expensive. The name is already
 * funny; the design must not also be.
 */

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/**
 * The palette is built around a deep, saturated grass green that reads as
 * "outdoor professional" rather than "kids' app". The critical constraint: the
 * map base is desaturated, so brand green must POP against it at 14px on a
 * sunlit phone screen held at arm's length. That rules out the pastel greens
 * most lawn-care brands default to.
 */
export const palette = {
  // Primary — GrassAssassin green
  green50:  '#EDFBF0',
  green100: '#D2F5DC',
  green200: '#A6E9BC',
  green300: '#69D894',
  green400: '#39C26F',
  green500: '#16A34A', // primary
  green600: '#0F833B',
  green700: '#0C682F',
  green800: '#0A5227',
  green900: '#073B1D',

  // Ink — warm-neutral greys. Pure #000 looks cheap on OLED; these do not.
  ink900: '#0B1410',
  ink800: '#16211B',
  ink700: '#24332B',
  ink600: '#3A4B41',
  ink500: '#566B5F',
  ink400: '#7C8F85',
  ink300: '#A8B6AE',
  ink200: '#CFD8D2',
  ink100: '#E6ECE8',
  ink50:  '#F4F7F5',
  white:  '#FFFFFF',

  // Accent — used sparingly for payout emphasis and rank moments.
  gold500: '#D9A21B',
  gold400: '#EBB833',
  gold100: '#FBF0D4',

  // Semantic
  red500:    '#DC2626',
  red100:    '#FEE2E2',
  amber500:  '#D97706',
  amber100:  '#FEF3C7',
  blue500:   '#2563EB',
  blue100:   '#DBEAFE',
} as const

export const semanticLight = {
  background:       palette.ink50,
  surface:          palette.white,
  surfaceRaised:    palette.white,
  surfaceSunken:    palette.ink100,
  border:           palette.ink200,
  borderStrong:     palette.ink300,

  textPrimary:      palette.ink900,
  textSecondary:    palette.ink500,
  textTertiary:     palette.ink400,
  textInverse:      palette.white,

  brand:            palette.green500,
  brandHover:       palette.green600,
  brandPressed:     palette.green700,
  brandSubtle:      palette.green50,
  onBrand:          palette.white,

  success:          palette.green500,
  successSubtle:    palette.green50,
  warning:          palette.amber500,
  warningSubtle:    palette.amber100,
  danger:           palette.red500,
  dangerSubtle:     palette.red100,
  info:             palette.blue500,
  infoSubtle:       palette.blue100,

  payout:           palette.green600,
  rank:             palette.gold500,
  rankSubtle:       palette.gold100,
} as const

export const semanticDark = {
  background:       palette.ink900,
  surface:          palette.ink800,
  surfaceRaised:    palette.ink700,
  surfaceSunken:    '#060D0A',
  border:           palette.ink700,
  borderStrong:     palette.ink600,

  textPrimary:      palette.ink50,
  textSecondary:    palette.ink300,
  textTertiary:     palette.ink400,
  textInverse:      palette.ink900,

  // Lifted one step in dark mode: green500 on a dark ground fails AA for text.
  brand:            palette.green400,
  brandHover:       palette.green300,
  brandPressed:     palette.green200,
  brandSubtle:      'rgba(57, 194, 111, 0.14)',
  onBrand:          palette.ink900,

  success:          palette.green400,
  successSubtle:    'rgba(57, 194, 111, 0.14)',
  warning:          palette.amber500,
  warningSubtle:    'rgba(217, 119, 6, 0.18)',
  danger:           '#F87171',
  dangerSubtle:     'rgba(220, 38, 38, 0.18)',
  info:             '#60A5FA',
  infoSubtle:       'rgba(37, 99, 235, 0.18)',

  payout:           palette.green400,
  rank:             palette.gold400,
  rankSubtle:       'rgba(217, 162, 27, 0.18)',
} as const

/**
 * The semantic colour contract.
 *
 * Declared as an explicit record of strings rather than `typeof semanticLight`.
 * Inferring from the light palette gives every key a string LITERAL type, which
 * makes the dark palette — whose values differ by definition — fail to satisfy
 * the same type. The contract is the set of keys, not their light values.
 */
export type SemanticColors = { readonly [K in keyof typeof semanticLight]: string }

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * Inter for UI. It is the most legible interface face at small sizes on both
 * platforms, has genuine optical sizing, and its tabular figures matter here:
 * a column of prices where the digits jitter looks amateur, and price is the
 * single most scanned element in the product.
 *
 * Numeric display uses tabular lining figures everywhere money appears.
 */
export const fontFamily = {
  sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  // Used only for large payout numerals and rank names.
  display: 'Inter Display, Inter, -apple-system, BlinkMacSystemFont, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const

export const fontSize = {
  xs:   11,
  sm:   13,
  base: 15,
  md:   17,
  lg:   20,
  xl:   24,
  '2xl': 30,
  '3xl': 38,
  '4xl': 48,
} as const

export const fontWeight = {
  regular:  '400',
  medium:   '500',
  semibold: '600',
  bold:     '700',
  black:    '800',
} as const

export const lineHeight = {
  tight:   1.15,
  snug:    1.3,
  normal:  1.5,
  relaxed: 1.65,
} as const

export const letterSpacing = {
  tighter: -0.6,
  tight:   -0.3,
  normal:  0,
  wide:    0.4,
  wider:   1.2,
} as const

/** Named text styles, so components never assemble type from raw tokens. */
/**
 * Text styles, expressed for React Native.
 *
 * lineHeight is in POINTS, not a ratio. React Native reads the value as an
 * absolute measurement, so `lineHeight: 1.5` collapses every line box to one
 * and a half points and the text in it overlaps whatever is above. CSS reads
 * the same unitless number as a multiplier, which is why the ratio form looks
 * right in a stylesheet and is silently destructive here — the bug survives
 * typecheck (it is a number either way) and the unit suite (which never
 * renders), and only appears the moment something is drawn.
 *
 * So the ratios stay in `lineHeight` as design intent, and these multiply them
 * out. Rounded, because a fractional line height produces uneven baselines
 * between adjacent rows of the same style.
 */
const leading = (size: number, ratio: number): number => Math.round(size * ratio)

/**
 * Tabular numerals, in the form React Native accepts.
 *
 * Typed as a mutable tuple rather than `as const`: React Native's TextStyle
 * declares fontVariant as a mutable array, and a readonly one is rejected.
 */
const tabular: { fontVariant: ['tabular-nums'] } = { fontVariant: ['tabular-nums'] }

export const textStyles = {
  displayLarge: { fontSize: fontSize['4xl'], fontWeight: fontWeight.black,    lineHeight: leading(fontSize['4xl'], lineHeight.tight),  letterSpacing: letterSpacing.tighter },
  display:      { fontSize: fontSize['3xl'], fontWeight: fontWeight.bold,     lineHeight: leading(fontSize['3xl'], lineHeight.tight),  letterSpacing: letterSpacing.tighter },
  title:        { fontSize: fontSize['2xl'], fontWeight: fontWeight.bold,     lineHeight: leading(fontSize['2xl'], lineHeight.snug),   letterSpacing: letterSpacing.tight },
  heading:      { fontSize: fontSize.xl,     fontWeight: fontWeight.semibold, lineHeight: leading(fontSize.xl, lineHeight.snug),       letterSpacing: letterSpacing.tight },
  subheading:   { fontSize: fontSize.lg,     fontWeight: fontWeight.semibold, lineHeight: leading(fontSize.lg, lineHeight.snug),       letterSpacing: letterSpacing.normal },
  bodyLarge:    { fontSize: fontSize.md,     fontWeight: fontWeight.regular,  lineHeight: leading(fontSize.md, lineHeight.normal),     letterSpacing: letterSpacing.normal },
  body:         { fontSize: fontSize.base,   fontWeight: fontWeight.regular,  lineHeight: leading(fontSize.base, lineHeight.normal),   letterSpacing: letterSpacing.normal },
  bodyStrong:   { fontSize: fontSize.base,   fontWeight: fontWeight.semibold, lineHeight: leading(fontSize.base, lineHeight.normal),   letterSpacing: letterSpacing.normal },
  caption:      { fontSize: fontSize.sm,     fontWeight: fontWeight.regular,  lineHeight: leading(fontSize.sm, lineHeight.snug),       letterSpacing: letterSpacing.normal },
  captionStrong:{ fontSize: fontSize.sm,     fontWeight: fontWeight.semibold, lineHeight: leading(fontSize.sm, lineHeight.snug),       letterSpacing: letterSpacing.normal },
  overline:     { fontSize: fontSize.xs,     fontWeight: fontWeight.bold,     lineHeight: leading(fontSize.xs, lineHeight.snug),       letterSpacing: letterSpacing.wider, textTransform: 'uppercase' as const },
  /** Money. Always tabular so columns of prices align. */
  price:        { fontSize: fontSize.xl,     fontWeight: fontWeight.bold,     lineHeight: leading(fontSize.xl, lineHeight.tight),      letterSpacing: letterSpacing.tight, ...tabular },
  priceLarge:   { fontSize: fontSize['3xl'], fontWeight: fontWeight.black,    lineHeight: leading(fontSize['3xl'], lineHeight.tight),  letterSpacing: letterSpacing.tighter, ...tabular },
} as const

// ---------------------------------------------------------------------------
// Space, radius, elevation, motion
// ---------------------------------------------------------------------------

/** 4pt base grid. */
export const space = {
  px: 1, 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28,
  8: 32, 10: 40, 12: 48, 16: 64, 20: 80, 24: 96,
} as const

export const radius = {
  none: 0, sm: 6, md: 10, lg: 14, xl: 20, '2xl': 28, full: 9999,
} as const

/**
 * Elevation is deliberately restrained. Heavy drop shadows read as dated;
 * these are tuned to separate a card from a map without looking like 2014.
 */
export const elevation = {
  none: { shadowColor: 'transparent', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
  sm:   { shadowColor: '#0B1410', shadowOpacity: 0.06, shadowRadius: 3,  shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  md:   { shadowColor: '#0B1410', shadowOpacity: 0.09, shadowRadius: 8,  shadowOffset: { width: 0, height: 3 }, elevation: 3 },
  lg:   { shadowColor: '#0B1410', shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  /** Bottom sheet resting above the map. */
  sheet:{ shadowColor: '#0B1410', shadowOpacity: 0.16, shadowRadius: 28, shadowOffset: { width: 0, height: -6 }, elevation: 16 },
} as const

/**
 * Motion. Durations are short on purpose — the claim interaction must feel
 * instant, because a worker racing for a job perceives any animation as lag.
 */
export const motion = {
  duration: { instant: 80, fast: 140, normal: 220, slow: 320, sheet: 280 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
    /** Used only for the claim-won confirmation. */
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
} as const

// ---------------------------------------------------------------------------
// Layout — responsive strategy (docs/02-flows-and-screens.md §4)
// ---------------------------------------------------------------------------

export const breakpoints = {
  /** Phones. Full-bleed map + draggable bottom sheet. */
  compact: 0,
  /** Large phones, folded Fold, small tablets. Map + persistent half sheet. */
  medium: 600,
  /** Tablets, unfolded Fold. Two-pane: list rail | map. */
  expanded: 905,
  /** Desktop. Three-pane: filters+list | map | detail. */
  large: 1240,
} as const

export type SizeClass = keyof typeof breakpoints

export function sizeClassFor(width: number): SizeClass {
  if (width >= breakpoints.large) return 'large'
  if (width >= breakpoints.expanded) return 'expanded'
  if (width >= breakpoints.medium) return 'medium'
  return 'compact'
}

/** Pane widths for the multi-pane layouts. Map takes the remainder. */
export const paneWidth = { listRail: 360, listRailLarge: 380, detail: 420 } as const

/** Bottom-sheet detents as a fraction of viewport height. */
export const sheetDetents = { peek: 0.16, half: 0.5, full: 0.92 } as const

/**
 * Minimum touch target. 44pt is Apple's floor and Android's is 48dp; we use 48
 * everywhere because the primary action is often taken one-handed, outdoors,
 * possibly wearing gloves.
 */
export const minTouchTarget = 48

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

/**
 * Map markers.
 *
 * The marker IS the product. A worker scanning the map is answering one
 * question — "what can I make money on right now?" — so the marker leads with
 * price and nothing else competes with it.
 */
export const mapMarker = {
  /** Standard price pill. */
  default: {
    background: palette.white, text: palette.ink900, border: palette.ink200,
    height: 32, paddingHorizontal: 10, radius: radius.full,
  },
  /** Premium payout — top quartile. Inverted so it reads first. */
  premium: {
    background: palette.green600, text: palette.white, border: palette.green700,
    height: 34, paddingHorizontal: 11, radius: radius.full,
  },
  /** Customer paid to feature. Gold rim, never a different shape — shape is reserved for meaning. */
  featured: {
    background: palette.white, text: palette.ink900, border: palette.gold500,
    height: 34, paddingHorizontal: 11, radius: radius.full, borderWidth: 2,
  },
  /** Deadline within 6 hours. */
  urgent: {
    background: palette.red500, text: palette.white, border: '#B91C1C',
    height: 32, paddingHorizontal: 10, radius: radius.full,
  },
  /** Already claimed — visible on the worker's own active-job view only. */
  claimed: {
    background: palette.ink300, text: palette.ink700, border: palette.ink400,
    // 32, not 30: with 8pt hit slop each side this clears the 48pt minimum
    // touch target. A 30pt marker missed it by 2pt.
    height: 32, paddingHorizontal: 9, radius: radius.full,
  },
  cluster: {
    background: palette.green500, text: palette.white,
    sizes: { sm: 36, md: 44, lg: 54 },
  },
} as const

/**
 * Mapbox style URLs. The base map is deliberately desaturated so green price
 * markers carry all the visual weight.
 */
export const mapStyle = {
  light: 'mapbox://styles/mapbox/light-v11',
  dark: 'mapbox://styles/mapbox/dark-v11',
  /** Replace with the published custom style once brand tuning is done. */
  custom: null as string | null,
} as const

// ---------------------------------------------------------------------------
// Rank visuals
// ---------------------------------------------------------------------------

/**
 * Rank visuals, per theme.
 *
 * A single colour per rank cannot work: the deep greens that read well on white
 * (Grass Assassin at 6.92:1) collapse against a dark surface (2.40:1), and the
 * golds do the reverse. Each rank therefore carries a light-surface and a
 * dark-surface value, both verified against WCAG AA-large in test/contrast.test.ts.
 *
 * The progression is cool -> warm -> gold so standing is legible at a glance
 * without reading the label. Deliberately not a rainbow.
 */
export interface RankVisual {
  /** For use on light surfaces. */
  light: string
  /** For use on dark surfaces. */
  dark: string
  glow: string
  label: string
}

export const rankVisuals: Record<string, RankVisual> = {
  ROOKIE:         { light: '#6B7D73', dark: '#A8B6AE', glow: 'rgba(124,143,133,0.25)', label: 'Rookie' },
  TRIMMER:        { light: '#3D8A5A', dark: '#6FCB95', glow: 'rgba(75,158,107,0.25)',  label: 'Trimmer' },
  LAWN_RANGER:    { light: '#16A34A', dark: '#39C26F', glow: 'rgba(22,163,74,0.28)',   label: 'Lawn Ranger' },
  YARD_HUNTER:    { light: '#0F833B', dark: '#4FCF7D', glow: 'rgba(15,131,59,0.30)',   label: 'Yard Hunter' },
  GRASS_ASSASSIN: { light: '#0C682F', dark: '#69D894', glow: 'rgba(12,104,47,0.34)',   label: 'Grass Assassin' },
  ELITE_ASSASSIN: { light: '#9A6F06', dark: '#EBB833', glow: 'rgba(217,162,27,0.34)',  label: 'Elite Assassin' },
  LEGEND:         { light: '#8F6605', dark: '#F5C842', glow: 'rgba(184,134,11,0.42)',  label: 'Legend' },
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const channel = (offset: number) => {
    const v = parseInt(full.slice(offset, offset + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

export const CONTRAST_AA_NORMAL = 4.5
export const CONTRAST_AA_LARGE = 3
export const CONTRAST_AAA_NORMAL = 7
