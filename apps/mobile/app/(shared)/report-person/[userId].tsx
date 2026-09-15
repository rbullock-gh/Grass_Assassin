import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, Switch,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import type { ReportCategory } from '@grassassassin/shared'
import { api } from '@/lib/api'
import { showAlert } from '@/lib/dialog'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { reportOptions, whyCannotReport, blockConsequences } from '@/lib/safety'

/**
 * Reporting a PERSON, which is not the same as disputing a job.
 *
 * The existing report screen is about work and money: the lawn was half cut,
 * hold the payment. This one is about somebody's conduct, and it goes to a
 * different queue with different consequences. Keeping them apart matters —
 * a customer who was frightened by someone should not have to file a billing
 * dispute to say so, and a reviewer should not have to guess which of the two
 * they are reading.
 *
 * Blocking is on by default and stated plainly rather than buried, because the
 * person filling this in usually wants both and should not have to know that
 * they are separate things.
 */
export default function ReportPersonScreen() {
  const { userId, name, jobId } = useLocalSearchParams<{
    userId: string; name?: string; jobId?: string
  }>()
  const c = useColors()
  const layout = useLayout()
  const { user } = useAuth()

  const [category, setCategory] = useState<ReportCategory | null>(null)
  const [description, setDescription] = useState('')
  const [alsoBlock, setAlsoBlock] = useState(true)
  const [showError, setShowError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const blocker = whyCannotReport(category, description)
  const role = user?.roles?.includes('WORKER') ? 'worker' : 'customer'
  const them = name?.trim() ? name.trim() : 'this person'

  const submit = useCallback(async () => {
    if (!userId || blocker) { setShowError(true); return }
    setSubmitting(true)
    try {
      const result = await api.report({
        subjectUserId: userId,
        category: category!,
        description: description.trim(),
        alsoBlock,
        ...(jobId ? { jobId } : {}),
      })
      showAlert('Thank you', result.message, [{ text: 'OK', onPress: () => router.back() }])
    } catch (error) {
      showAlert(
        'Could not send that',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }, [userId, category, description, alsoBlock, jobId, blocker])

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
        <Text style={[textStyles.title, { color: c.textPrimary }]}>Report {them}</Text>
        <Text style={[textStyles.body, { color: c.textSecondary }]}>
          A person on our team reads every report. {them} is never told who reported them, and
          nothing happens to their account until somebody has read what you write.
        </Text>

        {/* If somebody is in danger right now, an app queue is the wrong tool
            and saying so is more useful than any form. */}
        <View style={[styles.urgent, { backgroundColor: c.dangerSubtle }]}>
          <Text style={[textStyles.captionStrong, { color: c.dangerInk }]}>
            IF SOMEONE IS IN IMMEDIATE DANGER, CALL EMERGENCY SERVICES FIRST.
          </Text>
        </View>

        <View style={{ gap: space[2], marginTop: space[4] }}>
          {reportOptions().map((option) => {
            const selected = category === option.value
            return (
              <Pressable
                key={option.value}
                onPress={() => { setCategory(option.value); setShowError(false) }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={[
                  styles.option,
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
                <Text style={[textStyles.caption, { color: c.textSecondary }]}>{option.detail}</Text>
              </Pressable>
            )
          })}
        </View>

        <View style={{ gap: space[1], marginTop: space[5] }}>
          <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>WHAT HAPPENED</Text>
          <TextInput
            value={description}
            onChangeText={(text) => { setDescription(text); setShowError(false) }}
            placeholder="He arrived, started shouting about the price, and would not leave when I asked."
            placeholderTextColor={c.textTertiary}
            multiline
            maxLength={2000}
            accessibilityLabel="What happened"
            style={[
              styles.input,
              { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary },
            ]}
          />
          <Text style={[textStyles.caption, { color: c.textTertiary }]}>
            What happened, when, and where. Specific is what lets somebody act on it.
          </Text>
        </View>

        {/*
          * The whole row toggles, not just the switch.
          *
          * A Switch renders about 40×20px, well under the minimum, and this is
          * a screen somebody uses one-handed while upset. The Pressable gives
          * the real target; the Switch stays because it is what reads as a
          * toggle, and it is marked none so it is announced once, not twice.
          */}
        <Pressable
          onPress={() => setAlsoBlock((on) => !on)}
          accessibilityRole="switch"
          accessibilityState={{ checked: alsoBlock }}
          accessibilityLabel="Also stop matching us"
          style={[styles.blockRow, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
              Also stop matching us
            </Text>
            {blockConsequences(role).map((line) => (
              <Text key={line} style={[textStyles.caption, { color: c.textSecondary }]}>
                • {line}
              </Text>
            ))}
          </View>
          {/*
            * Decorative here: the Pressable above carries the role, the label
            * and the state. aria-hidden as well as the native props, because
            * React Native Web renders this as a real checkbox and the native
            * ones do not reach it — which left a 40×20px unnamed control in
            * the page for a screen reader to trip over.
            */}
          <Switch
            value={alsoBlock}
            onValueChange={setAlsoBlock}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            tabIndex={-1}
            trackColor={{ true: c.brand, false: c.borderStrong }}
          />
        </Pressable>

        {showError && blocker ? (
          <Text style={[textStyles.body, { color: c.dangerInk, marginTop: space[3] }]}>{blocker}</Text>
        ) : null}

        <Pressable
          onPress={() => void submit()}
          disabled={submitting}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.submit,
            { backgroundColor: blocker ? c.surfaceSunken : (pressed ? c.brandHover : c.brand) },
          ]}
        >
          {submitting ? <ActivityIndicator color={c.onBrand} /> : (
            <Text style={{
              color: blocker ? c.textSecondary : c.onBrand, fontWeight: '800', fontSize: 15,
            }}>
              SEND REPORT
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
  urgent: { marginTop: space[4], padding: space[3], borderRadius: radius.md },
  option: { borderRadius: radius.md, padding: space[4], gap: 3 },
  input: {
    borderWidth: 1, borderRadius: radius.md, padding: space[3],
    minHeight: 110, textAlignVertical: 'top', fontSize: 15, lineHeight: 21,
  },
  blockRow: {
    marginTop: space[5], flexDirection: 'row', alignItems: 'center', gap: space[3],
    padding: space[4], borderRadius: radius.md, borderWidth: 1,
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
