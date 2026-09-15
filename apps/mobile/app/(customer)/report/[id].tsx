import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import {
  DISPUTE_REASONS, validateDispute, MAX_DISPUTE_DESCRIPTION, type DisputeReason,
} from '@grassassassin/shared'
import { api } from '@/lib/api'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'

/**
 * Reporting a problem.
 *
 * A screen rather than a confirm dialog, because what it collects is the whole
 * case. Before this, "Something is wrong" moved the job to DISPUTED and wrote
 * nothing down — the customer's money and the worker's were both held over a
 * complaint nobody had recorded.
 *
 * It is also deliberately calm. A customer here is already annoyed, and a form
 * that feels like an accusation produces a chargeback instead of a report; one
 * that explains what happens next produces a case an admin can settle.
 */
export default function ReportProblemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const c = useColors()
  const layout = useLayout()

  const [reason, setReason] = useState<DisputeReason | null>(null)
  const [description, setDescription] = useState('')
  const [showError, setShowError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const validation = validateDispute({ reason: reason ?? '', description })

  const submit = useCallback(async () => {
    if (!id || !validation.ok) { setShowError(true); return }
    setSubmitting(true)
    try {
      const result = await api.disputeJob(id, { reason: reason!, description: description.trim() })
      Alert.alert(
        'Reported',
        // The server writes this, so the urgent path says so rather than
        // giving everyone the same reassurance.
        result.message,
        [{ text: 'OK', onPress: () => router.replace(`/(customer)/jobs/${id}`) }],
      )
    } catch (error) {
      Alert.alert('Could not report', error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [id, reason, description, validation.ok])

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
        <Text style={[textStyles.title, { color: c.textPrimary }]}>What went wrong?</Text>
        <Text style={[textStyles.body, { color: c.textSecondary }]}>
          Your payment is held while a person looks at this. Nothing is charged to your pro
          automatically, and nothing happens to their account until someone has read what you write.
        </Text>

        <View style={{ gap: space[2], marginTop: space[4] }}>
          {DISPUTE_REASONS.map((option) => {
            const selected = reason === option.key
            return (
              <Pressable
                key={option.key}
                onPress={() => { setReason(option.key); setShowError(false) }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.reason,
                  {
                    backgroundColor: selected ? c.brandSubtle : c.surface,
                    borderColor: selected ? c.brand : c.border,
                    borderWidth: selected ? 2 : 1,
                  },
                ]}
              >
                <Text style={[textStyles.bodyStrong, { color: selected ? c.brand : c.textPrimary }]}>
                  {option.label}
                </Text>
                <Text style={[textStyles.caption, { color: c.textSecondary }]}>{option.help}</Text>
              </Pressable>
            )
          })}
        </View>

        <View style={{ gap: space[1], marginTop: space[5] }}>
          <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>WHAT HAPPENED</Text>
          <TextInput
            value={description}
            onChangeText={(text) => { setDescription(text); setShowError(false) }}
            placeholder="The back half of the lawn was not cut at all, and the side gate was left open."
            placeholderTextColor={c.textTertiary}
            multiline
            maxLength={MAX_DISPUTE_DESCRIPTION}
            accessibilityLabel="What happened"
            style={[
              styles.input,
              { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary },
            ]}
          />
          <Text style={[textStyles.caption, { color: c.textTertiary }]}>
            A sentence or two is enough. Specific beats angry — it is what lets us settle it quickly.
          </Text>
        </View>

        {showError && validation.error ? (
          <Text style={[textStyles.body, { color: c.dangerInk, marginTop: space[3] }]}>
            {validation.error}
          </Text>
        ) : null}

        <Pressable
          onPress={() => void submit()}
          disabled={submitting}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.submit,
            {
              backgroundColor: validation.ok
                ? (pressed ? c.brandHover : c.brand)
                : c.surfaceSunken,
            },
          ]}
        >
          {submitting ? <ActivityIndicator color={c.onBrand} /> : (
            <Text style={{
              color: validation.ok ? c.onBrand : c.textSecondary,
              fontWeight: '800', fontSize: 15,
            }}>
              SUBMIT REPORT
            </Text>
          )}
        </Pressable>

        <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.cancel}>
          <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Never mind</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  content: { padding: space[5], paddingBottom: space[10] },
  reason: { borderRadius: radius.md, padding: space[4], gap: 3 },
  input: {
    borderWidth: 1, borderRadius: radius.md, padding: space[3],
    minHeight: 110, textAlignVertical: 'top', fontSize: 15, lineHeight: 21,
  },
  submit: {
    marginTop: space[5], minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  cancel: {
    marginTop: space[3], minHeight: minTouchTarget,
    alignItems: 'center', justifyContent: 'center',
  },
})
