import type { Db } from '../../lib/prisma.js'
import { DEFAULT_FEE_CONFIG, DEFAULT_CANCELLATION_POLICY, type FeeConfig, type CancellationPolicy } from '@grassassassin/shared'

/**
 * Fee and policy configuration, resolved from the database.
 *
 * Nothing about our economics is hard-coded. Rates live in `platform_config`,
 * are editable per market from the admin dashboard, and every change is audited.
 * That was a deliberate requirement: a marketplace that needs an engineer and a
 * deploy to change a commission rate cannot respond to a competitor, and cannot
 * run the pricing experiments that find the right number in the first place.
 *
 * Resolution order: market-specific value, then global default, then the
 * compiled-in constant. The last fallback exists so a wiped config table
 * degrades to sane behaviour instead of charging zero or crashing checkout.
 */

const CONFIG_KEYS = {
  workerCommissionBps: 'fees.worker_commission_bps',
  customerServiceFeeBps: 'fees.customer_service_fee_bps',
  customerServiceFeeMinCents: 'fees.customer_service_fee_min_cents',
  minJobPriceCents: 'fees.min_job_price_cents',
  maxJobPriceCents: 'fees.max_job_price_cents',
  graceMinutesAfterClaim: 'cancellation.grace_minutes',
  lateCancelHours: 'cancellation.late_hours',
  earlyCancelPenaltyBps: 'cancellation.early_penalty_bps',
  lateCancelPenaltyBps: 'cancellation.late_penalty_bps',
  autoApprovalHours: 'approval.auto_approve_hours',
} as const

export interface ResolvedPolicy {
  fees: FeeConfig
  cancellation: CancellationPolicy
  autoApprovalHours: number
}

export const DEFAULT_AUTO_APPROVAL_HOURS = 24

function numberFrom(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  // A malformed config row must not take checkout down. Fall back and move on;
  // the admin UI validates on write, so this is a last line of defence.
  return fallback
}

/**
 * Loads policy for a market.
 *
 * `scopeKey` is a market identifier (a city slug). Passing null or an unknown
 * market yields the global defaults.
 */
export async function resolvePolicy(db: Db, scopeKey?: string | null): Promise<ResolvedPolicy> {
  const keys = Object.values(CONFIG_KEYS)
  const rows = await db.platformConfig.findMany({
    where: {
      key: { in: keys },
      OR: [{ scopeKey: null }, ...(scopeKey ? [{ scopeKey }] : [])],
    },
  })

  // Market-specific rows win over globals, so index globals first then let the
  // scoped rows overwrite them.
  const resolved = new Map<string, unknown>()
  for (const row of rows.filter((r) => r.scopeKey === null)) resolved.set(row.key, row.value)
  if (scopeKey) {
    for (const row of rows.filter((r) => r.scopeKey === scopeKey)) resolved.set(row.key, row.value)
  }

  const get = (key: string, fallback: number) => numberFrom(resolved.get(key), fallback)

  return {
    fees: {
      workerCommissionBps: get(CONFIG_KEYS.workerCommissionBps, DEFAULT_FEE_CONFIG.workerCommissionBps),
      customerServiceFeeBps: get(CONFIG_KEYS.customerServiceFeeBps, DEFAULT_FEE_CONFIG.customerServiceFeeBps),
      customerServiceFeeMinCents: get(CONFIG_KEYS.customerServiceFeeMinCents, DEFAULT_FEE_CONFIG.customerServiceFeeMinCents),
      minJobPriceCents: get(CONFIG_KEYS.minJobPriceCents, DEFAULT_FEE_CONFIG.minJobPriceCents),
      maxJobPriceCents: get(CONFIG_KEYS.maxJobPriceCents, DEFAULT_FEE_CONFIG.maxJobPriceCents),
    },
    cancellation: {
      graceMinutesAfterClaim: get(CONFIG_KEYS.graceMinutesAfterClaim, DEFAULT_CANCELLATION_POLICY.graceMinutesAfterClaim),
      lateCancelHours: get(CONFIG_KEYS.lateCancelHours, DEFAULT_CANCELLATION_POLICY.lateCancelHours),
      earlyCancelPenaltyBps: get(CONFIG_KEYS.earlyCancelPenaltyBps, DEFAULT_CANCELLATION_POLICY.earlyCancelPenaltyBps),
      lateCancelPenaltyBps: get(CONFIG_KEYS.lateCancelPenaltyBps, DEFAULT_CANCELLATION_POLICY.lateCancelPenaltyBps),
    },
    autoApprovalHours: get(CONFIG_KEYS.autoApprovalHours, DEFAULT_AUTO_APPROVAL_HOURS),
  }
}

/** Admin write path. Every change is audited with its previous value. */
export async function setConfig(db: Db, params: {
  key: string
  value: unknown
  scopeKey?: string | null
  adminId: string
}): Promise<void> {
  const scopeKey = params.scopeKey ?? null
  const existing = await db.platformConfig.findFirst({ where: { key: params.key, scopeKey } })

  await db.$transaction(async (tx) => {
    if (existing) {
      await tx.platformConfig.update({
        where: { id: existing.id },
        data: { value: params.value as never, updatedById: params.adminId },
      })
    } else {
      await tx.platformConfig.create({
        data: { key: params.key, value: params.value as never, scopeKey, updatedById: params.adminId },
      })
    }
    await tx.auditLog.create({
      data: {
        actorId: params.adminId, actorType: 'ADMIN', action: 'config.update',
        entityType: 'PlatformConfig', entityId: params.key,
        before: existing ? { value: existing.value, scopeKey } : undefined,
        after: { value: params.value as never, scopeKey },
      },
    })
  })
}

export { CONFIG_KEYS }
