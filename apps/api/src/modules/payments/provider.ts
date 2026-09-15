/**
 * Payment provider port.
 *
 * The marketplace's money logic is written against this interface, not against
 * Stripe directly. Two reasons, both practical rather than architectural
 * purity:
 *
 *  1. It makes the settlement logic testable. Every branch that matters —
 *     declined card, expired authorization, failed transfer, partial refund,
 *     replayed webhook — can be exercised deterministically against a fake.
 *     Testing those against the live Stripe API is slow, flaky, and in some
 *     cases impossible to trigger on demand.
 *
 *  2. Marketplace payment providers change. Adyen and Stripe both move, and a
 *     rewrite that touches every settlement path is how marketplaces end up
 *     stuck with a provider they have outgrown.
 *
 * Amounts are always integer cents.
 */

export interface PaymentMethodRef {
  id: string
  brand?: string
  last4?: string
}

export interface ChargeParams {
  /** Provider-side customer id. */
  customerRef: string
  paymentMethodRef: string
  amountCents: number
  currency: string
  /** Prevents a retried request from charging twice. */
  idempotencyKey: string
  description?: string
  metadata?: Record<string, string>
}

export interface ChargeResult {
  paymentIntentId: string
  chargeId: string | null
  status: 'succeeded' | 'requires_action' | 'failed'
  failureCode?: string
  failureMessage?: string
}

export interface TransferParams {
  /** Connected account receiving the money. */
  destinationAccountRef: string
  amountCents: number
  currency: string
  idempotencyKey: string
  /** Links the transfer to the original charge for reconciliation. */
  sourceChargeId?: string
  metadata?: Record<string, string>
}

export interface TransferResult {
  transferId: string
  status: 'succeeded' | 'failed'
  failureMessage?: string
}

export interface RefundParams {
  paymentIntentId: string
  amountCents: number
  idempotencyKey: string
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent'
}

export interface RefundResult {
  refundId: string
  status: 'succeeded' | 'pending' | 'failed'
  failureMessage?: string
}

export interface PayoutParams {
  accountRef: string
  amountCents: number
  currency: string
  idempotencyKey: string
  instant: boolean
}

export interface PayoutResult {
  payoutId: string
  /**
   * Stripe's own payout states, all of them.
   *
   * `canceled` was missing, and an unchecked cast in the Stripe adapter let it
   * through anyway — where the caller's mapping filed it under "pending" and a
   * cancelled payout sat waiting for an arrival that was never coming.
   */
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled'
  arrivalDate?: Date
  failureMessage?: string
}

export interface ConnectedAccountStatus {
  accountRef: string
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsDue: string[]
}

export interface PaymentProvider {
  readonly name: string

  createCustomer(params: { email: string; name?: string; metadata?: Record<string, string> }): Promise<string>

  /** Saves a payment method for later off-session charging (Stripe SetupIntent). */
  createSetupIntent(customerRef: string): Promise<{ clientSecret: string; setupIntentId: string }>

  listPaymentMethods(customerRef: string): Promise<PaymentMethodRef[]>

  /** Charges immediately. Funds land in the platform balance, not the worker's. */
  charge(params: ChargeParams): Promise<ChargeResult>

  /** Moves money from the platform balance to a connected account. */
  transfer(params: TransferParams): Promise<TransferResult>

  refund(params: RefundParams): Promise<RefundResult>

  /** Onboarding link for a worker's connected account. */
  createConnectedAccount(params: { email: string; country: string }): Promise<string>
  createAccountOnboardingLink(accountRef: string, returnUrl: string, refreshUrl: string): Promise<string>
  getConnectedAccountStatus(accountRef: string): Promise<ConnectedAccountStatus>

  payout(params: PayoutParams): Promise<PayoutResult>

  /** Verifies a webhook signature and returns the parsed event. */
  verifyWebhook(rawBody: string | Buffer, signature: string, secret: string): Promise<{
    id: string
    type: string
    data: unknown
  }>
}
