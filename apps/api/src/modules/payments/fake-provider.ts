import type {
  PaymentProvider, ChargeParams, ChargeResult, TransferParams, TransferResult,
  RefundParams, RefundResult, PayoutParams, PayoutResult, PaymentMethodRef, ConnectedAccountStatus,
} from './provider.js'

/**
 * In-memory payment provider for tests.
 *
 * This is not a stub that returns success. It models the parts of Stripe's
 * behaviour that our settlement logic actually depends on:
 *
 *  · Idempotency keys really are idempotent — replaying a key returns the
 *    original result rather than performing the operation twice. Most
 *    double-charge bugs only appear when this is modelled honestly.
 *  · Failures can be injected per-operation, so declined cards, failed
 *    transfers and pending refunds are all reachable in a test.
 *  · Refunds are tracked against their charge and cannot exceed it.
 *
 * The real Stripe adapter implements the same interface. What THIS verifies is
 * our settlement logic; the adapter's own fidelity to Stripe's API is verified
 * separately against Stripe test mode, which cannot run in this environment.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake'

  private counter = 0
  private readonly idempotencyCache = new Map<string, unknown>()
  private readonly charges = new Map<string, { amountCents: number; refundedCents: number }>()
  private readonly customers = new Set<string>()
  private readonly accounts = new Map<string, ConnectedAccountStatus>()

  /** Failure injection. Set a key to make the matching operation fail. */
  failures: {
    chargeFor?: Set<string>
    transferFor?: Set<string>
    refundPending?: boolean
    nextChargeFailure?: { code: string; message: string }
  } = {}

  /** Every call made, for asserting on call counts (e.g. "charged exactly once"). */
  readonly calls: Array<{ op: string; key?: string; amountCents?: number }> = []

  private id(prefix: string): string {
    this.counter += 1
    return `${prefix}_${this.counter.toString().padStart(6, '0')}`
  }

  private cached<T>(key: string | undefined, compute: () => T): T {
    if (!key) return compute()
    if (this.idempotencyCache.has(key)) return this.idempotencyCache.get(key) as T
    const value = compute()
    this.idempotencyCache.set(key, value)
    return value
  }

  async createCustomer(_params: { email: string }): Promise<string> {
    const ref = this.id('cus')
    this.customers.add(ref)
    this.calls.push({ op: 'createCustomer' })
    return ref
  }

  async createSetupIntent(_customerRef: string): Promise<{ clientSecret: string; setupIntentId: string }> {
    const setupIntentId = this.id('seti')
    this.calls.push({ op: 'createSetupIntent' })
    return { clientSecret: `${setupIntentId}_secret`, setupIntentId }
  }

  async listPaymentMethods(_customerRef: string): Promise<PaymentMethodRef[]> {
    return [{ id: 'pm_test_visa', brand: 'visa', last4: '4242' }]
  }

  async charge(params: ChargeParams): Promise<ChargeResult> {
    this.calls.push({ op: 'charge', key: params.idempotencyKey, amountCents: params.amountCents })

    return this.cached(params.idempotencyKey, (): ChargeResult => {
      const injected = this.failures.nextChargeFailure
      if (injected) {
        // One-shot: injecting a failure must not make every later charge fail,
        // or a test that exercises recovery silently tests nothing.
        delete this.failures.nextChargeFailure
        return {
          paymentIntentId: this.id('pi'),
          chargeId: null,
          status: 'failed',
          failureCode: injected.code,
          failureMessage: injected.message,
        }
      }

      if (this.failures.chargeFor?.has(params.paymentMethodRef)) {
        return {
          paymentIntentId: this.id('pi'),
          chargeId: null,
          status: 'failed',
          failureCode: 'card_declined',
          failureMessage: 'Your card was declined.',
        }
      }

      const chargeId = this.id('ch')
      this.charges.set(chargeId, { amountCents: params.amountCents, refundedCents: 0 })
      return { paymentIntentId: this.id('pi'), chargeId, status: 'succeeded' }
    })
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.calls.push({ op: 'transfer', key: params.idempotencyKey, amountCents: params.amountCents })

    return this.cached(params.idempotencyKey, (): TransferResult => {
      if (this.failures.transferFor?.has(params.destinationAccountRef)) {
        return {
          transferId: '',
          status: 'failed',
          failureMessage: 'The destination account cannot receive transfers.',
        }
      }
      return { transferId: this.id('tr'), status: 'succeeded' }
    })
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    this.calls.push({ op: 'refund', key: params.idempotencyKey, amountCents: params.amountCents })

    return this.cached(params.idempotencyKey, (): RefundResult => {
      if (this.failures.refundPending) {
        return { refundId: this.id('re'), status: 'pending' }
      }
      return { refundId: this.id('re'), status: 'succeeded' }
    })
  }

  async createConnectedAccount(_params: { email: string; country: string }): Promise<string> {
    const ref = this.id('acct')
    this.accounts.set(ref, {
      accountRef: ref,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsDue: ['individual.verification.document'],
    })
    this.calls.push({ op: 'createConnectedAccount' })
    return ref
  }

  async createAccountOnboardingLink(accountRef: string, _returnUrl: string): Promise<string> {
    return `https://connect.example.test/onboard/${accountRef}`
  }

  async getConnectedAccountStatus(accountRef: string): Promise<ConnectedAccountStatus> {
    return this.accounts.get(accountRef) ?? {
      accountRef, chargesEnabled: false, payoutsEnabled: false,
      detailsSubmitted: false, requirementsDue: ['unknown_account'],
    }
  }

  /** Test helper: mark a connected account as fully onboarded. */
  completeOnboarding(accountRef: string): void {
    this.accounts.set(accountRef, {
      accountRef, chargesEnabled: true, payoutsEnabled: true,
      detailsSubmitted: true, requirementsDue: [],
    })
  }

  async payout(params: PayoutParams): Promise<PayoutResult> {
    this.calls.push({ op: 'payout', key: params.idempotencyKey, amountCents: params.amountCents })
    return this.cached(params.idempotencyKey, (): PayoutResult => ({
      payoutId: this.id('po'),
      status: params.instant ? 'paid' : 'in_transit',
      arrivalDate: new Date(Date.now() + (params.instant ? 0 : 2 * 86_400_000)),
    }))
  }

  async verifyWebhook(rawBody: string | Buffer, signature: string): Promise<{ id: string; type: string; data: unknown }> {
    if (signature !== 'valid-test-signature') {
      throw new Error('Webhook signature verification failed')
    }
    return JSON.parse(rawBody.toString()) as { id: string; type: string; data: unknown }
  }

  // --- assertions used by tests -------------------------------------------

  callsTo(op: string): number {
    return this.calls.filter((c) => c.op === op).length
  }

  reset(): void {
    this.counter = 0
    this.idempotencyCache.clear()
    this.charges.clear()
    this.accounts.clear()
    this.calls.length = 0
    this.failures = {}
  }
}
