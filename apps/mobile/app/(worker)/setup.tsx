import { useCallback, useEffect, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import * as Location from 'expo-location'
import type { Category, Equipment } from '@grassassassin/client'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import {
  SETUP_STEPS, EMPTY_SETUP, RADIUS_PRESETS, validateSetupStep, nextSetupStep,
  previousSetupStep, setupComplete, toggle, radiusAdvice, toProfilePatch,
  type SetupStep, type WorkerSetup,
} from '@/lib/worker-setup'

/**
 * Setting up a worker account — three questions, then the map.
 *
 * Deliberately short. Every field here is a worker who does not finish signing
 * up, and a marketplace with no supply has no demand either. What it does have
 * to collect is what the matching engine needs: without services and a radius,
 * job-match notifications have nothing to match on, so a new worker is never
 * told when work appears and concludes there is none.
 */
export default function WorkerSetupScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()
  const { refresh } = useAuth()

  const [step, setStep] = useState<SetupStep>('SERVICES')
  const [setup, setSetup] = useState<WorkerSetup>(EMPTY_SETUP)
  const [categories, setCategories] = useState<Category[]>([])
  const [equipment, setEquipment] = useState<Equipment[]>([])
  const [showError, setShowError] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void Promise.all([api.categories(), api.equipment()])
      .then(([categoryResult, equipmentResult]) => {
        setCategories(categoryResult.categories)
        setEquipment(equipmentResult.equipment)
      })
      .catch(() => showAlert('Could not load', 'Check your connection and try again.'))
  }, [])

  const validation = validateSetupStep(step, setup)

  const advance = useCallback(() => {
    if (!validation.complete) { setShowError(true); return }
    const next = nextSetupStep(step)
    if (next) { setStep(next); setShowError(false) }
  }, [step, validation.complete])

  const back = useCallback(() => {
    const previous = previousSetupStep(step)
    if (previous) { setStep(previous); setShowError(false) }
  }, [step])

  const finish = useCallback(async () => {
    if (!setupComplete(setup)) { setShowError(true); return }
    setSaving(true)
    try {
      // The base location is sent when we have it, so matching can start from
      // where they actually are rather than the middle of the service area.
      // Its absence is not a blocker — the radius alone is enough to start.
      const permission = await Location.getForegroundPermissionsAsync()
      const position = permission.status === 'granted'
        ? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null)
        : null

      await api.updateWorkerProfile({
        ...toProfilePatch(setup),
        ...(position
          ? { baseLocation: { lat: position.coords.latitude, lng: position.coords.longitude } }
          : {}),
      })
      await refresh()
      router.replace('/(worker)/map')
    } catch (error) {
      showAlert('Could not save', error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setSaving(false)
    }
  }, [setup, refresh])

  const isLast = step === 'EQUIPMENT'
  const advice = step === 'AREA' ? radiusAdvice(setup.serviceRadiusMiles) : null

  return (
    <View style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top + space[3] }]}>
      <View style={styles.progress}>
        {SETUP_STEPS.map((key) => (
          <View
            key={key}
            style={[
              styles.dot,
              {
                backgroundColor: key === step ? c.brand : c.borderStrong,
                width: key === step ? 22 : 7,
              },
            ]}
          />
        ))}
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
        ]}
      >
        {step === 'SERVICES' ? (
          <>
            <Heading
              title="What work do you do?"
              subtitle="You will only be shown jobs you picked. Change this any time."
            />
            <View style={styles.chips}>
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  label={category.name}
                  selected={setup.categoryIds.includes(category.id)}
                  onPress={() => setSetup((s) => ({ ...s, categoryIds: toggle(s.categoryIds, category.id) }))}
                />
              ))}
            </View>
          </>
        ) : null}

        {step === 'AREA' ? (
          <>
            <Heading
              title="How far will you travel?"
              subtitle="From wherever you are when you open the app."
            />
            <View style={styles.chips}>
              {RADIUS_PRESETS.map((miles) => (
                <Chip
                  key={miles}
                  label={`${miles} mi`}
                  selected={setup.serviceRadiusMiles === miles}
                  onPress={() => setSetup((s) => ({ ...s, serviceRadiusMiles: miles }))}
                />
              ))}
            </View>
            {advice ? (
              <Text style={[textStyles.caption, { color: c.textSecondary, marginTop: space[3] }]}>
                {advice}
              </Text>
            ) : null}
          </>
        ) : null}

        {step === 'EQUIPMENT' ? (
          <>
            <Heading
              title="What gear do you have?"
              subtitle="Optional. Without it you will still see jobs where the customer provides equipment."
            />
            <View style={styles.chips}>
              {equipment.map((item) => (
                <Chip
                  key={item.id}
                  label={item.name}
                  selected={setup.equipmentIds.includes(item.id)}
                  onPress={() => setSetup((s) => ({ ...s, equipmentIds: toggle(s.equipmentIds, item.id) }))}
                />
              ))}
            </View>
          </>
        ) : null}

        {showError && validation.message ? (
          <Text style={[textStyles.body, { color: c.dangerInk, marginTop: space[4] }]}>
            {validation.message}
          </Text>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space[3], borderTopColor: c.border }]}>
        {previousSetupStep(step) ? (
          <Pressable onPress={back} accessibilityRole="button" style={styles.back}>
            <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Back</Text>
          </Pressable>
        ) : <View style={styles.back} />}

        <Pressable
          onPress={() => (isLast ? void finish() : advance())}
          disabled={saving}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.primary,
            {
              backgroundColor: validation.complete
                ? (pressed ? c.brandHover : c.brand)
                : c.surfaceSunken,
            },
          ]}
        >
          {saving ? <ActivityIndicator color={c.onBrand} /> : (
            <Text
              style={{
                // See the design tests: this button stays tappable when the
                // step is incomplete, so its label is active text and owes the
                // full contrast ratio.
                color: validation.complete ? c.onBrand : c.textSecondary,
                fontWeight: '800',
                fontSize: 15,
              }}
            >
              {isLast ? 'START FINDING WORK' : 'CONTINUE'}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  )
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  const c = useColors()
  return (
    <View style={{ gap: space[2], marginBottom: space[5] }}>
      <Text style={[textStyles.title, { color: c.textPrimary }]}>{title}</Text>
      <Text style={[textStyles.body, { color: c.textSecondary }]}>{subtitle}</Text>
    </View>
  )
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? c.brandSubtle : c.surface,
          borderColor: selected ? c.brand : c.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <Text style={{ color: selected ? c.brand : c.textPrimary, fontWeight: '600', fontSize: 14 }}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  progress: { flexDirection: 'row', gap: space[1], justifyContent: 'center', paddingBottom: space[4] },
  dot: { height: 7, borderRadius: radius.full },
  content: { paddingHorizontal: space[5], paddingBottom: space[6] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    borderRadius: radius.full, paddingHorizontal: space[4],
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
  },
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: space[3],
    paddingHorizontal: space[5], paddingTop: space[3], borderTopWidth: 1,
  },
  back: { minWidth: 56, minHeight: minTouchTarget, justifyContent: 'center' },
  primary: {
    flex: 1, minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
})
