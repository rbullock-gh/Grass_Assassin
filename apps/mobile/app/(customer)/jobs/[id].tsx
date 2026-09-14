import { useCallback, useEffect, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Alert, Image,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import type { JobDetail } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { displayPrice, formatDeadline } from '@/lib/jobs'
import {
  customerStatus, customerActions, autoApproveNotice, tipOptions,
} from '@/lib/customer-jobs'

/**
 * Tracking a job you are paying for.
 *
 * Built around one question — "what is happening at my house right now?" — and
 * answered in the first screenful: status, who is coming, when. Everything the
 * customer can DO sits in a single action block at the bottom rather than
 * scattered through the page, because which actions are legal depends entirely
 * on status and scattering them means half of them are wrong half the time.
 */
export default function CustomerJobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const c = useColors()
  const layout = useLayout()

  const [job, setJob] = useState<JobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    try {
      setJob(await api.job(id))
    } catch {
      Alert.alert('Could not load this job', 'Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (action: () => Promise<unknown>, failureTitle: string) => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (error) {
      // The server's message is the useful one: "You can set up recurring
      // service once this job is complete" beats "Something went wrong".
      Alert.alert(failureTitle, error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setBusy(false)
    }
  }, [load])

  const approve = useCallback(() => {
    if (!job) return
    Alert.alert(
      'Approve this work?',
      `Your pro will be paid ${displayPrice(job.workerPayoutCents)}. You can still leave a rating afterwards.`,
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Approve', onPress: () => void run(() => api.updateJobStatus(job.id, 'APPROVED'), 'Could not approve') },
      ],
    )
  }, [job, run])

  const reportProblem = useCallback(() => {
    if (!job) return
    Alert.alert(
      'Report a problem',
      'A person will review this within one business day. Your payment is held until it is resolved — nothing is charged to your pro automatically.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: () => void run(() => api.updateJobStatus(job.id, 'DISPUTED'), 'Could not report'),
        },
      ],
    )
  }, [job, run])

  const cancel = useCallback(async () => {
    if (!job) return
    // Show the real financial consequence BEFORE asking, not after. A
    // cancellation fee discovered on a receipt is a chargeback.
    let preview
    try {
      preview = await api.cancellationPreview(job.id)
    } catch {
      Alert.alert('Could not check', 'Please try again.')
      return
    }

    const refund = displayPrice(preview.customerRefundCents)
    const toWorker = preview.workerCompensationCents > 0
      ? ` Your pro keeps ${displayPrice(preview.workerCompensationCents)} for the time they already committed.`
      : ''

    Alert.alert(
      'Cancel this job?',
      `You will be refunded ${refund}.${toWorker}`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel job',
          style: 'destructive',
          onPress: () => void run(async () => {
            await api.cancelJob(job.id)
            router.replace('/(customer)/home')
          }, 'Could not cancel'),
        },
      ],
    )
  }, [job, run])

  // Selected, not submitted. A rating permanently changes a real person's rank
  // and how much work they get, so a mistap on a 3" target must not be able to
  // do that — the customer picks, sees what they picked, then confirms.
  const [pendingRating, setPendingRating] = useState<number | null>(null)

  const submitRating = useCallback(() => {
    if (!job || pendingRating === null) return
    void run(async () => {
      await api.reviewJob(job.id, { rating: pendingRating })
      setReviewed(true)
    }, 'Could not save your rating')
  }, [job, pendingRating, run])

  const tip = useCallback((amountCents: number) => {
    if (!job || amountCents === 0) return
    // Confirmed, because this moves money. An accidental tap that charges a
    // card is how an app earns a chargeback and a one-star review at once.
    Alert.alert(
      `Send a ${displayPrice(amountCents)} tip?`,
      `${job.worker?.firstName ?? 'Your pro'} keeps all of it — we take nothing from tips.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send', onPress: () => void run(() => api.tipWorker(job.id, amountCents), 'Could not send the tip') },
      ],
    )
  }, [job, run])

  const makeRecurring = useCallback(() => {
    if (!job) return
    Alert.alert(
      'Set up regular service?',
      `We will book ${job.worker?.firstName ?? 'a pro'} for this again automatically. You can change or stop it any time.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Every week', onPress: () => void run(() => api.makeRecurring(job.id, { interval: 'WEEKLY' }), 'Could not set that up') },
        { text: 'Every 2 weeks', onPress: () => void run(() => api.makeRecurring(job.id, { interval: 'BIWEEKLY' }), 'Could not set that up') },
      ],
    )
  }, [job, run])

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
        <Text style={{ color: c.textSecondary }}>We could not find that job.</Text>
      </View>
    )
  }

  const status = customerStatus(job.status)
  const actions = customerActions(job.status, reviewed)
  const notice = autoApproveNotice(job.autoApproveAt)
  const afterPhotos = job.photos.filter((photo) => photo.kind === 'AFTER')

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
      ]}
    >
      <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[textStyles.overline, { color: status.needsYou ? c.warning : c.textTertiary }]}>
          {status.pill}
        </Text>
        <Text style={[textStyles.heading, { color: c.textPrimary }]}>{status.label}</Text>
        <Text style={[textStyles.body, { color: c.textSecondary }]}>
          {job.category?.name ?? job.title} · {displayPrice(job.priceCents)}
          {job.status === 'POSTED' ? ` · needed ${formatDeadline(job.dueAt)}` : ''}
        </Text>
        {notice ? (
          <Text style={[textStyles.caption, { color: c.warning, marginTop: space[2] }]}>{notice}</Text>
        ) : null}
      </View>

      {job.worker ? (
        <Pressable
          onPress={() => router.push(`/(worker)/profile/${job.worker!.id}`)}
          accessibilityRole="button"
          accessibilityLabel={`View ${job.worker.firstName}'s profile`}
          style={[styles.panel, styles.workerRow, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <View style={[styles.avatar, { backgroundColor: c.surfaceSunken }]}>
            {job.worker.avatarUrl ? (
              <Image source={{ uri: job.worker.avatarUrl }} style={styles.avatarImage} />
            ) : (
              <Text style={{ color: c.textSecondary, fontWeight: '800', fontSize: 18 }}>
                {job.worker.firstName.slice(0, 1).toUpperCase()}
              </Text>
            )}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
              {job.worker.firstName}
              {job.worker.rank?.verifiedBadge ? ' ✓' : ''}
            </Text>
            <Text style={[textStyles.caption, { color: c.textSecondary }]}>
              {job.worker.rank?.name ?? 'Pro'}
              {job.worker.rating !== null ? ` · ${job.worker.rating.toFixed(1)}★` : ''}
              {job.worker.completedJobs > 0 ? ` · ${job.worker.completedJobs} jobs` : ''}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {afterPhotos.length > 0 ? (
        <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>THE FINISHED WORK</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
            {afterPhotos.map((photo) => (
              <Image key={photo.id} source={{ uri: photo.url }} style={styles.photo} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {actions.canRate ? (
        <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
            How did {job.worker?.firstName ?? 'your pro'} do?
          </Text>
          <View style={styles.stars}>
            {[1, 2, 3, 4, 5].map((value) => {
              const filled = pendingRating !== null && value <= pendingRating
              return (
                <Pressable
                  key={value}
                  onPress={() => setPendingRating(value)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`${value} star${value === 1 ? '' : 's'}`}
                  accessibilityState={{ selected: filled }}
                  style={styles.star}
                >
                  <Text style={{ fontSize: 30, color: filled ? c.rank : c.textTertiary }}>
                    {filled ? '★' : '☆'}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          {pendingRating !== null ? (
            <Primary
              label={`SUBMIT ${pendingRating} STAR${pendingRating === 1 ? '' : 'S'}`}
              onPress={submitRating}
              busy={busy}
            />
          ) : null}
        </View>
      ) : null}

      {actions.canTip ? (
        <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>Add a tip?</Text>
          <Text style={[textStyles.caption, { color: c.textSecondary }]}>
            Every cent goes to your pro — we take nothing from tips.
          </Text>
          <View style={styles.tipRow}>
            {tipOptions(job.priceCents).map((option) => (
              <Pressable
                key={option.label}
                onPress={() => tip(option.amountCents)}
                disabled={busy}
                accessibilityRole="button"
                style={[styles.tipButton, { borderColor: c.border, backgroundColor: c.surfaceSunken }]}
              >
                <Text style={{ color: c.textPrimary, fontWeight: '700' }}>{option.label}</Text>
                {option.amountCents > 0 ? (
                  <Text style={[textStyles.caption, { color: c.textTertiary }]}>
                    {displayPrice(option.amountCents)}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ gap: space[3], marginTop: space[2] }}>
        {actions.canApprove ? (
          <Primary label="APPROVE AND PAY" onPress={approve} busy={busy} />
        ) : null}
        {actions.canMakeRecurring ? (
          <Secondary label="Set up regular service" onPress={makeRecurring} busy={busy} />
        ) : null}
        {actions.canReportProblem ? (
          <Secondary label="Something is wrong" onPress={reportProblem} busy={busy} tone="danger" />
        ) : null}
        {actions.canCancel ? (
          <Secondary label="Cancel this job" onPress={() => void cancel()} busy={busy} tone="danger" />
        ) : null}
      </View>
    </ScrollView>
  )
}

function Primary({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={({ pressed }) => [styles.primary, { backgroundColor: pressed ? c.brandHover : c.brand, opacity: busy ? 0.6 : 1 }]}
    >
      {busy
        ? <ActivityIndicator color={c.onBrand} />
        : <Text style={{ color: c.onBrand, fontWeight: '800', fontSize: 15, letterSpacing: 0.3 }}>{label}</Text>}
    </Pressable>
  )
}

function Secondary({ label, onPress, busy, tone }: {
  label: string; onPress: () => void; busy: boolean; tone?: 'danger'
}) {
  const c = useColors()
  const color = tone === 'danger' ? c.danger : c.textPrimary
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.secondary,
        { borderColor: tone === 'danger' ? c.danger : c.border, backgroundColor: pressed ? c.surfaceSunken : 'transparent' },
      ]}
    >
      <Text style={{ color, fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space[5], gap: space[4], paddingBottom: space[10] },
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  workerRow: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  avatar: { width: 46, height: 46, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  photo: { width: 150, height: 112, borderRadius: radius.md },
  stars: { flexDirection: 'row', gap: space[1] },
  star: { minWidth: minTouchTarget, minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center' },
  tipRow: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  tipButton: {
    flexGrow: 1, minWidth: 74, minHeight: minTouchTarget, borderWidth: 1, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[2],
  },
  primary: { minHeight: minTouchTarget + 8, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  secondary: { minHeight: minTouchTarget, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
})
