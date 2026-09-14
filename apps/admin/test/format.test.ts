import { describe, it, expect } from 'vitest'
import { money, moneyCompact, percent, duration, statusTone, titleCase, relativeTime } from '@/lib/format'

describe('money', () => {
  it('formats cents as dollars with two decimals', () => {
    expect(money(6480)).toBe('$64.80')
    expect(money(0)).toBe('$0.00')
    expect(money(5)).toBe('$0.05')
    expect(money(100_000)).toBe('$1,000.00')
  })

  it('shows negative balances with the sign before the symbol', () => {
    // Ledger rows for customer accounts are negative; "-$226.80" reads
    // correctly, "$-226.80" does not.
    expect(money(-22_680)).toBe('-$226.80')
  })

  it('renders an em dash rather than $0.00 for missing data', () => {
    // A missing figure and a genuine zero mean different things on a finance
    // page, and conflating them hides broken queries.
    expect(money(null)).toBe('—')
    expect(money(undefined)).toBe('—')
    expect(money(0)).toBe('$0.00')
  })

  it('compacts large figures for stat tiles', () => {
    expect(moneyCompact(86_800)).toBe('$868')
    expect(moneyCompact(1_234_500)).toBe('$12.3k')
    expect(moneyCompact(250_000_000)).toBe('$2.5M')
  })
})

describe('percent', () => {
  it('formats a 0..1 fraction', () => {
    expect(percent(0.4523, 0)).toBe('45%')
    expect(percent(1, 0)).toBe('100%')
    expect(percent(0.0712, 1)).toBe('7.1%')
  })
  it('distinguishes missing from zero', () => {
    expect(percent(null)).toBe('—')
    expect(percent(0, 0)).toBe('0%')
  })
})

describe('duration', () => {
  it('scales units to the magnitude', () => {
    expect(duration(44)).toBe('44m')
    expect(duration(90)).toBe('1.5h')
    expect(duration(2880)).toBe('2.0d')
  })
  it('distinguishes missing from zero', () => {
    expect(duration(null)).toBe('—')
    expect(duration(0)).toBe('0m')
  })
})

describe('statusTone', () => {
  it('maps every job status to a defined tone', () => {
    const statuses = [
      'DRAFT', 'POSTED', 'CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE',
      'IN_PROGRESS', 'PENDING_APPROVAL', 'DISPUTED', 'APPROVED', 'PAID',
      'CLOSED', 'CANCELLED', 'EXPIRED',
    ]
    for (const status of statuses) {
      expect(['neutral', 'active', 'success', 'warning', 'danger']).toContain(statusTone(status))
    }
  })

  it('marks disputes as danger so they cannot be scanned past', () => {
    expect(statusTone('DISPUTED')).toBe('danger')
  })

  it('marks paid states as success', () => {
    expect(statusTone('PAID')).toBe('success')
    expect(statusTone('CLOSED')).toBe('success')
  })

  it('falls back safely for an unknown status', () => {
    expect(statusTone('SOMETHING_NEW')).toBe('neutral')
  })
})

describe('titleCase', () => {
  it('humanises enum values', () => {
    expect(titleCase('CLAIM_PENDING_PAYMENT')).toBe('Claim Pending Payment')
    expect(titleCase('PAID')).toBe('Paid')
  })
})

describe('relativeTime', () => {
  it('describes recent times relatively', () => {
    expect(relativeTime(new Date(Date.now() - 30_000))).toBe('just now')
    expect(relativeTime(new Date(Date.now() - 20 * 60_000))).toBe('20m ago')
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000))).toBe('3h ago')
    expect(relativeTime(new Date(Date.now() - 4 * 86_400_000))).toBe('4d ago')
  })
  it('falls back to an absolute date beyond a month', () => {
    expect(relativeTime(new Date(Date.now() - 200 * 86_400_000))).toMatch(/\d{4}/)
  })
  it('handles missing and invalid dates', () => {
    expect(relativeTime(null)).toBe('—')
    expect(relativeTime(undefined)).toBe('—')
    expect(relativeTime('not a date')).toBe('—')
  })

  it('describes FUTURE times as future, not as "just now"', () => {
    // A suspension expiring in five days rendered as "just now", because a
    // negative elapsed time fell through the under-a-minute branch. On a
    // moderation screen that reads as "already over" — the opposite of true.
    expect(relativeTime(new Date(Date.now() + 5 * 86_400_000))).toBe('in 5d')
    expect(relativeTime(new Date(Date.now() + 3 * 3_600_000))).toBe('in 3h')
    expect(relativeTime(new Date(Date.now() + 20 * 60_000))).toBe('in 20m')
    expect(relativeTime(new Date(Date.now() + 10_000))).toBe('in a moment')
  })

  it('never renders a future time as a past one', () => {
    for (const minutes of [1, 5, 59, 61, 1439, 1441, 4320]) {
      const future = relativeTime(new Date(Date.now() + minutes * 60_000))
      expect(future, `+${minutes}m rendered as "${future}"`).not.toMatch(/ago$/)
      const past = relativeTime(new Date(Date.now() - minutes * 60_000))
      expect(past, `-${minutes}m rendered as "${past}"`).not.toMatch(/^in /)
    }
  })
})
