import Stripe from 'stripe'
import type {
  PaymentProvider, ChargeParams, ChargeResult, TransferParams, TransferResult,
  RefundParams, RefundResult, PayoutParams, PayoutResult, PaymentMethodRef, ConnectedAccountStatus,
} from './provider.js'

/**
 * Stripe Connect adapter.
 *
 * ⚠️  UNVERIFIED AGAINST THE LIVE API.
 *
 * This implements the PaymentProvider port against Stripe's SDK, but no call in
 * this file has been executed — the development environment has no Stripe
 * credentials. The settlement logic that USES this port is thoroughly tested
 * against FakePaymentProvider; what remains unverified is this adapter's own
 * fidelity to Stripe's API shape. Before launch it must be exercised against
 * Stripe test mode, specifically: a successful charge, a declined card
 * (4000 0000 0000 0002), a disputed charge (4000 0000 0000 0259), a transfer to
 * a restricted account, a partial refund, and a replayed webhook.
 *
 * Design notes that are not obvious from the SDK:
 *
 * · SEPARATE CHARGES AND TRANSFERS, not destination charges. The customer is
 *   charged at claim and the worker is paid at approval — potentially days
 *   apart — so the two must be independent operations. A destination charge
 *   would settle both at once and make our escrow period impossible.
 *
 * · off_session: true with confirm: true on the PaymentIntent, because the
 *   customer is not present when a worker claims their job. This requires the
 *   payment method to have been saved earlier with a SetupIntent carrying
 *   usage: 'off_session', or the charge fails with authentication_required.
 *
 * · Idempotency keys are passed to Stripe as well as being checked in our own
 *   database. Ours prevents a duplicate row; Stripe's prevents a duplicate
 *   charge if we crash between calling Stripe and committing our transaction.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe'
  private readonly stripe: Stripe

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, {
      // Pin the version. An unpinned integration breaks when Stripe ships a
      // change, at a time nobody chose.
      apiVersion: '2025-08-27.basil' as Stripe.LatestApiVersion,
      typescript: true,
      maxNetworkRetries: 2,
    })
  }

  async createCustomer(params: { email: string; name?: string; metadata?: Record<string, string> }): Promise<string> {
    const customer = await this.stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata ?? {},
    })
    return customer.id
  }

  async createSetupIntent(customerRef: string): Promise<{ clientSecret: string; setupIntentId: string }> {
    const intent = await this.stripe.setupIntents.create({
      customer: customerRef,
      payment_method_types: ['card'],
      // Required so the saved method can be charged later, when the customer is
      // not in the app and a worker has just claimed their job.
      usage: 'off_session',
    })
    if (!intent.client_secret) throw new Error('Stripe returned a SetupIntent with no client secret')
    return { clientSecret: intent.client_secret, setupIntentId: intent.id }
  }

  async listPaymentMethods(customerRef: string): Promise<PaymentMethodRef[]> {
    const methods = await this.stripe.paymentMethods.list({ customer: customerRef, type: 'card' })
    return methods.data.map((m) => ({
      id: m.id,
      brand: m.card?.brand,
      last4: m.card?.last4,
    }))
  }

  async charge(params: ChargeParams): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          customer: params.customerRef,
          payment_method: params.paymentMethodRef,
          amount: params.amountCents,
          currency: params.currency,
          confirm: true,
          off_session: true,
          description: params.description,
          metadata: params.metadata ?? {},
        },
        { idempotencyKey: params.idempotencyKey },
      )

      const chargeId = typeof intent.latest_charge === 'string'
        ? intent.latest_charge
        : intent.latest_charge?.id ?? null

      if (intent.status === 'succeeded') {
        return { paymentIntentId: intent.id, chargeId, status: 'succeeded' }
      }
      // requires_action means the card wants 3DS. Off-session we cannot prompt,
      // so the caller must release the claim and tell the customer to re-auth.
      return {
        paymentIntentId: intent.id,
        chargeId,
        status: intent.status === 'requires_action' ? 'requires_action' : 'failed',
        failureCode: intent.last_payment_error?.code,
        failureMessage: intent.last_payment_error?.message,
      }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeCardError) {
        return {
          paymentIntentId: error.payment_intent?.id ?? '',
          chargeId: null,
          status: 'failed',
          failureCode: error.code ?? 'card_error',
          failureMessage: error.message,
        }
      }
      throw error
    }
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    try {
      const transfer = await this.stripe.transfers.create(
        {
          destination: params.destinationAccountRef,
          amount: params.amountCents,
          currency: params.currency,
          source_transaction: params.sourceChargeId,
          metadata: params.metadata ?? {},
        },
        { idempotencyKey: params.idempotencyKey },
      )
      return { transferId: transfer.id, status: 'succeeded' }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        return { transferId: '', status: 'failed', failureMessage: error.message }
      }
      throw error
    }
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: params.paymentIntentId,
          amount: params.amountCents,
          reason: params.reason,
        },
        { idempotencyKey: params.idempotencyKey },
      )
      return {
        refundId: refund.id,
        status: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'pending' ? 'pending' : 'failed',
      }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        return { refundId: '', status: 'failed', failureMessage: error.message }
      }
      throw error
    }
  }

  async createConnectedAccount(params: { email: string; country: string }): Promise<string> {
    const account = await this.stripe.accounts.create({
      type: 'express',
      email: params.email,
      country: params.country,
      capabilities: {
        transfers: { requested: true },
      },
      business_type: 'individual',
      settings: {
        payouts: {
          // Workers expect money on a predictable cadence; daily is the
          // strongest retention lever Stripe gives us for free.
          schedule: { interval: 'daily', delay_days: 2 },
        },
      },
    })
    return account.id
  }

  async createAccountOnboardingLink(accountRef: string, returnUrl: string, refreshUrl: string): Promise<string> {
    const link = await this.stripe.accountLinks.create({
      account: accountRef,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: 'account_onboarding',
    })
    return link.url
  }

  async getConnectedAccountStatus(accountRef: string): Promise<ConnectedAccountStatus> {
    const account = await this.stripe.accounts.retrieve(accountRef)
    return {
      accountRef: account.id,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      detailsSubmitted: account.details_submitted ?? false,
      requirementsDue: account.requirements?.currently_due ?? [],
    }
  }

  async payout(params: PayoutParams): Promise<PayoutResult> {
    try {
      const payout = await this.stripe.payouts.create(
        {
          amount: params.amountCents,
          currency: params.currency,
          method: params.instant ? 'instant' : 'standard',
        },
        { idempotencyKey: params.idempotencyKey, stripeAccount: params.accountRef },
      )
      return {
        payoutId: payout.id,
        status: payout.status as PayoutResult['status'],
        arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : undefined,
      }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        return { payoutId: '', status: 'failed', failureMessage: error.message }
      }
      throw error
    }
  }

  /**
   * Verifies the webhook signature.
   *
   * MUST receive the raw request body, not a parsed object — Stripe signs the
   * exact bytes, and any JSON round-trip invalidates the signature. The Fastify
   * route for this endpoint therefore disables the default JSON body parser.
   */
  async verifyWebhook(rawBody: string | Buffer, signature: string, secret: string): Promise<{
    id: string
    type: string
    data: unknown
  }> {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, secret)
    return { id: event.id, type: event.type, data: event.data }
  }
}
