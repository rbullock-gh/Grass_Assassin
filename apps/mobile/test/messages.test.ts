import { describe, expect, it } from 'vitest'
import { messageTimestamp, shouldShowTimestamp, previewOf, TIMESTAMP_GAP_MS } from '@/lib/messages'
import type { ChatMessage } from '@grassassassin/client'

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', senderId: 'them', kind: 'TEXT', body: 'hello',
  readAt: null, createdAt: '2026-09-14T12:00:00Z', ...overrides,
})

describe('timestamp grouping', () => {
  it('always labels the first message', () => {
    expect(shouldShowTimestamp([message()], 0)).toBe(true)
  })

  it('stays quiet for a rapid back-and-forth', () => {
    // A timestamp on every bubble is noise, and a live exchange is the case
    // where it carries the least information.
    const messages = [
      message({ id: 'a', createdAt: '2026-09-14T12:00:00Z' }),
      message({ id: 'b', createdAt: '2026-09-14T12:00:40Z' }),
      message({ id: 'c', createdAt: '2026-09-14T12:01:10Z' }),
    ]
    expect(shouldShowTimestamp(messages, 1)).toBe(false)
    expect(shouldShowTimestamp(messages, 2)).toBe(false)
  })

  it('marks a real gap, which is when it means something', () => {
    const messages = [
      message({ id: 'a', createdAt: '2026-09-14T12:00:00Z' }),
      message({ id: 'b', createdAt: '2026-09-14T14:30:00Z' }),
    ]
    expect(shouldShowTimestamp(messages, 1)).toBe(true)
  })

  it('uses the boundary consistently', () => {
    const base = new Date('2026-09-14T12:00:00Z').getTime()
    const at = (offset: number) => message({ createdAt: new Date(base + offset).toISOString() })
    expect(shouldShowTimestamp([at(0), at(TIMESTAMP_GAP_MS - 1000)], 1)).toBe(false)
    expect(shouldShowTimestamp([at(0), at(TIMESTAMP_GAP_MS)], 1)).toBe(true)
  })

  it('does not throw on a timestamp it cannot parse', () => {
    const messages = [message({ createdAt: 'whenever' }), message()]
    expect(() => shouldShowTimestamp(messages, 1)).not.toThrow()
    expect(shouldShowTimestamp(messages, 1)).toBe(false)
  })
})

describe('timestamp wording', () => {
  const now = new Date('2026-09-14T18:00:00')

  it('gives today a bare clock time', () => {
    const label = messageTimestamp(new Date('2026-09-14T09:30:00'), now)
    expect(label).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)
  })

  it('names yesterday rather than printing a date', () => {
    expect(messageTimestamp(new Date('2026-09-13T09:30:00'), now)).toMatch(/^Yesterday /)
  })

  it('drops the year within the same year and keeps it otherwise', () => {
    expect(messageTimestamp(new Date('2026-03-02T09:30:00'), now)).not.toMatch(/2026/)
    expect(messageTimestamp(new Date('2025-03-02T09:30:00'), now)).toMatch(/2025/)
  })

  it('returns empty rather than "Invalid Date" for junk', () => {
    expect(messageTimestamp('not a date', now)).toBe('')
  })
})

describe('conversation preview', () => {
  it('says who spoke last, which is the point of the list', () => {
    expect(previewOf(message({ senderId: 'me', body: 'On my way' }), 'me')).toBe('You: On my way')
    expect(previewOf(message({ senderId: 'them', body: 'On my way' }), 'me')).toBe('On my way')
  })

  it('handles an empty thread', () => {
    expect(previewOf(null, 'me')).toBe('No messages yet')
  })

  it('describes a photo instead of showing a blank line', () => {
    expect(previewOf(message({ kind: 'PHOTO', body: null, senderId: 'me' }), 'me')).toBe('You sent a photo')
    expect(previewOf(message({ kind: 'PHOTO', body: null, senderId: 'them' }), 'me')).toBe('Sent a photo')
  })

  it('does not prefix a system message with "You:"', () => {
    // A status update is nobody's message; attributing it to the viewer is a lie.
    expect(previewOf(message({ kind: 'SYSTEM', senderId: null, body: 'Work started' }), 'me'))
      .toBe('Work started')
  })

  it('never renders null as text', () => {
    expect(previewOf(message({ body: null }), 'me')).not.toContain('null')
  })
})
