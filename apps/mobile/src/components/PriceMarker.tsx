import { memo } from 'react'
import { Text, View, Pressable, StyleSheet } from 'react-native'
import { mapMarker, radius, minTouchTarget } from '@grassassassin/design'
import type { MarkerVariant } from '@/lib/jobs'

/**
 * A map marker.
 *
 * The marker IS the product: a worker scanning the map is answering one
 * question — "what can I make money on right now?" — so price leads and nothing
 * competes with it.
 *
 * Wrapped in a transparent hit area so the tap target clears 48pt even though
 * the visible pill is ~32pt. The primary action here is taken one-handed,
 * outdoors, possibly wearing gloves.
 */
export interface PriceMarkerProps {
  label: string
  variant: MarkerVariant
  selected?: boolean
  onPress?: () => void
  accessibilityLabel?: string
}

export const PriceMarker = memo(function PriceMarker({
  label, variant, selected, onPress, accessibilityLabel,
}: PriceMarkerProps) {
  const style = mapMarker[variant]
  const borderWidth = variant === 'featured' ? 2 : 1

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${label} job`}
      hitSlop={Math.max(0, (minTouchTarget - style.height) / 2)}
      style={styles.hit}
    >
      <View
        style={[
          styles.pill,
          {
            backgroundColor: style.background,
            borderColor: selected ? style.text : style.border,
            borderWidth: selected ? 2.5 : borderWidth,
            height: style.height,
            paddingHorizontal: style.paddingHorizontal,
            borderRadius: radius.full,
            transform: [{ scale: selected ? 1.12 : 1 }],
          },
        ]}
      >
        <Text style={[styles.label, { color: style.text }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={[styles.tail, { borderTopColor: style.background }]} />
    </Pressable>
  )
})

export const ClusterMarker = memo(function ClusterMarker({
  count, onPress,
}: { count: number; onPress?: () => void }) {
  const size = count >= 25 ? mapMarker.cluster.sizes.lg
    : count >= 10 ? mapMarker.cluster.sizes.md
    : mapMarker.cluster.sizes.sm

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${count} jobs in this area. Tap to zoom in.`}
      style={[
        styles.cluster,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: mapMarker.cluster.background },
      ]}
    >
      <Text style={[styles.clusterLabel, { color: mapMarker.cluster.text }]}>{count}</Text>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  hit: { alignItems: 'center' },
  pill: {
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0B1410', shadowOpacity: 0.18, shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  label: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // Small pointer so the pill reads as anchored to a place rather than floating.
  tail: {
    width: 0, height: 0, marginTop: -1,
    borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
  },
  cluster: {
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#0B1410', shadowOpacity: 0.22, shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
  clusterLabel: { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
})
