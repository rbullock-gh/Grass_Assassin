import { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, StyleSheet, FlatList, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { MAX_MESSAGE_LENGTH } from '@grassassassin/shared'
import type { ChatMessage, MessageThread } from '@grassassassin/client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { useLayout } from '@/lib/use-layout'
import { messageTimestamp, shouldShowTimestamp } from '@/lib/messages'

/**
 * The conversation for one job.
 *
 * This screen is why the product can promise not to expose a phone number. A
 * worker standing at a locked gate needs an answer in the next thirty seconds,
 * and if the app cannot carry that question it has effectively told them to
 * text — which loses the record, the dispute evidence, and the fee.
 *
 * So it is deliberately plain and fast: no typing indicators, no reactions, no
 * read receipts beyond what the server already tracks. Nothing here needs a
 * socket, and a feature that needs a socket is a feature that breaks on a rural
 * signal.
 */
export default function MessagesScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>()
  const c = useColors()
  const layout = useLayout()
  const { user } = useAuth()

  const [thread, setThread] = useState<MessageThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<FlatList<ChatMessage>>(null)

  const load = useCallback(async () => {
    if (!jobId) return
    try {
      setThread(await api.jobMessages(jobId))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this conversation.')
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => { void load() }, [load])

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!jobId || !body || sending) return
    setSending(true)
    // Cleared optimistically. Nothing is more annoying than retyping a message
    // because the network was slow, and the failure path puts it back.
    setDraft('')
    try {
      const result = await api.sendMessage(jobId, body)
      setNotice(result.notice)
      await load()
      listRef.current?.scrollToEnd({ animated: true })
    } catch (caught) {
      setDraft(body)
      setError(caught instanceof Error ? caught.message : 'Could not send. Try again.')
    } finally {
      setSending(false)
    }
  }, [draft, jobId, sending, load])

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.brand} />
      </View>
    )
  }

  if (!thread) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>
          {error ?? 'This conversation is not available.'}
        </Text>
      </View>
    )
  }

  const canSend = draft.trim().length > 0 && !sending

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      {/*
        * Reporting lives in the thread, not only on a profile.
        *
        * The conversation is where somebody is when it goes wrong, and a
        * safety valve two screens away from the moment is a safety valve
        * nobody reaches for.
        */}
      <Pressable
        onPress={() => router.push({
          pathname: '/(shared)/report-person/[userId]',
          params: {
            userId: thread.counterpart.id,
            name: thread.counterpart.firstName,
            jobId,
          },
        })}
        accessibilityRole="button"
        accessibilityLabel={`Report ${thread.counterpart.firstName}`}
        style={[styles.reportBar, { borderBottomColor: c.border }]}
      >
        <Text style={[textStyles.caption, { color: c.textSecondary, fontWeight: '700' }]}>
          Report {thread.counterpart.firstName}
        </Text>
      </Pressable>

      <FlatList
        ref={listRef}
        data={thread.messages}
        keyExtractor={(message) => message.id}
        contentContainerStyle={[
          styles.list,
          { maxWidth: layout.contentMaxWidth, alignSelf: 'center', width: '100%' },
        ]}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[textStyles.body, { color: c.textSecondary, textAlign: 'center' }]}>
              Messages here reach {thread.counterpart.firstName} directly. You never need to
              share a phone number.
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <Bubble
            message={item}
            mine={item.senderId === user?.id}
            showTime={shouldShowTimestamp(thread.messages, index)}
          />
        )}
      />

      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={[styles.notice, { backgroundColor: c.warningSubtle }]}>
          <Text style={{ color: c.warningInk, fontSize: 12.5, fontWeight: '600' }}>{notice}</Text>
        </Pressable>
      ) : null}

      {error ? (
        <View style={[styles.notice, { backgroundColor: c.dangerSubtle }]}>
          <Text style={{ color: c.dangerInk, fontSize: 12.5, fontWeight: '600' }}>{error}</Text>
        </View>
      ) : null}

      {thread.open ? (
        <View style={[styles.composer, { borderTopColor: c.border, backgroundColor: c.surface }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${thread.counterpart.firstName}`}
            // textSecondary, not the usual tertiary: this composer has no
            // visible label, so the placeholder IS the label — it is the only
            // thing naming who the message goes to. Tertiary on the sunken
            // surface is 3.43:1 in light, which is not enough for text carrying
            // that job outdoors.
            placeholderTextColor={c.textSecondary}
            multiline
            maxLength={MAX_MESSAGE_LENGTH}
            accessibilityLabel="Message"
            style={[styles.input, { backgroundColor: c.surfaceSunken, color: c.textPrimary, borderColor: c.border }]}
          />
          <Pressable
            onPress={() => void send()}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            style={[styles.send, { backgroundColor: canSend ? c.brand : c.surfaceSunken }]}
          >
            {sending
              ? <ActivityIndicator color={c.onBrand} size="small" />
              : <Text style={{ color: canSend ? c.onBrand : c.textSecondary, fontWeight: '800', fontSize: 18 }}>↑</Text>}
          </Pressable>
        </View>
      ) : (
        <View style={[styles.closed, { borderTopColor: c.border, backgroundColor: c.surfaceSunken }]}>
          <Text style={[textStyles.caption, { color: c.textSecondary, textAlign: 'center' }]}>
            {thread.closedReason}
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

function Bubble({ message, mine, showTime }: {
  message: ChatMessage
  mine: boolean
  showTime: boolean
}) {
  const c = useColors()

  // System messages are the job's own status updates, rendered inline so the
  // thread reads as one timeline rather than two.
  if (message.kind === 'SYSTEM') {
    return (
      <View style={styles.system}>
        <Text style={[textStyles.caption, { color: c.textTertiary, textAlign: 'center' }]}>
          {message.body}
        </Text>
      </View>
    )
  }

  return (
    <View style={{ gap: space[1] }}>
      {showTime ? (
        <Text style={[textStyles.caption, { color: c.textTertiary, textAlign: 'center' }]}>
          {messageTimestamp(message.createdAt)}
        </Text>
      ) : null}
      <View
        style={[
          styles.bubble,
          mine
            ? { backgroundColor: c.brand, alignSelf: 'flex-end', borderBottomRightRadius: radius.sm }
            : {
                backgroundColor: c.surface, alignSelf: 'flex-start',
                borderBottomLeftRadius: radius.sm, borderWidth: 1, borderColor: c.border,
              },
        ]}
      >
        <Text style={{ color: mine ? c.onBrand : c.textPrimary, fontSize: 15, lineHeight: 21 }}>
          {message.body}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space[5] },
  reportBar: {
    minHeight: minTouchTarget, borderBottomWidth: 1,
    alignItems: 'flex-end', justifyContent: 'center', paddingHorizontal: space[4],
  },
  list: { padding: space[4], gap: space[2], flexGrow: 1, justifyContent: 'flex-end' },
  empty: { paddingVertical: space[8], paddingHorizontal: space[4] },
  bubble: { maxWidth: '82%', paddingHorizontal: space[3], paddingVertical: space[2], borderRadius: radius.lg },
  system: { paddingVertical: space[2] },
  notice: { paddingHorizontal: space[4], paddingVertical: space[2] },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: space[2],
    borderTopWidth: 1, padding: space[3],
  },
  input: {
    flex: 1, borderWidth: 1, borderRadius: radius.lg,
    paddingHorizontal: space[3], paddingTop: space[2], paddingBottom: space[2],
    minHeight: minTouchTarget, maxHeight: 120, fontSize: 15,
  },
  send: {
    width: minTouchTarget, height: minTouchTarget, borderRadius: radius.full,
    alignItems: 'center', justifyContent: 'center',
  },
  closed: { borderTopWidth: 1, padding: space[4] },
})
