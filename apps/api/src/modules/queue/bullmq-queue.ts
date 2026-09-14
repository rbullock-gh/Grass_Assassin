import type { Queue, JobName, JobPayloads, JobHandler, EnqueueOptions } from './queue.js'

/**
 * BullMQ-backed queue.
 *
 * ⚠️  UNVERIFIED — no Redis is available in this environment, so no line in
 * this file has executed. The automation logic that uses the Queue port is
 * thoroughly tested against InMemoryQueue; what is unproven here is this
 * adapter's fidelity to BullMQ's API. Before launch it needs a run against a
 * real Redis covering: a delayed job firing at the right time, a repeatable job
 * on its cron, deduplication by jobId, and a handler that throws being retried
 * rather than lost.
 *
 * Loaded lazily so a deployment without Redis configured still boots — the API
 * process serves requests fine without background work, and failing to start
 * over a missing optional dependency is worse than degrading.
 */
export class BullMqQueue implements Queue {
  private readonly queues = new Map<string, unknown>()
  private readonly workers: unknown[] = []
  private connection: { host: string; port: number; password?: string } | null = null

  private constructor(private readonly redisUrl: string) {}

  static async connect(redisUrl: string): Promise<BullMqQueue> {
    const queue = new BullMqQueue(redisUrl)
    const url = new URL(redisUrl)
    queue.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: url.password } : {}),
    }
    return queue
  }

  private async bullmq() {
    // Imported dynamically so the module is not required at boot.
    return import('bullmq')
  }

  private async queueFor(name: JobName) {
    const existing = this.queues.get(name)
    if (existing) return existing as { add: (n: string, d: unknown, o?: unknown) => Promise<unknown> }

    const { Queue: BullQueue } = await this.bullmq()
    const created = new BullQueue(name, { connection: this.connection! })
    this.queues.set(name, created)
    return created as unknown as { add: (n: string, d: unknown, o?: unknown) => Promise<unknown> }
  }

  async enqueue<N extends JobName>(name: N, payload: JobPayloads[N], options: EnqueueOptions = {}): Promise<void> {
    const queue = await this.queueFor(name)
    await queue.add(name, payload, {
      delay: options.delayMs,
      // BullMQ deduplicates on jobId, so a repeated enqueue of the same key
      // while the first is still waiting is a no-op.
      jobId: options.dedupeKey,
      removeOnComplete: { age: 3600, count: 1000 },
      // Failures are kept far longer than successes: a failed job is evidence.
      removeOnFail: { age: 7 * 86_400 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    })
  }

  async schedule<N extends JobName>(name: N, payload: JobPayloads[N], cron: string): Promise<void> {
    const queue = await this.queueFor(name)
    await queue.add(name, payload, {
      repeat: { pattern: cron },
      // A stable jobId keeps a redeploy from registering the same repeatable
      // job again, which would double every sweep's frequency.
      jobId: `repeat:${name}`,
      removeOnComplete: { count: 100 },
    })
  }

  on<N extends JobName>(name: N, handler: JobHandler<N>): void {
    void (async () => {
      const { Worker } = await this.bullmq()
      const worker = new Worker(
        name,
        async (job: { data: unknown }) => { await handler(job.data as JobPayloads[N]) },
        { connection: this.connection!, concurrency: 5 },
      )
      this.workers.push(worker)
    })()
  }

  async close(): Promise<void> {
    for (const worker of this.workers) {
      await (worker as { close: () => Promise<void> }).close().catch(() => undefined)
    }
    for (const queue of this.queues.values()) {
      await (queue as { close: () => Promise<void> }).close().catch(() => undefined)
    }
  }

  get url(): string { return this.redisUrl }
}
