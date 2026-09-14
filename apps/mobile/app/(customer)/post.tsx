import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { Category, PropertySummary, PriceGuidance } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import {
  POST_STEPS, EMPTY_DRAFT, validateStep, nextStep, previousStep, canPublish,
  availablePresets, upcomingDays, formatDayLabel, priceFeedback, suggestedStartingPrice, costBreakdown,
  YARD_SIZE_LABELS, type PostDraft, type PostStep, type YardSize,
} from '@/lib/post-flow'

/**
 * Post a job — five steps, one question each.
 *
 * The highest-drop-off funnel in the product, so every step is a single
 * decision and nothing asks for money until the customer is already invested.
 * Progress is five dots rather than a percentage: a percentage invites "how
 * much is left" anxiety, which is the opposite of what we want here.
 */

const MIN_PRICE_CENTS = 2500
const SERVICE_FEE_BPS = 800
const SERVICE_FEE_MIN_CENTS = 299

export default function PostJobScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()

  const [step, setStep] = useState<PostStep>('WHAT')
  const [draft, setDraft] = useState<PostDraft>(EMPTY_DRAFT)
  const [showErrors, setShowErrors] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [properties, setProperties] = useState<PropertySummary[]>([])
  const [guidance, setGuidance] = useState<PriceGuidance | null>(null)
  const [publishing, setPublishing] = useState(false)

  useEffect(() => {
    void Promise.all([api.categories(), api.properties()])
      .then(([categoryResult, propertyResult]) => {
        setCategories(categoryResult.categories)
        setProperties(propertyResult.properties)
        // One property is the common case; pre-selecting removes a whole step
        // for most customers.
        if (propertyResult.properties.length === 1) {
          setDraft((current) => ({ ...current, propertyId: propertyResult.properties[0]!.id }))
        }
      })
      .catch(() => Alert.alert('Could not load', 'Check your connection and try again.'))
  }, [])

  // Guidance depends on both category and yard size, so it refreshes when
  // either changes rather than only once.
  useEffect(() => {
    if (!draft.categoryId) return
    void api.priceGuidance(draft.categoryId, draft.yardSize ?? undefined)
      .then((result) => {
        setGuidance(result)
        setDraft((current) =>
          current.priceCents === null
            ? { ...current, priceCents: suggestedStartingPrice(result) }
            : current)
      })
      .catch(() => undefined)
  }, [draft.categoryId, draft.yardSize])

  const patch = useCallback((changes: Partial<PostDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    setShowErrors(false)
  }, [])

  const validation = validateStep(step, draft, MIN_PRICE_CENTS)

  const advance = useCallback(() => {
    if (!validation.complete) { setShowErrors(true); return }
    const next = nextStep(step)
    if (next) { setStep(next); setShowErrors(false) }
  }, [step, validation.complete])

  const goBack = useCallback(() => {
    const back = previousStep(step)
    if (back) { setStep(back); setShowErrors(false) }
    else router.back()
  }, [step])

  const publish = useCallback(async () => {
    if (!canPublish(draft, MIN_PRICE_CENTS)) { setShowErrors(true); return }
    setPublishing(true)
    try {
      const job = await api.createJob({
        propertyId: draft.propertyId!,
        categoryId: draft.categoryId!,
        priceCents: draft.priceCents!,
        dueAt: draft.dueAt!.toISOString(),
        description: draft.description || undefined,
        specialInstructions: draft.specialInstructions || undefined,
        yardSize: draft.yardSize ?? undefined,
        equipmentProvided: draft.equipmentProvided,
        photoIds: draft.photoIds,
      })
      router.replace(`/(customer)/jobs/${job.id}`)
    } catch (error) {
      Alert.alert(
        'Could not post your job',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      setPublishing(false)
    }
  }, [draft])

  const isLast = step === 'PRICE'

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: c.background, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Go back" style={styles.backButton}>
          <Text style={{ color: c.textSecondary, fontSize: 15 }}>Back</Text>
        </Pressable>
        <Dots step={step} />
        <View style={styles.backButton} />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: space[6], maxWidth: layout.isMultiPane ? 620 : undefined, alignSelf: 'center', width: '100%' },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {step === 'WHAT' ? (
          <WhatStep
            categories={categories}
            draft={draft}
            onChange={patch}
          />
        ) : null}

        {step === 'WHERE' ? (
          <WhereStep properties={properties} draft={draft} onChange={patch} />
        ) : null}

        {step === 'WHEN' ? <WhenStep draft={draft} onChange={patch} /> : null}

        {step === 'HOW' ? <HowStep draft={draft} onChange={patch} /> : null}

        {step === 'PRICE' ? (
          <PriceStep draft={draft} guidance={guidance} onChange={patch} />
        ) : null}

        {showErrors && validation.message ? (
          <Text style={[styles.error, { color: c.danger }]}>{validation.message}</Text>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: c.border, paddingBottom: insets.bottom + space[3] }]}>
        <Pressable
          onPress={isLast ? () => void publish() : advance}
          disabled={publishing}
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
          {publishing ? (
            <ActivityIndicator color={c.onBrand} />
          ) : (
            <Text
              style={{
                // textSecondary, not textTertiary: this button is TAPPABLE
                // when the step is incomplete — tapping it is how the customer
                // finds out what is missing — so its label is active text and
                // owes the full 4.5:1. Tertiary on the sunken surface is 2.86.
                color: validation.complete ? c.onBrand : c.textSecondary,
                fontWeight: '800', fontSize: 15, letterSpacing: 0.3,
              }}
            >
              {isLast ? 'REVIEW & PUBLISH' : 'CONTINUE'}
            </Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

/** Five dots, not a percentage bar. */
function Dots({ step }: { step: PostStep }) {
  const c = useColors()
  const index = POST_STEPS.indexOf(step)
  return (
    <View style={styles.dots} accessibilityLabel={`Step ${index + 1} of ${POST_STEPS.length}`}>
      {POST_STEPS.map((key, i) => (
        <View
          key={key}
          style={[
            styles.dot,
            {
              backgroundColor: i <= index ? c.brand : c.borderStrong,
              width: i === index ? 20 : 7,
            },
          ]}
        />
      ))}
    </View>
  )
}

function StepHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  const c = useColors()
  return (
    <View style={{ gap: space[1], marginBottom: space[4] }}>
      <Text style={[textStyles.title, { color: c.textPrimary }]}>{title}</Text>
      {subtitle ? <Text style={[textStyles.body, { color: c.textSecondary }]}>{subtitle}</Text> : null}
    </View>
  )
}

function WhatStep({ categories, draft, onChange }: {
  categories: Category[]
  draft: PostDraft
  onChange: (changes: Partial<PostDraft>) => void
}) {
  const c = useColors()
  return (
    <>
      <StepHeading title="What do you need done?" />
      <View style={styles.grid}>
        {categories.map((category) => {
          const selected = draft.categoryId === category.id
          return (
            <Pressable
              key={category.id}
              onPress={() => onChange({ categoryId: category.id })}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.tile,
                {
                  backgroundColor: selected ? c.brandSubtle : c.surface,
                  borderColor: selected ? c.brand : c.border,
                  borderWidth: selected ? 2 : 1,
                },
              ]}
            >
              <Text
                style={[
                  textStyles.bodyStrong,
                  { color: selected ? c.brand : c.textPrimary, textAlign: 'center' },
                ]}
              >
                {category.name}
              </Text>
              <Text style={[textStyles.caption, { color: c.textTertiary }]}>
                ${Math.round(category.typicalLowCents / 100)}–{Math.round(category.typicalHighCents / 100)}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <Field
        label="Anything we should know?"
        placeholder="Front and back, please avoid the rose bed."
        value={draft.description}
        onChangeText={(description) => onChange({ description })}
        multiline
      />
    </>
  )
}

function WhereStep({ properties, draft, onChange }: {
  properties: PropertySummary[]
  draft: PostDraft
  onChange: (changes: Partial<PostDraft>) => void
}) {
  const c = useColors()
  return (
    <>
      <StepHeading title="Where is it?" />
      {properties.length === 0 ? (
        <Pressable
          onPress={() => router.push('/(customer)/properties/new')}
          style={[styles.row, { borderColor: c.brand, backgroundColor: c.brandSubtle }]}
        >
          <Text style={[textStyles.bodyStrong, { color: c.brand }]}>Add your property</Text>
        </Pressable>
      ) : null}

      {properties.map((property) => {
        const selected = draft.propertyId === property.id
        return (
          <Pressable
            key={property.id}
            onPress={() => onChange({
              propertyId: property.id,
              // Default the yard size from the property so the HOW step is
              // already answered for most people.
              yardSize: (draft.yardSize ?? property.yardSize) as YardSize,
            })}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
              styles.row,
              {
                backgroundColor: selected ? c.brandSubtle : c.surface,
                borderColor: selected ? c.brand : c.border,
                borderWidth: selected ? 2 : 1,
              },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>{property.label}</Text>
              <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                {property.addressLine1}, {property.city}
              </Text>
            </View>
          </Pressable>
        )
      })}
    </>
  )
}

function WhenStep({ draft, onChange }: {
  draft: PostDraft
  onChange: (changes: Partial<PostDraft>) => void
}) {
  const c = useColors()
  const presets = useMemo(() => availablePresets(new Date()), [])
  const [pickingDate, setPickingDate] = useState(false)
  const days = useMemo(() => upcomingDays(new Date()), [])

  return (
    <>
      <StepHeading title="When do you need it by?" subtitle="Pros will finish any time before this." />
      {presets.map((preset) => {
        const resolved = preset.resolve?.(new Date()) ?? null
        const selected = resolved !== null && draft.dueAt?.getTime() === resolved.getTime()
        return (
          <Pressable
            key={preset.key}
            onPress={() => {
              // Expanded in place rather than pushed as its own screen: leaving
              // the wizard to answer one question is how half-filled drafts get
              // lost.
              if (resolved) { onChange({ dueAt: resolved }); setPickingDate(false) }
              else setPickingDate((open) => !open)
            }}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
              styles.row,
              {
                backgroundColor: selected ? c.brandSubtle : c.surface,
                borderColor: selected ? c.brand : c.border,
                borderWidth: selected ? 2 : 1,
              },
            ]}
          >
            <Text style={[textStyles.bodyStrong, { color: selected ? c.brand : c.textPrimary }]}>
              {preset.label}
            </Text>
            {resolved ? (
              <Text style={[textStyles.caption, { color: c.textTertiary }]}>
                by {resolved.toLocaleTimeString('en-US', { hour: 'numeric' })}
              </Text>
            ) : null}
          </Pressable>
        )
      })}

      {pickingDate ? (
        <View style={{ gap: space[2] }}>
          {days.map((day) => {
            const selected = draft.dueAt?.getTime() === day.getTime()
            return (
              <Pressable
                key={day.toISOString()}
                onPress={() => onChange({ dueAt: day })}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.row,
                  {
                    backgroundColor: selected ? c.brandSubtle : c.surface,
                    borderColor: selected ? c.brand : c.border,
                    borderWidth: selected ? 2 : 1,
                  },
                ]}
              >
                <Text style={[textStyles.bodyStrong, { color: selected ? c.brand : c.textPrimary }]}>
                  {formatDayLabel(day)}
                </Text>
                <Text style={[textStyles.caption, { color: c.textTertiary }]}>
                  by {day.toLocaleTimeString('en-US', { hour: 'numeric' })}
                </Text>
              </Pressable>
            )
          })}
        </View>
      ) : null}
    </>
  )
}

function HowStep({ draft, onChange }: {
  draft: PostDraft
  onChange: (changes: Partial<PostDraft>) => void
}) {
  const c = useColors()
  return (
    <>
      <StepHeading title="A few details" subtitle="All optional — skip anything that doesn't apply." />

      <Text style={[styles.label, { color: c.textSecondary }]}>Yard size</Text>
      <View style={styles.chips}>
        {(Object.keys(YARD_SIZE_LABELS) as YardSize[]).map((size) => {
          const selected = draft.yardSize === size
          return (
            <Pressable
              key={size}
              onPress={() => onChange({ yardSize: size })}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.chip,
                {
                  backgroundColor: selected ? c.brand : c.surface,
                  borderColor: selected ? c.brand : c.border,
                },
              ]}
            >
              <Text style={{ color: selected ? c.onBrand : c.textSecondary, fontSize: 13, fontWeight: '600' }}>
                {YARD_SIZE_LABELS[size]}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <Pressable
        onPress={() => onChange({ equipmentProvided: !draft.equipmentProvided })}
        accessibilityRole="switch"
        accessibilityState={{ checked: draft.equipmentProvided }}
        style={[styles.row, { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>I'll provide equipment</Text>
          <Text style={[textStyles.caption, { color: c.textSecondary }]}>
            Otherwise pros bring their own — most do.
          </Text>
        </View>
        <View
          style={[
            styles.toggle,
            { backgroundColor: draft.equipmentProvided ? c.brand : c.surfaceSunken },
          ]}
        >
          <View
            style={[
              styles.knob,
              { backgroundColor: c.surface, marginLeft: draft.equipmentProvided ? 20 : 2 },
            ]}
          />
        </View>
      </Pressable>

      <Field
        label="Special instructions"
        placeholder="Gate code 4412. Dog is friendly. Please don't touch the roses."
        value={draft.specialInstructions}
        onChangeText={(specialInstructions) => onChange({ specialInstructions })}
        multiline
      />
      <Text style={[textStyles.caption, { color: c.textTertiary }]}>
        Only shared with the pro after they accept the job.
      </Text>
    </>
  )
}

function PriceStep({ draft, guidance, onChange }: {
  draft: PostDraft
  guidance: PriceGuidance | null
  onChange: (changes: Partial<PostDraft>) => void
}) {
  const c = useColors()
  const price = draft.priceCents ?? 0
  const feedback = guidance ? priceFeedback(price, guidance) : null
  const cost = costBreakdown(price, SERVICE_FEE_BPS, SERVICE_FEE_MIN_CENTS)

  const toneColor = feedback?.tone === 'good' ? c.success
    : feedback?.tone === 'fair' ? c.warning
    : c.danger

  return (
    <>
      <StepHeading title="What will you pay?" subtitle="You set the price. Pros choose whether to take it." />

      <View style={[styles.priceBox, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.currency, { color: c.textSecondary }]}>$</Text>
        <TextInput
          value={price > 0 ? String(Math.round(price / 100)) : ''}
          onChangeText={(text) => {
            const dollars = Number(text.replace(/[^0-9]/g, ''))
            onChange({ priceCents: Number.isFinite(dollars) ? dollars * 100 : null })
          }}
          keyboardType="number-pad"
          accessibilityLabel="Job price in dollars"
          placeholder="0"
          placeholderTextColor={c.textTertiary}
          style={[styles.priceInput, { color: c.textPrimary }]}
        />
      </View>

      {guidance ? (
        <Text style={[textStyles.caption, { color: c.textSecondary, textAlign: 'center' }]}>
          Jobs like this usually claim at ${Math.round(guidance.suggestedLowCents / 100)}–
          ${Math.round(guidance.suggestedHighCents / 100)}
        </Text>
      ) : null}

      {feedback ? (
        <View style={[styles.feedback, { backgroundColor: c.surface, borderLeftColor: toneColor }]}>
          <View style={[styles.meterTrack, { backgroundColor: c.surfaceSunken }]}>
            <View
              style={[
                styles.meterFill,
                { backgroundColor: toneColor, width: `${Math.round(feedback.claimLikelihood * 100)}%` },
              ]}
            />
          </View>
          <Text style={[textStyles.caption, { color: c.textPrimary }]}>{feedback.message}</Text>
        </View>
      ) : null}

      <View style={[styles.breakdown, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Line label="Job price" value={cost.jobPriceCents} />
        <Line label="Service fee" value={cost.serviceFeeCents} />
        <View style={[styles.divider, { backgroundColor: c.border }]} />
        <Line label="Total" value={cost.totalCents} strong />
        <Text style={[textStyles.caption, { color: c.textTertiary, marginTop: space[1] }]}>
          You're charged when a pro accepts. If nobody takes it, you pay nothing.
        </Text>
      </View>
    </>
  )
}

function Line({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  const c = useColors()
  return (
    <View style={styles.lineRow}>
      <Text style={[strong ? textStyles.bodyStrong : textStyles.body, { color: strong ? c.textPrimary : c.textSecondary }]}>
        {label}
      </Text>
      <Text
        style={[
          strong ? textStyles.bodyStrong : textStyles.body,
          { color: c.textPrimary, fontVariant: ['tabular-nums'] },
        ]}
      >
        ${(value / 100).toFixed(2)}
      </Text>
    </View>
  )
}

function Field({ label, ...props }: {
  label: string
  placeholder: string
  value: string
  onChangeText: (text: string) => void
  multiline?: boolean
}) {
  const c = useColors()
  return (
    <View style={{ gap: space[1], marginTop: space[3] }}>
      <Text style={[styles.label, { color: c.textSecondary }]}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={c.textTertiary}
        style={[
          styles.input,
          {
            backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary,
            minHeight: props.multiline ? 88 : minTouchTarget,
            textAlignVertical: props.multiline ? 'top' : 'center',
          },
        ]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space[4], paddingVertical: space[2],
  },
  backButton: { minWidth: 56, minHeight: minTouchTarget, justifyContent: 'center' },
  dots: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  dot: { height: 7, borderRadius: 999 },
  content: { padding: space[4], gap: space[2] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  tile: {
    flexBasis: '47%', flexGrow: 1, minHeight: 82, borderRadius: radius.lg,
    alignItems: 'center', justifyContent: 'center', padding: space[3], gap: 3,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space[3],
    minHeight: minTouchTarget + 12, paddingHorizontal: space[4], paddingVertical: space[3],
    borderRadius: radius.lg, marginBottom: space[2],
  },
  label: { fontSize: 12.5, fontWeight: '700', letterSpacing: 0.3 },
  input: { borderWidth: 1, borderRadius: radius.md, padding: space[3], fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginBottom: space[3] },
  chip: { paddingHorizontal: space[3], paddingVertical: 9, borderRadius: radius.full, borderWidth: 1 },
  toggle: { width: 44, height: 26, borderRadius: 999, justifyContent: 'center' },
  knob: { width: 22, height: 22, borderRadius: 11 },
  priceBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: radius.xl, paddingVertical: space[5], gap: space[1],
  },
  currency: { fontSize: 28, fontWeight: '700' },
  priceInput: {
    fontSize: 48, fontWeight: '800', letterSpacing: -1.5,
    minWidth: 120, textAlign: 'center', fontVariant: ['tabular-nums'],
  },
  feedback: {
    borderLeftWidth: 3, borderRadius: radius.md, padding: space[3],
    gap: space[2], marginTop: space[2],
  },
  meterTrack: { height: 5, borderRadius: 999, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 999 },
  breakdown: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], marginTop: space[3], gap: space[1] },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  divider: { height: 1, marginVertical: space[2] },
  error: { fontSize: 14, fontWeight: '600', marginTop: space[2] },
  footer: { borderTopWidth: 1, paddingHorizontal: space[4], paddingTop: space[3] },
  primary: {
    minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
})
