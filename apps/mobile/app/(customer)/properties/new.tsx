import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { router } from 'expo-router'
import * as Location from 'expo-location'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { YARD_SIZE_LABELS, type YardSize } from '@/lib/post-flow'
import { Input } from '@/components/input'
import { addressComplete, addressFieldErrors, formatAddressLine, type AddressDraft } from '@/lib/address'

/**
 * Adding a property.
 *
 * The address is the most sensitive thing a customer gives us, so the screen
 * says plainly what happens to it — workers see a neighbourhood until someone
 * has actually claimed and paid. Burying that in a privacy policy and hoping
 * nobody asks is how you lose the customers who care most.
 *
 * Geocoding runs on the device. The OS geocoder is already installed, already
 * has the user's trust, and costs nothing — and it means an address does not
 * leave the phone until the property is actually saved.
 */
export default function NewPropertyScreen() {
  const c = useColors()
  const layout = useLayout()

  const [draft, setDraft] = useState<AddressDraft>({
    label: 'Home', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '',
  })
  const [yardSize, setYardSize] = useState<YardSize>('QUARTER_TO_HALF')
  const [hasDog, setHasDog] = useState(false)
  const [gateCode, setGateCode] = useState('')
  const [saving, setSaving] = useState(false)
  // Errors appear only after the customer has tried to save. Flagging a ZIP as
  // wrong while they are still typing the second digit is nagging, not help.
  const [showErrors, setShowErrors] = useState(false)

  const patch = useCallback((changes: Partial<AddressDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
  }, [])

  const save = useCallback(async () => {
    if (!addressComplete(draft)) { setShowErrors(true); return }
    setSaving(true)
    try {
      const location = await resolveLocation(draft)
      if (!location) {
        showAlert(
          'We could not find that address',
          'Check the street and postcode, or move to the property and tap "Use my current location".',
        )
        return
      }

      await api.createProperty({
        label: draft.label.trim() || 'Home',
        addressLine1: draft.addressLine1.trim(),
        addressLine2: draft.addressLine2.trim() || undefined,
        city: draft.city.trim(),
        state: draft.state.trim().toUpperCase(),
        postalCode: draft.postalCode.trim(),
        location,
        yardSize,
        hasDog,
        gateCode: gateCode.trim() || undefined,
      })
      router.back()
    } catch (error) {
      // Includes OUTSIDE_SERVICE_AREA, which is a real answer rather than a
      // failure — telling someone we are not live near them beats letting them
      // post onto an empty map.
      showAlert('Could not save', error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setSaving(false)
    }
  }, [draft, yardSize, hasDog, gateCode])

  const useCurrentLocation = useCallback(async () => {
    const permission = await Location.requestForegroundPermissionsAsync()
    if (permission.status !== 'granted') {
      showAlert('Location is off', 'Enable location access, or type the address instead.')
      return
    }
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    const [place] = await Location.reverseGeocodeAsync({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    })
    if (!place) {
      showAlert('No address found here', 'Type it in instead.')
      return
    }
    patch({
      addressLine1: [place.streetNumber, place.street].filter(Boolean).join(' '),
      city: place.city ?? place.subregion ?? '',
      state: place.region ?? '',
      postalCode: place.postalCode ?? '',
    })
  }, [patch])

  // The save button stays live even when the form is incomplete: a button that
  // greys out and says nothing is how someone ready to pay gives up. Tapping it
  // reveals what is missing instead.
  const errors = showErrors ? addressFieldErrors(draft) : {}
  const ready = addressComplete(draft)

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Your property</Text>
        <Text style={[textStyles.body, { color: c.textSecondary }]}>
          Pros browsing the map see the neighbourhood, never the street address. The exact
          address unlocks only for the one pro who claims and pays for the job.
        </Text>

        <Pressable
          onPress={() => void useCurrentLocation()}
          accessibilityRole="button"
          style={[styles.locate, { borderColor: c.brand, backgroundColor: c.brandSubtle }]}
        >
          <Text style={{ color: c.brandInk, fontWeight: '700' }}>Use my current location</Text>
        </Pressable>

        <View style={{ gap: space[3] }}>
          <Input label="Name it" value={draft.label} onChangeText={(label) => patch({ label })} placeholder="Home" />
          <Input
            label="Street address" value={draft.addressLine1}
            onChangeText={(addressLine1) => patch({ addressLine1 })}
            placeholder="128 Maple Street"
            error={errors.addressLine1}
          />
          <Input
            label="Apartment or unit (optional)" value={draft.addressLine2}
            onChangeText={(addressLine2) => patch({ addressLine2 })} placeholder="Apt 4B"
          />
          <Input
            label="City" value={draft.city} onChangeText={(city) => patch({ city })}
            placeholder="Nashville" error={errors.city}
          />
          <View style={{ flexDirection: 'row', gap: space[3] }}>
            <View style={{ flex: 1 }}>
              <Input
                label="State" value={draft.state} onChangeText={(state) => patch({ state })}
                placeholder="TN" autoCapitalize="none" error={errors.state}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Input
                label="ZIP" value={draft.postalCode}
                onChangeText={(postalCode) => patch({ postalCode })}
                placeholder="37203" keyboardType="number-pad" error={errors.postalCode}
              />
            </View>
          </View>
        </View>

        <View style={{ gap: space[2], marginTop: space[5] }}>
          <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>YARD SIZE</Text>
          <View style={styles.chips}>
            {(Object.keys(YARD_SIZE_LABELS) as YardSize[]).map((size) => {
              const selected = yardSize === size
              return (
                <Pressable
                  key={size}
                  onPress={() => setYardSize(size)}
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
                  <Text style={{ color: selected ? c.brand : c.textPrimary, fontWeight: '600' }}>
                    {YARD_SIZE_LABELS[size]}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>

        <View style={{ gap: space[3], marginTop: space[5] }}>
          <Toggle
            label="There is a dog in the yard"
            hint="Pros see this before they claim, so nobody is surprised at the gate."
            value={hasDog}
            onChange={setHasDog}
          />
          <Input
            label="Gate code (optional)" value={gateCode} onChangeText={setGateCode}
            placeholder="1234"
          />
          <Text style={[textStyles.caption, { color: c.textTertiary }]}>
            The gate code is released with the address — only to the pro who has claimed the job.
          </Text>
        </View>

        <Pressable
          onPress={() => void save()}
          disabled={saving}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: ready ? (pressed ? c.brandHover : c.brand) : c.surfaceSunken },
          ]}
        >
          {saving
            ? <ActivityIndicator color={c.onBrand} />
            : (
              <Text style={{ color: ready ? c.onBrand : c.textSecondary, fontWeight: '800', fontSize: 15 }}>
                SAVE PROPERTY
              </Text>
            )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Toggle({ label, hint, value, onChange }: {
  label: string; hint: string; value: boolean; onChange: (next: boolean) => void
}) {
  const c = useColors()
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      style={[styles.toggle, { borderColor: value ? c.brand : c.border, backgroundColor: value ? c.brandSubtle : c.surface }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{label}</Text>
        <Text style={[textStyles.caption, { color: c.textSecondary }]}>{hint}</Text>
      </View>
      <Text style={{ color: value ? c.brand : c.textTertiary, fontWeight: '800' }}>{value ? 'YES' : 'NO'}</Text>
    </Pressable>
  )
}

/** Geocodes the typed address, falling back to the device's position. */
async function resolveLocation(draft: AddressDraft): Promise<{ lat: number; lng: number } | null> {
  try {
    const [match] = await Location.geocodeAsync(formatAddressLine(draft))
    if (match) return { lat: match.latitude, lng: match.longitude }
  } catch {
    // The OS geocoder is unavailable on some devices and offline on all of
    // them. Falling through to the device position is better than refusing.
  }

  try {
    const permission = await Location.getForegroundPermissionsAsync()
    if (permission.status !== 'granted') return null
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
    return { lat: position.coords.latitude, lng: position.coords.longitude }
  } catch {
    return null
  }
}

const styles = StyleSheet.create({
  content: { padding: space[5], gap: space[3], paddingBottom: space[10] },
  locate: {
    marginTop: space[3], minHeight: minTouchTarget, borderWidth: 1, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    borderRadius: radius.md, paddingHorizontal: space[3],
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
  },
  toggle: {
    flexDirection: 'row', alignItems: 'center', gap: space[3],
    borderWidth: 1, borderRadius: radius.md, padding: space[4], minHeight: minTouchTarget,
  },
  primary: {
    marginTop: space[6], minHeight: minTouchTarget + 8, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
})
