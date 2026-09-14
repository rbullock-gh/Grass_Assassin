import { useCallback, useState } from 'react'
import {
  View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import type { ConversationSummary } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { messageTimestamp, previewOf } from '@/lib/messages'
import { customerStatus } from '@/lib/customer-jobs'

/**
 * Every conversation, newest first.
 *
 * Sorted by last message rather than by job, because the question this screen
 * answers is "who is waiting on me?" — and a three-week-old thread that just
 * got a reply is more urgent than today's job that nobody has written in.
 */
export default function ConversationsScreen() {
  const c = useColors()
  const layout = useLayout()
  const insets = useSafeAreaInsets()
  const { user } = useAuth()

  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.conversations()
      setConversations(result.conversations)
      setError(null)
    } catch {
      setError('Could not load your messages. Pull to try again.')
    }
  }, [])

  // On focus, not just on mount: coming back from a thread must clear its
  // unread badge rather than leaving a count that is already wrong.
  useFocusEffect(useCallback(() => { void load() }, [load]))

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  if (conversations === null) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.brand} />
      </View>
    )
  }

  return (
    <FlatList
      style={{ backgroundColor: c.background }}
      data={conversations}
      keyExtractor={(conversation) => conversation.id}
      contentContainerStyle={[
        styles.list,
        {
          paddingBottom: insets.bottom + space[6],
          maxWidth: layout.contentMaxWidth,
          alignSelf: 'center',
          width: '100%',
        },
      ]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.brand} />}
      ItemSeparatorComponent={() => <View style={[styles.rule, { backgroundColor: c.border }]} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>
            {error ?? 'No conversations yet. A thread opens as soon as a job is claimed.'}
          </Text>
        </View>
      }
      renderItem={({ item }) => <Row conversation={item} viewerId={user?.id ?? null} />}
    />
  )
}

function Row({ conversation, viewerId }: { conversation: ConversationSummary; viewerId: string | null }) {
  const c = useColors()
  const unread = conversation.unreadCount > 0
  const status = customerStatus(conversation.job.status)

  return (
    <Pressable
      onPress={() => router.push(`/(shared)/messages/${conversation.jobId}`)}
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? `${conversation.job.title}, ${conversation.unreadCount} unread`
          : conversation.job.title
      }
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surfaceSunken : 'transparent' }]}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.titleRow}>
          <Text
            style={[
              textStyles.bodyStrong,
              { color: c.textPrimary, flex: 1, fontWeight: unread ? '800' : '600' },
            ]}
            numberOfLines={1}
          >
            {conversation.job.category?.name ?? conversation.job.title}
          </Text>
          {conversation.lastMessageAt ? (
            <Text style={[textStyles.caption, { color: unread ? c.brand : c.textTertiary }]}>
              {messageTimestamp(conversation.lastMessageAt)}
            </Text>
          ) : null}
        </View>

        <Text
          style={[
            textStyles.body,
            { color: unread ? c.textPrimary : c.textSecondary, fontWeight: unread ? '600' : '400' },
          ]}
          numberOfLines={1}
        >
          {previewOf(conversation.lastMessage, viewerId)}
        </Text>

        <Text style={[textStyles.caption, { color: c.textTertiary }]} numberOfLines={1}>
          {conversation.open ? status.label : 'Conversation closed'}
        </Text>
      </View>

      {unread ? (
        <View style={[styles.badge, { backgroundColor: c.brand }]}>
          <Text style={{ color: c.onBrand, fontSize: 11.5, fontWeight: '800' }}>
            {conversation.unreadCount > 9 ? '9+' : conversation.unreadCount}
          </Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flexGrow: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space[3],
    paddingHorizontal: space[5], paddingVertical: space[3], minHeight: minTouchTarget + 20,
  },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: space[5] },
  badge: {
    minWidth: 22, height: 22, borderRadius: radius.full,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  empty: { flex: 1, justifyContent: 'center', padding: space[8] },
})
