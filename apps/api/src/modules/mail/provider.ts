/**
 * Email port.
 *
 * Until now this system could not send an email at all. The notification
 * schema has had an EMAIL channel since the first migration and nothing ever
 * wrote to it — which was survivable while every message was a push
 * notification to a signed-in phone, and stopped being survivable the moment
 * somebody forgot their password. A locked-out person has no push token we are
 * allowed to trust and no session to authenticate with. Email is the only
 * channel left.
 *
 * Written as a port for the same reason payments are: the transactional email
 * market churns, the interesting failure modes (a bounce, a rejected domain, a
 * provider outage) are hard to trigger on demand against a live API, and a
 * password-reset flow that can only be tested by actually receiving mail is a
 * flow that will not be tested.
 */

export interface MailMessage {
  to: string
  subject: string
  /** Always required. Some clients refuse HTML, and some people prefer it. */
  text: string
  html?: string
  /**
   * Groups messages for the provider's own reporting and for suppression
   * rules. A bounce on a marketing send must never suppress a password reset.
   */
  category: 'password-reset' | 'account' | 'job' | 'receipt'
}

export interface MailResult {
  /** Provider-side id, where the provider gives one. For support tickets. */
  messageId: string | null
  accepted: boolean
}

export interface MailProvider {
  readonly name: string
  send(message: MailMessage): Promise<MailResult>
}

/**
 * Thrown when the provider rejected the message outright.
 *
 * Deliberately NOT thrown for a soft failure like a full mailbox: those are
 * asynchronous and arrive as a bounce webhook, long after this call returned.
 */
export class MailDeliveryError extends Error {
  constructor(message: string, readonly providerName: string, readonly status?: number) {
    super(message)
    this.name = 'MailDeliveryError'
  }
}
