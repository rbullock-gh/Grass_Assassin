import { sizeClassFor, breakpoints, type SizeClass } from '@grassassassin/design'

export type { SizeClass }
export { breakpoints, sizeClassFor }

/**
 * Layout decisions, derived from width rather than from a device list.
 *
 * Deliberately free of any React Native import so it is testable in plain Node
 * and reusable by the web client. The hook that reads real window dimensions
 * lives in use-layout.ts.
 *
 * Four classes, matching docs/02-flows-and-screens.md §4:
 *   compact  — phones: full-bleed map + draggable bottom sheet
 *   medium   — large phones, folded Fold, small tablets: persistent half sheet
 *   expanded — tablets, unfolded Fold: two-pane list | map
 *   large    — desktop: three-pane filters+list | map | detail
 *
 * Desktop is deliberately NOT a stretched phone; each class gets a genuinely
 * different composition.
 */
export interface Layout {
  sizeClass: SizeClass
  width: number
  height: number
  /** Map and list side by side rather than stacked. */
  isMultiPane: boolean
  /** Detail opens as a third pane rather than a pushed screen. */
  hasDetailPane: boolean
  /** The sheet cannot be dragged away in medium and above. */
  sheetIsPersistent: boolean
  /** Landscape on a phone: map left, list right. */
  isPhoneLandscape: boolean
  columns: number
  /**
   * Cap for single-column reading surfaces (customer home, job detail, forms).
   *
   * Without it a form on a 27" monitor becomes one 2000px-wide input, which is
   * the "stretched phone interface" failure in reverse — technically
   * responsive, unusable in practice. Measured in characters, not pixels: ~70
   * per line is the readable range, and 640 gets there at our base size.
   */
  contentMaxWidth: number
}

export function layoutFor(width: number, height: number): Layout {
  const sizeClass = sizeClassFor(width)
  const isLandscape = width > height
  return {
    sizeClass,
    width,
    height,
    isMultiPane: sizeClass === 'expanded' || sizeClass === 'large',
    hasDetailPane: sizeClass === 'large',
    sheetIsPersistent: sizeClass !== 'compact',
    isPhoneLandscape: sizeClass === 'compact' && isLandscape,
    columns: sizeClass === 'large' ? 3 : sizeClass === 'expanded' ? 2 : 1,
    // Clamped, not branched on size class. A 600pt viewport — a Flip unfolded,
    // an iPad in a narrow split — is "medium", and handing it a 640pt cap makes
    // the page wider than the screen. Min() is the whole rule: never wider than
    // the viewport, never wider than is readable.
    contentMaxWidth: Math.min(width, 640),
  }
}
