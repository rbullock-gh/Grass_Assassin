import type { MailProvider, MailMessage, MailResult } from './provider.js'

/**
 * Development and test delivery: keeps the message, sends nothing.
 *
 * Two jobs, and the second is the important one.
 *
 * In development it prints the message so a developer can follow a reset link
 * out of their terminal without configuring a mail provider. In tests it holds
 * the messages so an assertion can read what was actually sent — which is the
 * only way to check the things that matter about a password-reset email:
 * that the link contains the real token, that the token is NOT the one stored
 * in the database, and that the body does not confirm whether the address
 * belongs to an account.
 */
export class ConsoleMailProvider implements MailProvider {
  readonly name = 'console'
  readonly sent: MailMessage[] = []

  constructor(private readonly print = false) {}

  async send(message: MailMessage): Promise<MailResult> {
    this.sent.push(message)
    if (this.print) {
      console.log(
        `\n──── email (not actually sent) ────\n`
        + `to:      ${message.to}\n`
        + `subject: ${message.subject}\n\n`
        + `${message.text}\n`
        + `───────────────────────────────────\n`,
      )
    }
    return { messageId: `console-${this.sent.length}`, accepted: true }
  }

  /** The most recent message to this address, which is what a test wants. */
  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase())
  }

  reset(): void {
    this.sent.length = 0
  }
}
