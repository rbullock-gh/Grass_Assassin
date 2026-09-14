import { useWindowDimensions } from 'react-native'
import { layoutFor, type Layout } from './responsive'

/** Live layout for the current window. Pure logic lives in responsive.ts. */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions()
  return layoutFor(width, height)
}

export type { Layout }
export { layoutFor }
