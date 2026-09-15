import type { Db } from '../../lib/prisma.js'
import type { PushSender, PushMessage } from './notifier.js'

/**
 * Delivery through Expo's push service.
 *
 * Expo is the right hop for an Expo app: it holds the APNs and FCM credentials
 * so this server never does, and one token format covers both platforms. The
 * cost is that a send is not one call — it is a send, then a receipt check some
 * seconds later, and only the receipt tells you whether Apple or Google
 * actually accepted it.
 *
 * Two things here are not optional in production:
 *
 * A dead token must be DELETED. A device that has been reinstalled, or whose
 * owner revoked notifications, returns DeviceNotRegistered forever. Leaving the
 * row means every future push to that person pays for a guaranteed failure, and
 * — worse — `notify` counts a partial success as delivered, so a user with one
 * live device and three dead ones looks fine while the accounting rots.
 *
 * And a push must never take the caller down with it. These are called from
 * queue handlers inside the job lifecycle: a worker gets claimed, a customer
 * gets told. If Expo is having an afternoon, the claim must still succeed. Every
 * failure here is counted and returned, never thrown.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts'

/** Expo's documented limit. Sending 101 in one request fails the whole batch. */
export const EXPO_CHUNK_SIZE = 100

interface ExpoTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

interface ExpoReceipt {
  status: 'ok' | 'error'
  message?: string
  details?: { error?: string }
}

/**
 * Errors that mean "this token will never work again".
 *
 * Distinguished from transient ones on purpose: deleting a device because Expo
 * was briefly rate-limiting us would silently unsubscribe a real user, and they
 * would never know to turn it back on.
 */
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered', 'InvalidCredentials'])

export interface ExpoPushOptions {
  /**
   * An Expo access token, required once push security is enabled on the
   * project. Sending without one works until somebody turns that on, at which
   * point every push fails — so it is read from the environment and passed
   * whenever present rather than being left out.
   */
  accessToken?: string
  fetchImpl?: typeof fetch
  /** Where dead tokens get removed. Optional so the adapter can be used alone. */
  db?: Db
}

export class ExpoPushSender implements PushSender {
  private readonly accessToken?: string
  private readonly fetchImpl: typeof fetch
  private readonly db?: Db

  /** Tickets whose receipts have not been checked yet, by ticket id. */
  private readonly pendingReceipts = new Map<string, string>()

  constructor(options: ExpoPushOptions = {}) {
    this.accessToken = options.accessToken
    this.fetchImpl = options.fetchImpl ?? fetch
    this.db = options.db
  }

  async send(messages: PushMessage[]): Promise<{ sent: number; failed: number }> {
    if (messages.length === 0) return { sent: 0, failed: 0 }

    let sent = 0
    let failed = 0
    const dead: string[] = []

    for (let i = 0; i < messages.length; i += EXPO_CHUNK_SIZE) {
      const chunk = messages.slice(i, i + EXPO_CHUNK_SIZE)
      let tickets: ExpoTicket[]

      try {
        tickets = await this.post(chunk)
      } catch {
        // Network trouble, a 500 from Expo, a timeout. Every message in the
        // chunk is a failure, and none of the tokens is proven dead.
        failed += chunk.length
        continue
      }

      chunk.forEach((message, index) => {
        const ticket = tickets[index]
        if (!ticket) { failed += 1; return }
        if (ticket.status === 'ok') {
          sent += 1
          if (ticket.id) this.pendingReceipts.set(ticket.id, message.to)
          return
        }
        failed += 1
        if (ticket.details?.error && DEAD_TOKEN_ERRORS.has(ticket.details.error)) {
          dead.push(message.to)
        }
      })
    }

    if (dead.length > 0) await this.forget(dead)
    return { sent, failed }
  }

  /**
   * Checks the receipts for everything sent since the last check.
   *
   * A ticket only says Expo accepted the message. The receipt, available some
   * seconds later, says whether Apple or Google did — and it is where most
   * DeviceNotRegistered results actually arrive. Without this, dead tokens are
   * never pruned and every send looks like a success forever.
   *
   * Meant to be called on a timer by the queue, not inline with a send.
   */
  async collectReceipts(): Promise<{ ok: number; failed: number; pruned: number }> {
    const ids = [...this.pendingReceipts.keys()]
    if (ids.length === 0) return { ok: 0, failed: 0, pruned: 0 }

    let ok = 0
    let failed = 0
    const dead: string[] = []

    for (let i = 0; i < ids.length; i += EXPO_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + EXPO_CHUNK_SIZE)
      let receipts: Record<string, ExpoReceipt>
      try {
        receipts = await this.postReceipts(chunk)
      } catch {
        // Leave these pending: an unreachable receipt endpoint is not evidence
        // about anybody's token, and the next sweep will ask again.
        continue
      }

      for (const id of chunk) {
        const receipt = receipts[id]
        // Expo omits receipts that are not ready yet. Keep waiting for those.
        if (!receipt) continue
        // Read the token BEFORE dropping the entry, or the prune has nothing
        // to prune and dead devices live forever.
        const token = this.pendingReceipts.get(id)
        this.pendingReceipts.delete(id)
        if (receipt.status === 'ok') { ok += 1; continue }
        failed += 1
        if (token && receipt.details?.error && DEAD_TOKEN_ERRORS.has(receipt.details.error)) {
          dead.push(token)
        }
      }
    }

    const pruned = dead.length > 0 ? await this.forget(dead) : 0
    return { ok, failed, pruned }
  }

  private async post(messages: PushMessage[]): Promise<ExpoTicket[]> {
    const response = await this.fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(messages),
    })
    if (!response.ok) throw new Error(`Expo push returned ${response.status}`)
    const payload = await response.json() as { data?: ExpoTicket[] }
    return payload.data ?? []
  }

  private async postReceipts(ids: string[]): Promise<Record<string, ExpoReceipt>> {
    const response = await this.fetchImpl(EXPO_RECEIPT_URL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ids }),
    })
    if (!response.ok) throw new Error(`Expo receipts returned ${response.status}`)
    const payload = await response.json() as { data?: Record<string, ExpoReceipt> }
    return payload.data ?? {}
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
    }
  }

  /** Removes tokens that will never work again. Returns how many rows went. */
  private async forget(tokens: string[]): Promise<number> {
    if (!this.db) return 0
    const { count } = await this.db.device.deleteMany({
      where: { pushToken: { in: [...new Set(tokens)] } },
    })
    return count
  }
}
