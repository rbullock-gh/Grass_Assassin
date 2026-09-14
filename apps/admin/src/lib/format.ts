/** Shared formatting. Money is integer cents everywhere; never format a float. */

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compact money for stat tiles, where two decimals on $48,392.00 is noise. */
export function moneyCompact(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const dollars = cents / 100
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`
  if (Math.abs(dollars) >= 10_000) return `$${(dollars / 1000).toFixed(1)}k`
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function relativeTime(date: Date | string | null | undefined): string {
  if (!date) return '—'
  const then = typeof date === 'string' ? new Date(date) : date
  const seconds = Math.round((Date.now() - then.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—'
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

/** Colour role per job status, so state reads at a glance without the label. */
export function statusTone(status: string): 'neutral' | 'active' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'DRAFT': return 'neutral'
    case 'POSTED': return 'active'
    case 'CLAIM_PENDING_PAYMENT': return 'warning'
    case 'CLAIMED':
    case 'EN_ROUTE':
    case 'IN_PROGRESS': return 'active'
    case 'PENDING_APPROVAL': return 'warning'
    case 'DISPUTED': return 'danger'
    case 'APPROVED':
    case 'PAID':
    case 'CLOSED': return 'success'
    case 'CANCELLED':
    case 'EXPIRED': return 'neutral'
    default: return 'neutral'
  }
}

export function titleCase(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}
