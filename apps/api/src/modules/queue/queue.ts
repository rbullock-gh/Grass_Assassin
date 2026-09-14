/**
 * Background work.
 *
 * Every job type is defined here as data, behind a Queue port with two drivers:
 *
 *   · BullMqQueue     — production. Redis-backed, survives a restart, supports
 *                       delayed and repeatable jobs natively.
 *   · InMemoryQueue   — tests and local development. Runs handlers immediately
 *                       or on a manual clock, so a test can assert what a
 *                       deadline reminder does without waiting 24 hours.
 *
 * The port exists because the alternative — calling BullMQ directly from the
 * domain — makes every scheduling behaviour untestable without a live Redis,
 * and scheduling behaviour is exactly where the subtle bugs live.
 */

export type JobName =
  | 'notify.job-posted'
  | 'notify.deadline-reminder'
  | 'notify.approval-reminder'
  | 'sweep.expired-claims'
  | 'sweep.auto-approve'
  | 'sweep.expire-jobs'
  | 'recompute.reputation'
  | 'recompute.leaderboards'
  | 'recompute.premium-flags'
  | 'recurring.generate'

export interface JobPayloads {
  'notify.job-posted': { jobId: string }
  'notify.deadline-reminder': { jobId: string; hoursBefore: number }
  'notify.approval-reminder': { jobId: string }
  'sweep.expired-claims': Record<string, never>
  'sweep.auto-approve': Record<string, never>
  'sweep.expire-jobs': Record<string, never>
  'recompute.reputation': { workerUserId: string }
  'recompute.leaderboards': Record<string, never>
  'recompute.premium-flags': Record<string, never>
  'recurring.generate': Record<string, never>
}

export interface EnqueueOptions {
  /** Delay before the job becomes runnable. */
  delayMs?: number
  /**
   * Stable id for deduplication. Enqueuing the same id twice while the first is
   * still pending is a no-op — which is what stops a job that gets updated five
   * times from sending five "new job nearby" pushes.
   */
  dedupeKey?: string
}

export type JobHandler<N extends JobName> = (payload: JobPayloads[N]) => Promise<void>

export interface Queue {
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N], options?: EnqueueOptions): Promise<void>
  /** Registers a recurring job. Cron in production, manual in tests. */
  schedule<N extends JobName>(name: N, payload: JobPayloads[N], cron: string): Promise<void>
  on<N extends JobName>(name: N, handler: JobHandler<N>): void
  close(): Promise<void>
}

interface PendingJob {
  name: JobName
  payload: unknown
  runAt: number
  dedupeKey?: string
}

/**
 * In-memory queue with a manual clock.
 *
 * `runDue(now)` drains everything scheduled at or before `now`, so a test can
 * assert "the 24-hour reminder fires once, 24 hours before the deadline"
 * without any real waiting and without timer mocking that leaks between tests.
 */
export class InMemoryQueue implements Queue {
  private readonly handlers = new Map<JobName, JobHandler<JobName>[]>()
  private pending: PendingJob[] = []
  private readonly activeDedupeKeys = new Set<string>()
  readonly scheduled: Array<{ name: JobName; cron: string; payload: unknown }> = []
  /** Every job ever enqueued, for assertions. */
  readonly enqueued: Array<{ name: JobName; payload: unknown; runAt: number }> = []

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], options: EnqueueOptions = {}): Promise<void> {
    if (options.dedupeKey) {
      if (this.activeDedupeKeys.has(options.dedupeKey)) return
      this.activeDedupeKeys.add(options.dedupeKey)
    }
    const runAt = Date.now() + (options.delayMs ?? 0)
    const job: PendingJob = { name, payload, runAt }
    if (options.dedupeKey !== undefined) job.dedupeKey = options.dedupeKey
    this.pending.push(job)
    this.enqueued.push({ name, payload, runAt })
  }

  async schedule<N extends JobName>(name: N, payload: JobPayloads[N], cron: string): Promise<void> {
    this.scheduled.push({ name, cron, payload })
  }

  on<N extends JobName>(name: N, handler: JobHandler<N>): void {
    const existing = this.handlers.get(name) ?? []
    existing.push(handler as JobHandler<JobName>)
    this.handlers.set(name, existing)
  }

  /** Runs every job due at or before `now`. Returns how many ran. */
  async runDue(now = Date.now()): Promise<number> {
    const due = this.pending.filter((job) => job.runAt <= now)
    this.pending = this.pending.filter((job) => job.runAt > now)

    for (const job of due) {
      if (job.dedupeKey) this.activeDedupeKeys.delete(job.dedupeKey)
      for (const handler of this.handlers.get(job.name) ?? []) {
        // A failing handler must not abort the batch — in production each job
        // retries independently, and a test that stops at the first error hides
        // everything after it.
        await handler(job.payload as never).catch(() => undefined)
      }
    }
    return due.length
  }

  /** Runs a named recurring job on demand, as its cron would. */
  async runScheduled(name: JobName): Promise<void> {
    const entry = this.scheduled.find((s) => s.name === name)
    for (const handler of this.handlers.get(name) ?? []) {
      await handler((entry?.payload ?? {}) as never)
    }
  }

  pendingCount(name?: JobName): number {
    return name ? this.pending.filter((j) => j.name === name).length : this.pending.length
  }

  countEnqueued(name: JobName): number {
    return this.enqueued.filter((j) => j.name === name).length
  }

  reset(): void {
    this.pending = []
    this.enqueued.length = 0
    this.scheduled.length = 0
    this.activeDedupeKeys.clear()
  }

  async close(): Promise<void> {
    this.pending = []
  }
}

/**
 * Cron expressions for the recurring work.
 *
 * Sweeps that release money or unblock a worker run often; recomputation that
 * only affects display runs rarely. Leaderboards in particular are expensive
 * and nobody is harmed by a five-minute-old ranking.
 */
export const SCHEDULES: Record<string, { name: JobName; cron: string }> = {
  expiredClaims: { name: 'sweep.expired-claims', cron: '*/1 * * * *' },
  autoApprove: { name: 'sweep.auto-approve', cron: '*/10 * * * *' },
  expireJobs: { name: 'sweep.expire-jobs', cron: '*/15 * * * *' },
  leaderboards: { name: 'recompute.leaderboards', cron: '*/15 * * * *' },
  premiumFlags: { name: 'recompute.premium-flags', cron: '*/30 * * * *' },
  recurringJobs: { name: 'recurring.generate', cron: '0 * * * *' },
}
