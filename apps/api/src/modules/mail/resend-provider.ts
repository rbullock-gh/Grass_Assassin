import { randomUUID } from 'node:crypto'
import { MailDeliveryError, type MailProvider, type MailMessage, type MailResult } from './provider.js'

/**
 * Transactional email over Resend's REST API.
 *
 * Chosen because it is one authenticated POST with no SDK, so this adapter adds
 * no dependency and can be read end to end. Swapping to Postmark, SES or
 * SendGrid means rewriting this one file against the `MailProvider` port and
 * changing nothing else.
 *
 * UNVERIFIED AGAINST THE LIVE API. There is no API key in this environment, so
 * what is tested here is the request this builds, the retry policy, and the way
 * it classifies responses — against a stubbed fetch, not against Resend. The
 * first real send needs a human watching. This is recorded in
 * docs/04-deployment.md as well, because a comment in a file nobody opens is
 * not a disclosure.
 *
 * Contract details that are easy to get wrong and are handled here:
 *
 *  - Resend rate-limits at a couple of requests per second by default and
 *    answers 429. A password reset that is dropped because somebody else was
 *    signing up at the same moment is indistinguishable, to the person waiting,
 *    from an account that does not exist.
 *  - `Idempotency-Key` is honoured, so a retry after a timeout does not send a
 *    second copy. Without it, a network blip means two reset emails with two
 *    different valid tokens.
 *  - A 4xx that is not 429 is permanent. Retrying a rejected sender domain
 *    only delays the error.
 */

const ENDPOINT = 'https://api.resend.com/emails'

export interface ResendOptions {
  apiKey: string
  /** Must be on a domain verified with the provider, or every send is refused. */
  from: string
  /** Retries are for 429 and 5xx only. Three attempts total by default. */
  maxAttempts?: number
  /** Injected so the retry policy is testable without waiting for real seconds. */
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
}

export class ResendMailProvider implements MailProvider {
  readonly name = 'resend'

  private readonly maxAttempts: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: ResendOptions) {
    this.maxAttempts = options.maxAttempts ?? 3
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async send(message: MailMessage): Promise<MailResult> {
    /*
     * One key per CALL, reused by every attempt of that call.
     *
     * Not derived from the message content, which is the tempting version and
     * is wrong: the provider honours a key for 24 hours, so a content hash
     * would make two genuinely separate sends of the same message — the same
     * reminder about the same job on two days, say — silently collapse into
     * one. Random per call, stable per retry, is the behaviour actually wanted.
     */
    const idempotencyKey = randomUUID()

    let lastError: MailDeliveryError | undefined

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            from: this.options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
            tags: [{ name: 'category', value: message.category }],
          }),
        })
      } catch (caught) {
        // A transport failure says nothing about whether the message was
        // accepted. The idempotency key is what makes retrying safe.
        lastError = new MailDeliveryError(
          `Could not reach the mail provider: ${(caught as Error).message}`, this.name,
        )
        if (attempt < this.maxAttempts) {
          await this.sleep(backoffMs(attempt))
          continue
        }
        throw lastError
      }

      if (response.ok) {
        const body = await response.json().catch(() => ({})) as { id?: string }
        return { messageId: body.id ?? null, accepted: true }
      }

      const detail = await response.text().catch(() => '')
      lastError = new MailDeliveryError(
        `Mail provider refused the message: ${response.status} ${detail.slice(0, 300)}`,
        this.name,
        response.status,
      )

      const worthRetrying = response.status === 429 || response.status >= 500
      if (!worthRetrying || attempt === this.maxAttempts) throw lastError

      /*
       * Respect the provider's own Retry-After when it sends one. Guessing a
       * backoff shorter than the window it just told us about is how a client
       * turns one 429 into a sustained one.
       */
      const retryAfter = Number(response.headers.get('retry-after'))
      await this.sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt),
      )
    }

    throw lastError ?? new MailDeliveryError('Mail delivery failed', this.name)
  }
}

/** 400ms, 800ms, 1600ms — short, because somebody is watching a spinner. */
function backoffMs(attempt: number): number {
  return 400 * 2 ** (attempt - 1)
}
