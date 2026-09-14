import type { ChatMessage } from '@grassassassin/client'

/**
 * Timestamp grouping in a thread.
 *
 * A timestamp on every bubble is noise; none at all loses the thing that makes
 * a conversation legible — how long the other person took to answer. So one
 * appears when a real gap has passed, which is exactly when it carries
 * information.
 */
export const TIMESTAMP_GAP_MS = 15 * 60_000

export function shouldShowTimestamp(messages: ChatMessage[], index: number): boolean {
  if (index === 0) return true
  const current = new Date(messages[index]!.createdAt).getTime()
  const previous = new Date(messages[index - 1]!.createdAt).getTime()
  if (Number.isNaN(current) || Number.isNaN(previous)) return false
  return current - previous >= TIMESTAMP_GAP_MS
}

/**
 * How a message time is written.
 *
 * Today gets a bare clock time, because the date is redundant and a worker
 * scanning a thread mid-job wants the fewest characters that answer "when".
 */
export function messageTimestamp(iso: string | Date, now = new Date()): string {
  const at = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(at.getTime())) return ''

  const sameDay = at.toDateString() === now.toDateString()
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time

  const yesterday = new Date(now.getTime() - 86_400_000)
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`

  const sameYear = at.getFullYear() === now.getFullYear()
  const date = at.toLocaleDateString('en-US',
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
  return `${date}, ${time}`
}

/**
 * The preview line in a conversation list.
 *
 * "You: " matters more than it looks: without it a list of replies is
 * ambiguous about who spoke last, which is the one thing the list is for.
 */
export function previewOf(
  lastMessage: Pick<ChatMessage, 'body' | 'kind' | 'senderId'> | null,
  viewerId: string | null,
): string {
  if (!lastMessage) return 'No messages yet'
  if (lastMessage.kind === 'PHOTO') return lastMessage.senderId === viewerId ? 'You sent a photo' : 'Sent a photo'
  const body = lastMessage.body ?? ''
  if (lastMessage.kind === 'SYSTEM') return body
  return lastMessage.senderId === viewerId ? `You: ${body}` : body
}
