import { useColorScheme, type ColorSchemeName } from 'react-native'
import { semanticLight, semanticDark, type SemanticColors } from '@grassassassin/design'

export {
  space, radius, elevation, motion, textStyles, fontSize, fontWeight,
  mapMarker, rankVisuals, minTouchTarget, sheetDetents, paneWidth,
} from '@grassassassin/design'

export function colorsFor(scheme: ColorSchemeName): SemanticColors {
  return scheme === 'dark' ? semanticDark : semanticLight
}

/**
 * Theme colours for the current appearance.
 *
 * The worker map is used outdoors in direct sun and at dusk, so both themes
 * are first-class rather than dark mode being an afterthought bolted on.
 */
export function useColors(): SemanticColors {
  return colorsFor(useColorScheme())
}

export function useIsDark(): boolean {
  return useColorScheme() === 'dark'
}
