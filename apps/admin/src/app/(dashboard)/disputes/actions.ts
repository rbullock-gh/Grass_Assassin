'use server'

import { revalidatePath } from 'next/cache'
import { requireAdminUser } from '@/lib/admin-user'

/**
 * Resolving a dispute.
 *
 * The decision is made here; the money is moved by the API. That split is
 * deliberate — the API is the only process holding the payment provider's
 * credentials, and a refund should be issuable from exactly one place. This
 * dashboard proves it is our dashboard with a service token, and names the
 * administrator who clicked the button. The API checks that person is really
 * an administrator rather than believing the header.
 */

export interface ResolveResult {
  ok: boolean
  error?: string
  summary?: string
}

const MIN_RESOLUTION = 20

export async function resolveDisputeAction(
  _previous: ResolveResult | null,
  form: FormData,
): Promise<ResolveResult> {
  // Throws rather than returning null: every path below records this person as
  // the actor, and there is no sensible value to record for "nobody".
  const admin = await requireAdminUser()

  const base = process.env.API_BASE_URL
  const token = process.env.ADMIN_SERVICE_TOKEN
  if (!base || !token) {
    return {
      ok: false,
      error: 'Resolving disputes needs API_BASE_URL and ADMIN_SERVICE_TOKEN set on this dashboard.',
    }
  }

  const disputeId = String(form.get('disputeId') ?? '')
  const decision = String(form.get('decision') ?? '')
  const resolution = String(form.get('resolution') ?? '').trim()
  const refundRaw = String(form.get('refundDollars') ?? '').trim()

  if (!['WORKER', 'CUSTOMER', 'SPLIT'].includes(decision)) {
    return { ok: false, error: 'Choose who this is resolved for.' }
  }
  // Checked here as well as at the API. The server is the authority, but a
  // person who has just typed three words should be told so before the request
  // goes anywhere, not after.
  if (resolution.length < MIN_RESOLUTION) {
    return {
      ok: false,
      error: `Explain the decision in at least ${MIN_RESOLUTION} characters — both people are told this.`,
    }
  }

  let refundCents: number | undefined
  if (decision === 'SPLIT') {
    const dollars = Number(refundRaw)
    if (!Number.isFinite(dollars) || dollars <= 0) {
      return { ok: false, error: 'A split needs a refund amount.' }
    }
    // Rounded once, here, so the number shown and the number sent agree.
    refundCents = Math.round(dollars * 100)
  }

  let response: Response
  try {
    response = await fetch(`${base.replace(/\/$/, '')}/v1/admin/disputes/${disputeId}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-token': token,
        'x-acting-admin-id': admin.id,
      },
      body: JSON.stringify({ decision, resolution, ...(refundCents ? { refundCents } : {}) }),
      cache: 'no-store',
    })
  } catch {
    // A dispute resolution that half-happened is worse than one that did not
    // start, so this says plainly that nothing was done.
    return { ok: false, error: 'Could not reach the API. Nothing was changed.' }
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message = body?.error?.message ?? `The API refused this (${response.status}).`
    return { ok: false, error: message }
  }

  const result = await response.json()
  revalidatePath('/disputes')
  return {
    ok: true,
    summary:
      `Refunded ${dollars(result.customerRefundCents)} to the customer, ` +
      `paid ${dollars(result.workerPaidCents)} to the worker.`,
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
