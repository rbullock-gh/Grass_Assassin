import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl, Pressable,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import type { SavedCard } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useColors, space, radius, textStyles } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { describeCard, cardNeedsAttention } from '@/lib/cards'

/**
 * How a customer pays.
 *
 * No card number is typed on this screen, and that is the design rather than a
 * gap. The API hands back a short-lived secret, the payment provider's own SDK
 * collects the card against it, and the number goes device-to-provider without
 * passing through us. A field here would put card data in our process, our logs
 * and our crash reports, which is a liability with no upside.
 *
 * What this screen owns is the choice: which saved card gets charged next, shown
 * before the job is posted rather than discovered when a charge fails.
 */
export default function PaymentMethodsScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()

  const [cards, setCards] = useState<SavedCard[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const saved = await api.paymentMethods()
      setCards(saved.methods)
      setError(null)
    } catch {
      setError('Could not load your cards. Pull to try again.')
    }
  }, [])

  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const choose = useCallback(async (card: SavedCard) => {
    if (card.isDefault) return
    setBusy(card.id)
    // Move it immediately — the request is fast and reliable, and a radio button
    // that waits on a round trip feels broken. Reverted below if it fails.
    const previous = cards
    setCards((current) =>
      current?.map((m) => ({ ...m, isDefault: m.id === card.id })) ?? current)
    try {
      await api.setDefaultCard(card.id)
      setError(null)
    } catch {
      setCards(previous ?? null)
      setError('Could not switch cards. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }, [cards])

  const addCard = useCallback(async () => {
    setBusy('new')
    try {
      /*
       * The handoff.
       *
       * startCardSetup returns the client secret that the payment provider's
       * React Native SDK exchanges for a saved card. That SDK is a native module
       * and needs real provider credentials to do anything, neither of which
       * exist in this environment — so rather than ship a card form that cannot
       * work, this asks for the secret and reports honestly when there is
       * nowhere to hand it.
       */
      await api.startCardSetup()
      setError(
        'Card entry needs the payment provider’s SDK, which is not configured in this build. ' +
        'The secure setup request itself succeeded.',
      )
    } catch {
      setError('Could not start adding a card. Try again in a moment.')
    } finally {
      setBusy(null)
    }
  }, [])

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
      <Text style={[textStyles.title, { color: c.textPrimary }]}>How you pay</Text>

      {error ? <Text style={[textStyles.body, { color: c.dangerInk }]}>{error}</Text> : null}

      {cards === null ? (
        <ActivityIndicator color={c.brand} style={{ marginTop: space[7] }} />
      ) : cards.length === 0 ? (
        <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>No card yet</Text>
          <Text style={[textStyles.caption, { color: c.textSecondary, marginTop: space[1] }]}>
            Add one before posting a job. You are not charged until a pro claims the work.
          </Text>
        </View>
      ) : (
        cards.map((card) => {
          const attention = cardNeedsAttention(card)
          return (
            <Pressable
              key={card.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: card.isDefault, disabled: busy !== null }}
              accessibilityLabel={`${describeCard(card)}${card.isDefault ? ', currently used' : ''}`}
              disabled={busy !== null}
              onPress={() => void choose(card)}
              style={({ pressed }) => [
                styles.card,
                {
                  backgroundColor: c.surface,
                  borderColor: card.isDefault ? c.brand : c.border,
                  borderWidth: card.isDefault ? 2 : 1,
                  opacity: pressed ? 0.9 : 1,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[textStyles.bodyStrong, { color: c.textPrimary }]}>
                  {describeCard(card)}
                </Text>
                {attention ? (
                  <Text style={[textStyles.caption, { color: c.dangerInk, marginTop: 2 }]}>
                    {attention}
                  </Text>
                ) : card.isDefault ? (
                  <Text style={[textStyles.caption, { color: c.textSecondary, marginTop: 2 }]}>
                    Charged for your next job
                  </Text>
                ) : null}
              </View>
              {busy === card.id ? (
                <ActivityIndicator color={c.brand} />
              ) : card.isDefault ? (
                <Text style={[textStyles.captionStrong, { color: c.brand }]}>USING</Text>
              ) : null}
            </Pressable>
          )
        })
      )}

      <Pressable
        accessibilityRole="button"
        disabled={busy !== null}
        onPress={() => void addCard()}
        style={({ pressed }) => [
          styles.primary,
          { backgroundColor: c.brand, opacity: busy === 'new' ? 0.6 : pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={[textStyles.bodyStrong, { color: c.onBrand }]}>
          {busy === 'new' ? 'Opening…' : 'Add a card'}
        </Text>
      </Pressable>

      <Text style={[textStyles.caption, { color: c.textTertiary, marginTop: space[3] }]}>
        Card details are held by our payment provider. GrassAssassin never sees or stores your
        card number.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space[5], gap: space[3] },
  panel: { borderRadius: radius.lg, borderWidth: 1, padding: space[5] },
  card: {
    borderRadius: radius.lg,
    padding: space[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 64,
  },
  primary: {
    borderRadius: radius.md,
    paddingVertical: space[4],
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space[3],
    minHeight: 48,
  },
})
