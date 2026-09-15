import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl,
  Pressable, Alert, Linking,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import type { PayoutReadiness, PayoutRecord } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useColors, space, radius, textStyles } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { displayMoney } from '@/lib/jobs'
import { payoutStateLabel, whyNotPayable, describeArrival } from '@/lib/payouts'

/**
 * Getting the money out.
 *
 * A worker who has finished jobs and cannot reach their money will not do a
 * second week, so this screen has one job: either move the money now, or say in
 * plain words exactly what is standing in the way. "Payouts unavailable" is the
 * answer that loses the worker.
 *
 * Bank and tax details are collected by the payment provider on their own pages.
 * We open a link and never see them, which is deliberate — that data is a
 * liability we have no reason to hold.
 */
export default function PayoutsScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()

  const [status, setStatus] = useState<PayoutReadiness | null>(null)
  const [history, setHistory] = useState<PayoutRecord[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [readiness, past] = await Promise.all([api.payoutStatus(), api.payouts()])
      setStatus(readiness)
      setHistory(past.payouts)
      setError(null)
    } catch {
      setError('Could not load your payout details. Pull to try again.')
    }
  }, [])

  // Re-read on focus, because the interesting moment is coming back from the
  // provider's onboarding pages having just finished them.
  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const onboard = useCallback(async () => {
    setBusy(true)
    try {
      const { url } = await api.startPayoutOnboarding()
      await Linking.openURL(url)
    } catch {
      setError('Could not open payout setup. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }, [])

  const withdraw = useCallback(() => {
    if (!status) return
    const amount = displayMoney(status.availableBalanceCents)

    Alert.alert(
      `Withdraw ${amount}?`,
      'This sends everything available to your bank. It usually lands in two business days.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: `Withdraw ${amount}`,
          onPress: () => {
            void (async () => {
              setBusy(true)
              try {
                const result = await api.withdraw()
                setError(null)
                Alert.alert(
                  'On its way',
                  `${displayMoney(result.amountCents)} is heading to your bank. ${describeArrival(result.arrivalDate)}`,
                )
                await load()
              } catch (e) {
                // The server's message is the useful one — it knows whether this
                // was a closed bank account or a balance that moved underneath.
                setError(e instanceof Error ? e.message : 'That withdrawal did not go through.')
              } finally {
                setBusy(false)
              }
            })()
          },
        },
      ],
    )
  }, [status, load])

  const blocker = status ? whyNotPayable(status) : null

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + space[4],
          paddingBottom: insets.bottom + space[8],
          maxWidth: layout.contentMaxWidth,
          alignSelf: 'center',
          width: '100%',
        },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.brand} />
      }
    >
      <Text style={[textStyles.title, { color: c.textPrimary }]}>Payouts</Text>

      {error ? <Text style={[textStyles.body, { color: c.danger }]}>{error}</Text> : null}

      {status === null ? (
        <ActivityIndicator color={c.brand} style={{ marginTop: space[7] }} />
      ) : (
        <>
          <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[textStyles.overline, { color: c.textTertiary }]}>READY TO WITHDRAW</Text>
            <Text style={[textStyles.displayLarge, { color: c.payout }]}>
              {displayMoney(status.availableBalanceCents)}
            </Text>
            {status.pendingBalanceCents > 0 ? (
              <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                {displayMoney(status.pendingBalanceCents)} still pending — it moves here once each
                customer approves, or automatically if they do not.
              </Text>
            ) : null}
          </View>

          {blocker ? (
            /* The whole point of this screen. Never "unavailable" — always the
               specific thing standing in the way, and the button that fixes it. */
            <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>
                {blocker.heading}
              </Text>
              <Text style={[textStyles.body, { color: c.textPrimary, marginTop: space[2] }]}>
                {blocker.detail}
              </Text>

              {blocker.action === 'onboard' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void onboard()}
                  style={({ pressed }) => [
                    styles.primary,
                    { backgroundColor: c.brand, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
                  ]}
                >
                  <Text style={[textStyles.bodyStrong, { color: c.onBrand }]}>
                    {busy ? 'Opening…' : blocker.actionLabel}
                  </Text>
                </Pressable>
              ) : null}

              {status.requirementsDue.length > 0 ? (
                <Text style={[textStyles.caption, { color: c.textSecondary, marginTop: space[3] }]}>
                  Still needed: {status.requirementsDue.join(', ')}
                </Text>
              ) : null}
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={withdraw}
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: c.brand, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[textStyles.bodyStrong, { color: c.onBrand }]}>
                {busy ? 'Sending…' : `Withdraw ${displayMoney(status.availableBalanceCents)}`}
              </Text>
            </Pressable>
          )}

          <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>PAST PAYOUTS</Text>
            {history.length === 0 ? (
              <Text style={[textStyles.caption, { color: c.textSecondary, marginTop: space[2] }]}>
                Nothing yet. Your first withdrawal will show up here with the date it landed.
              </Text>
            ) : (
              history.map((p) => (
                <View key={p.id} style={[styles.row, { borderTopColor: c.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
                      {displayMoney(p.amountCents)}
                    </Text>
                    <Text style={[textStyles.caption, { color: c.textSecondary }]}>
                      {p.failureMessage ?? describeArrival(p.arrivalDate)}
                    </Text>
                  </View>
                  <Text
                    style={[
                      textStyles.caption,
                      { color: p.status === 'FAILED' ? c.danger : c.textSecondary },
                    ]}
                  >
                    {payoutStateLabel(p.status)}
                  </Text>
                </View>
              ))
            )}
          </View>

          <Text style={[textStyles.caption, { color: c.textTertiary, marginTop: space[3] }]}>
            Bank details are held by our payment provider, not by GrassAssassin.
          </Text>
        </>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[5], gap: space[4] },
  hero: { borderRadius: radius.lg, borderWidth: 1, padding: space[5], gap: space[1] },
  panel: { borderRadius: radius.lg, borderWidth: 1, padding: space[5], gap: space[1] },
  primary: {
    borderRadius: radius.md,
    paddingVertical: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space[3],
    // 48pt tall at minimum: a payout button missed by a thumb in work gloves is
    // a support ticket.
    minHeight: 48,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingTop: space[3],
    marginTop: space[3],
    borderTopWidth: 1,
  },
})
