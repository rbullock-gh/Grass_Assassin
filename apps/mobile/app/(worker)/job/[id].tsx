import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Linking, Platform } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import * as Location from 'expo-location'
import type { JobDetail } from '@grassassassin/client'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { displayPrice, displayPayout, formatDeadline, yardSizeLabel } from '@/lib/jobs'
import { PhotoCapture } from '@/components/photo-capture'
import { gateSatisfied } from '@/lib/photo-upload'

/**
 * Job detail.
 *
 * The screen makes the privacy boundary visible rather than silently hiding
 * fields: before claiming, it says plainly that the exact address unlocks on
 * claim. A worker who cannot tell whether information is missing or withheld
 * assumes the app is broken.
 */
export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const c = useColors()
  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    try {
      setJob(await api.job(id))
    } catch {
      showAlert('Could not load this job', 'It may have been cancelled.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  const claim = useCallback(async () => {
    if (!job) return
    setWorking(true)
    try {
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null)
      const result = await api.claimJob(job.id, position
        ? { lat: position.coords.latitude, lng: position.coords.longitude }
        : undefined)

      if (result.outcome === 'WON') await load()
      else showAlert('Just missed it', result.message, [{ text: 'Back to map', onPress: () => router.back() }])
    } finally {
      setWorking(false)
    }
  }, [job, load])

  const advance = useCallback(async (to: string) => {
    if (!job) return
    setWorking(true)
    try {
      const position = to === 'IN_PROGRESS'
        ? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null)
        : null
      await api.updateJobStatus(job.id, to, position
        ? { workerLocation: { lat: position.coords.latitude, lng: position.coords.longitude } }
        : {})
      await load()
    } catch (error) {
      // Surface the server's message: "You need to be within 150m of the
      // property to start work" is genuinely useful; "Something went wrong"
      // is not.
      showAlert('Could not update', error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setWorking(false)
    }
  }, [job, load])

  const openDirections = useCallback(() => {
    if (!job?.location) return
    const { lat, lng } = job.location
    // Hand off to whichever nav app the worker already uses rather than
    // building turn-by-turn we would do worse (docs/01-architecture.md §2).
    const url = Platform.select({
      ios: `maps://?daddr=${lat},${lng}`,
      android: `google.navigation:q=${lat},${lng}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    })
    void Linking.openURL(url)
  }, [job])

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.brand} />
      </View>
    )
  }

  if (!job) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={{ color: c.textSecondary }}>This job is no longer available.</Text>
      </View>
    )
  }

  const isMine = job.viewerRole === 'WORKER'
  // Only CONFIRMED photos count. A presigned-but-never-uploaded row is PENDING
  // and the server does not accept it, so the UI must not either — otherwise
  // the button says go and the server says no.
  const beforePhotos = job.photos.filter((photo) => photo.kind === 'BEFORE')
  const afterPhotos = job.photos.filter((photo) => photo.kind === 'AFTER')
  const canStart = gateSatisfied('BEFORE', beforePhotos.length)
  const canComplete = gateSatisfied('AFTER', afterPhotos.length)
  const locked = job.locationPrecision === 'APPROXIMATE'

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
    >
      <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[textStyles.priceLarge, { color: c.payout }]}>{displayPrice(job.priceCents)}</Text>
        <Text style={[textStyles.heading, { color: c.textPrimary }]}>{job.title}</Text>
        <Text style={[textStyles.body, { color: c.textSecondary }]}>
          You earn {displayPayout(job.workerPayoutCents)} after the platform fee.
        </Text>
      </View>

      <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Row label="Due" value={formatDeadline(job.dueAt)} />
        <Row label="Yard size" value={yardSizeLabel(job.yardSize) ?? 'Not specified'} />
        <Row label="Estimated" value={job.estimatedMinutes ? `${job.estimatedMinutes} min` : 'Not estimated'} />
        <Row label="Equipment" value={job.equipmentProvided ? 'Provided by customer' : 'Bring your own'} />
        <Row label="Customer" value={
          job.customer.rating !== null
            ? `${job.customer.firstName} · ★ ${job.customer.rating.toFixed(1)}`
            : `${job.customer.firstName} · not yet rated`
        } />
      </View>

      {job.description ? (
        <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.sectionLabel, { color: c.textTertiary }]}>WHAT THEY NEED</Text>
          <Text style={[textStyles.body, { color: c.textPrimary }]}>{job.description}</Text>
        </View>
      ) : null}

      <View style={[styles.panel, { backgroundColor: locked ? c.surfaceSunken : c.surface, borderColor: c.border }]}>
        <Text style={[styles.sectionLabel, { color: c.textTertiary }]}>LOCATION</Text>
        {locked ? (
          <>
            <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{job.generalArea}</Text>
            {/* Say plainly that this is withheld, not missing. */}
            <Text style={[textStyles.caption, { color: c.textSecondary }]}>
              The exact address unlocks as soon as you claim this job. Customers'
              addresses are never shown to pros who have not accepted the work.
            </Text>
          </>
        ) : (
          <>
            <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
              {job.address?.addressLine1}
            </Text>
            <Text style={[textStyles.body, { color: c.textSecondary }]}>
              {job.address?.city}, {job.address?.state} {job.address?.postalCode}
            </Text>
            {job.address?.gateCode ? <Row label="Gate code" value={job.address.gateCode} /> : null}
            {job.address?.hasDog ? <Row label="Dog on property" value="Yes" /> : null}
            {job.specialInstructions ? (
              <Text style={[textStyles.body, { color: c.textPrimary, marginTop: space[2] }]}>
                {job.specialInstructions}
              </Text>
            ) : null}
            <Pressable onPress={openDirections} style={[styles.secondary, { borderColor: c.brand }]}>
              <Text style={{ color: c.brandInk, fontWeight: '700' }}>Get directions</Text>
            </Pressable>
            {/* Sits directly under the address, which is where the questions
                come from: a locked gate, a dog in the yard, a bin in the way.
                Without it the only way to ask is a phone number. */}
            <Pressable
              onPress={() => router.push(`/(shared)/messages/${job.id}`)}
              accessibilityRole="button"
              style={[styles.secondary, { borderColor: c.border }]}
            >
              <Text style={{ color: c.textPrimary, fontWeight: '700' }}>
                Message {job.customer.firstName}
              </Text>
            </Pressable>
          </>
        )}
      </View>

      {/* The photo gates. The server refuses IN_PROGRESS without a confirmed
          BEFORE photo and PENDING_APPROVAL without an AFTER, so these appear
          exactly where the worker is about to be stopped — before the button,
          not as an error after it. */}
      {isMine && job.status === 'EN_ROUTE' ? (
        <PhotoCapture jobId={job.id} kind="BEFORE" existing={beforePhotos} onUploaded={() => void load()} />
      ) : null}

      {isMine && job.status === 'IN_PROGRESS' ? (
        <PhotoCapture jobId={job.id} kind="AFTER" existing={afterPhotos} onUploaded={() => void load()} />
      ) : null}

      <View style={styles.actions}>
        {!isMine && job.status === 'POSTED' ? (
          <PrimaryButton
            label={`CLAIM ${displayPayout(job.workerPayoutCents)}`}
            onPress={() => void claim()}
            busy={working}
          />
        ) : null}

        {isMine && job.status === 'CLAIMED' ? (
          <PrimaryButton label="I'M ON MY WAY" onPress={() => void advance('EN_ROUTE')} busy={working} />
        ) : null}

        {isMine && job.status === 'EN_ROUTE' ? (
          <PrimaryButton
            label={canStart ? 'START WORK' : 'TAKE A BEFORE PHOTO FIRST'}
            onPress={() => void advance('IN_PROGRESS')}
            busy={working}
            disabled={!canStart}
          />
        ) : null}

        {isMine && job.status === 'IN_PROGRESS' ? (
          <PrimaryButton
            label={canComplete ? 'MARK COMPLETE' : 'TAKE AN AFTER PHOTO FIRST'}
            onPress={() => void advance('PENDING_APPROVAL')}
            busy={working}
            disabled={!canComplete}
          />
        ) : null}

        {isMine && job.status === 'PENDING_APPROVAL' ? (
          <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>
            Waiting on the customer. This approves automatically in 24 hours, so
            your payment is never stuck behind a silent customer.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  const c = useColors()
  return (
    <View style={styles.row}>
      <Text style={[textStyles.body, { color: c.textSecondary }]}>{label}</Text>
      <Text style={[textStyles.bodyStrong, { color: c.textPrimary, flexShrink: 1, textAlign: 'right' }]}>
        {value}
      </Text>
    </View>
  )
}

function PrimaryButton({ label, onPress, busy, disabled }: {
  label: string
  onPress: () => void
  busy?: boolean
  /**
   * Genuinely not available yet — a gate the server enforces, not a validation
   * the worker can fix by tapping. So unlike the forms elsewhere in the app,
   * this one really is inert, and the label says what to do instead.
   */
  disabled?: boolean
}) {
  const c = useColors()
  const inert = Boolean(busy || disabled)
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert }}
      style={({ pressed }) => [
        styles.primary,
        {
          backgroundColor: disabled ? c.surfaceSunken : (pressed ? c.brandHover : c.brand),
          opacity: busy ? 0.7 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={c.onBrand} /> : (
        <Text style={{
          // textSecondary rather than tertiary: 2.86:1 is not enough for a
          // label that is telling someone what to do next.
          color: disabled ? c.textSecondary : c.onBrand,
          fontWeight: '800', fontSize: 15, letterSpacing: 0.4,
        }}>{label}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space[4], gap: space[3] },
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  sectionLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1.1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space[4], paddingVertical: 3 },
  actions: { gap: space[2], marginTop: space[2] },
  primary: {
    minHeight: minTouchTarget + 4, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  secondary: {
    minHeight: minTouchTarget, borderRadius: radius.md, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center', marginTop: space[2],
  },
})
