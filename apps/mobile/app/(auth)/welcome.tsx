import { View, Text, StyleSheet, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'

/**
 * First screen.
 *
 * Three claims, no sign-up wall. The account is created later, inside the post
 * flow, at the moment the customer is committed — asking for one here is a
 * chore before any value has been shown.
 */
export default function WelcomeScreen() {
  const c = useColors()
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + space[8], paddingBottom: insets.bottom + space[4] }]}>
      <View style={styles.hero}>
        <View style={[styles.mark, { backgroundColor: c.brand }]}>
          <Text style={{ color: c.onBrand, fontSize: 28, fontWeight: '800' }}>GA</Text>
        </View>
        <Text style={[textStyles.displayLarge, { color: c.textPrimary, textAlign: 'center' }]}>
          Yard work,{'\n'}claimed.
        </Text>
        <Text style={[textStyles.bodyLarge, { color: c.textSecondary, textAlign: 'center' }]}>
          Post a job. A vetted pro nearby takes it. You approve the work before
          anyone gets paid.
        </Text>
      </View>

      <View style={styles.points}>
        <Point text="No bidding, no phone tag — jobs get claimed in minutes." />
        <Point text="You set the price. Pros choose whether to take it." />
        <Point text="Before and after photos on every job." />
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push('/(auth)/sign-up')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? c.brandHover : c.brand }]}
        >
          <Text style={{ color: c.onBrand, fontWeight: '800', fontSize: 15 }}>GET STARTED</Text>
        </Pressable>

        <Pressable
          onPress={() => router.push('/(auth)/sign-in')}
          accessibilityRole="button"
          style={[styles.secondary, { borderColor: c.border }]}
        >
          <Text style={{ color: c.textPrimary, fontWeight: '700', fontSize: 15 }}>I already have an account</Text>
        </Pressable>
      </View>
    </View>
  )
}

function Point({ text }: { text: string }) {
  const c = useColors()
  return (
    <View style={styles.point}>
      <View style={[styles.bullet, { backgroundColor: c.brand }]} />
      <Text style={[textStyles.body, { color: c.textSecondary, flex: 1 }]}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: space[5], justifyContent: 'space-between' },
  hero: { alignItems: 'center', gap: space[4] },
  mark: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  points: { gap: space[3] },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  bullet: { width: 7, height: 7, borderRadius: 4, marginTop: 8 },
  actions: { gap: space[2] },
  primary: {
    minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  secondary: {
    minHeight: minTouchTarget + 6, borderRadius: radius.md, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
})
