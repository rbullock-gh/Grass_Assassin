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
  // Dark enough to be readable as TEXT on white. gold500 is 2.3:1 there, which
  // is a decorative colour being asked to do a job it cannot do.
  gold600: '#8A6208',
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
  /**
   * Was ink400, which measured 3.43:1 on white — below WCAG AA for body text.
   *
   * It read as refined on a desk monitor and was the colour on the price bands,
   * the overlines and every caption in the app. A worker reads those outdoors on
   * a phone at arm's length; faint grey is the wrong call twice over.
   */
  textTertiary:     palette.ink500,
  textInverse:      palette.white,

  /**
   * green600, not green500.
   *
   * White text on green500 is 3.30:1 and fails AA — and that combination is
   * every primary button in the product: POST A JOB, CLAIM, Withdraw. green600
   * takes it to 4.85:1 and is still unmistakably the same green.
   */
  brand:            palette.green600,
  brandHover:       palette.green700,
  brandPressed:     palette.green800,
  brandSubtle:      palette.green50,
  onBrand:          palette.white,

  success:          palette.green600,
  successSubtle:    palette.green50,
  warning:          palette.amber500,
  warningSubtle:    palette.amber100,
  danger:           palette.red500,
  dangerSubtle:     palette.red100,
  info:             palette.blue500,
  infoSubtle:       palette.blue100,

  /**
   * Text on the matching *Subtle surface.
   *
   * The semantic colours above are for icons, borders and fills — shapes, not
   * sentences. Used as TEXT on their own wash they were, in light mode:
   * warning 2.86:1, danger 3.95:1, info 4.24:1. The worst of them was the
   * "Location is off" banner on the worker's map, the most-seen warning in the
   * product, and it had been shipping unreadable. Anything that puts words on a
   * *Subtle background uses these instead.
   */
  successInk:       palette.green700,
  warningInk:       '#8A5A06',
  dangerInk:        '#A31515',
  infoInk:          '#1D4ED8',

  /**
   * Brand green as TEXT, which is not the same colour as brand green as a fill.
   *
   * green600 on the light background measures 4.496:1 — under the 4.5:1 that
   * body text needs, by four thousandths. It is fine as a button fill with
   * white on top, and it had been shipping as link text on every screen with a
   * "Create an account instead" or "I forgot my password" under the button.
   *
   * A miss this small is worth naming precisely, because it is the kind that
   * gets waved through: the audit that found it PRINTED the ratio as "4.5:1",
   * rounded, so its own output read like a pass. The reporting was fixed at the
   * same time as the colour.
   */
  brandInk:         palette.green700,

  payout:           palette.green600,
  // gold500 as rank NUMBERS on white measured 2.3:1 — the least readable thing
  // in the app sat on the leaderboard, which exists to be read.
  rank:             palette.gold600,
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

  /**
   * Three of these are the semantic colour unchanged, because on a dark ground
   * they already read. amber500 does not — 4.10:1 on its own wash — so warning
   * is the one that lifts, which is the same colour that failed worst in light
   * mode for the opposite reason.
   */
  successInk:       palette.green400,
  warningInk:       palette.gold400,
  dangerInk:        '#F87171',
  infoInk:          '#60A5FA',

  // On the dark ground the brand green already measures 8.1:1 as text, so this
  // is the same colour rather than a darker one — the light-mode problem does
  // not exist here and inventing a difference would only add a thing to drift.
  brandInk:         palette.green400,

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
  /**
   * A cluster bubble.
   *
   * green600, not green500: white on green500 is 3.30:1, and the cluster count
   * is 14px text, so it owes 4.5:1. It was the only marker variant missing from
   * the contrast suite, which is why it survived the same correction every
   * other white-on-green surface got.
   *
   * The smallest size is 44, not 36, for the same reason the filter chips are:
   * this is tapped outdoors, one-handed, often with gloves on.
   */
  cluster: {
    background: palette.green600, text: palette.white,
    sizes: { sm: 44, md: 48, lg: 56 },
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

/**
 * The light column is darker than a rank badge "wants" to be, and deliberately.
 *
 * These are rendered as the rank NAME beside a worker — 13px text, not a
 * decorative dot — so they are body copy and owe 4.5:1, not the 3:1 a large
 * badge would owe. The audit caught the earlier ladder at 3.30:1 (Lawn Ranger)
 * through 4.37:1 (Rookie) on white: the leaderboard, whose entire purpose is to
 * be read, held the least readable text in the product.
 *
 * Every light value now clears 4.5:1 against surfaceSunken (#E6ECE8), the
 * darkest light-theme surface a rank can land on, which means it also clears it
 * on surface and background. The ladder still steps — Rookie is grey-green and
 * each rank above it deepens — so the progression survives the correction.
 */
export const rankVisuals: Record<string, RankVisual> = {
  ROOKIE:         { light: '#5D6C64', dark: '#A8B6AE', glow: 'rgba(124,143,133,0.25)', label: 'Rookie' },
  TRIMMER:        { light: '#34754C', dark: '#6FCB95', glow: 'rgba(75,158,107,0.25)',  label: 'Trimmer' },
  LAWN_RANGER:    { light: '#0E6A30', dark: '#39C26F', glow: 'rgba(22,163,74,0.28)',   label: 'Lawn Ranger' },
  YARD_HUNTER:    { light: '#0A5928', dark: '#4FCF7D', glow: 'rgba(15,131,59,0.30)',   label: 'Yard Hunter' },
  GRASS_ASSASSIN: { light: '#084720', dark: '#69D894', glow: 'rgba(12,104,47,0.34)',   label: 'Grass Assassin' },
  ELITE_ASSASSIN: { light: '#886205', dark: '#EBB833', glow: 'rgba(217,162,27,0.34)',  label: 'Elite Assassin' },
  LEGEND:         { light: '#725104', dark: '#F5C842', glow: 'rgba(184,134,11,0.42)',  label: 'Legend' },
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
