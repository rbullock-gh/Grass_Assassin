import type { Prisma } from '@prisma/client'
import type { Db, Tx } from '../../lib/prisma.js'

/**
 * Double-entry ledger.
 *
 * The `transactions` table records *intent* ("we tried to charge $64.80").
 * This table records *effect* — every cent that moved, as balanced entries that
 * must sum to zero.
 *
 * Why both: a marketplace's most expensive failure mode is discovering, weeks
 * later during a reconciliation against the processor, that its own books
 * disagree with reality and nobody can say when the divergence started. Balanced
 * entries written at the moment of each movement mean the disagreement is
 * detectable the same day, and the entries themselves say exactly where it came
 * from.
 *
 * Accounts are strings rather than a foreign key so that platform-internal
 * accounts (revenue, processing costs, promotional spend) sit in the same
 * namespace as user accounts without a polymorphic join.
 */

export const ACCOUNTS = {
  /** What a customer has paid in. Debited as money leaves them. */
  customer: (userId: string) => `customer:${userId}`,
  /** A worker's claim on funds, before payout. */
  worker: (userId: string) => `worker:${userId}`,
  /** Platform revenue — commission plus service fees. */
  platformRevenue: 'platform:revenue',
  /** Processor fees we absorb. Always a cost, never revenue. */
  processingCost: 'platform:processing',
  /** Funds held pending customer approval. */
  escrow: 'platform:escrow',
  /** Promotional discounts the platform funded. */
  promotions: 'platform:promotions',
  /** Money returned to a customer. */
  refunds: 'platform:refunds',
  /**
   * Money that has actually left the platform for a worker's bank.
   *
   * A worker's own account holds their claim on funds; paying them out does not
   * destroy that money, it moves it somewhere this ledger can no longer see. It
   * still has to land in an account or the entry would not balance, so it lands
   * here. The running total is what has been remitted, ever.
   */
  payoutsOut: 'platform:payouts',
} as const

export interface LedgerLine {
  account: string
  /** Positive credits the account, negative debits it. */
  amountCents: number
  memo?: string
}

export class UnbalancedLedgerError extends Error {
  readonly code = 'UNBALANCED_LEDGER'
  constructor(readonly delta: number, readonly lines: LedgerLine[]) {
    super(`Ledger entry does not balance: net ${delta} cents across ${lines.length} lines`)
    this.name = 'UnbalancedLedgerError'
  }
}

/**
 * Writes a balanced set of ledger lines.
 *
 * Throws rather than writing if the lines do not sum to zero. This is the whole
 * safety property — a partial or lopsided write is worse than no write, because
 * it corrupts the ledger silently while looking like a success.
 */
export async function postEntry(
  db: Db | Tx,
  params: { jobId?: string | null; transactionId?: string | null; lines: LedgerLine[] },
): Promise<void> {
  const { lines } = params
  if (lines.length === 0) return

  const delta = lines.reduce((sum, l) => sum + l.amountCents, 0)
  if (delta !== 0) throw new UnbalancedLedgerError(delta, lines)

  for (const line of lines) {
    if (!Number.isInteger(line.amountCents)) {
      throw new TypeError(`Ledger amounts must be integer cents, received ${line.amountCents}`)
    }
  }

  await db.ledgerEntry.createMany({
    data: lines.map((line) => ({
      jobId: params.jobId ?? null,
      transactionId: params.transactionId ?? null,
      account: line.account,
      amountCents: line.amountCents,
      memo: line.memo ?? null,
    })),
  })
}

/** Current balance of one account. */
export async function accountBalance(db: Db, account: string): Promise<number> {
  const result = await db.ledgerEntry.aggregate({
    where: { account },
    _sum: { amountCents: true },
  })
  return result._sum.amountCents ?? 0
}

/**
 * The invariant that must hold at all times: every cent in the ledger nets to
 * zero. Run in tests and on a schedule in production; a non-zero result is a
 * page-someone-now event.
 */
export async function ledgerIsBalanced(db: Db): Promise<{ balanced: boolean; delta: number }> {
  const result = await db.ledgerEntry.aggregate({ _sum: { amountCents: true } })
  const delta = result._sum.amountCents ?? 0
  return { balanced: delta === 0, delta }
}

/** Per-account totals, for the admin reconciliation view. */
export async function trialBalance(db: Db): Promise<Array<{ account: string; balanceCents: number }>> {
  const rows = await db.ledgerEntry.groupBy({
    by: ['account'],
    _sum: { amountCents: true },
    orderBy: { account: 'asc' },
  })
  return rows.map((r) => ({ account: r.account, balanceCents: r._sum.amountCents ?? 0 }))
}

/** Everything that happened to one job's money, in order. */
export async function jobLedger(db: Db, jobId: string): Promise<Prisma.LedgerEntryGetPayload<object>[]> {
  return db.ledgerEntry.findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } })
}
