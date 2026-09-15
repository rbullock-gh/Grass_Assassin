'use client'

import { useActionState, useState } from 'react'
import { resolveDisputeAction, type ResolveResult } from './actions'

const MIN_RESOLUTION = 20

/**
 * The decision form for one dispute.
 *
 * Shows the money consequence of each choice before it is made. The costly
 * mistake on this screen is not a typo — it is not realising that "resolve for
 * the customer" means the worker who spent two hours on a lawn is paid nothing.
 * Both outcomes are spelled out in dollars next to the option that causes them.
 *
 * Every field is controlled, deliberately. React resets a form after a form
 * action runs, and an uncontrolled textarea here meant that a rejected
 * submission silently erased the paragraph an administrator had just written
 * explaining why they were taking someone's money away. Holding the values in
 * state is what makes a rejection recoverable instead of infuriating.
 */
export function ResolveForm({ disputeId, customerPaidCents, workerPayoutCents }: {
  disputeId: string
  customerPaidCents: number
  workerPayoutCents: number
}) {
  const [result, action, pending] = useActionState<ResolveResult | null, FormData>(
    resolveDisputeAction, null,
  )
  const [decision, setDecision] = useState('')
  const [refund, setRefund] = useState('')
  const [reason, setReason] = useState('')

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

  // What a split would actually pay out, updated as they type, because the
  // worker's share is proportional to the part of the job that stands rather
  // than to the gross.
  const refundCents = Math.round(Number(refund) * 100)
  const splitValid = refund.trim() !== '' && Number.isFinite(refundCents)
    && refundCents > 0 && refundCents < customerPaidCents
  const workerUnderSplit = splitValid
    ? Math.min(
        workerPayoutCents,
        Math.round(workerPayoutCents * ((customerPaidCents - refundCents) / customerPaidCents)),
      )
    : null

  // Checked here as well as on the server. Not as a substitute — the server is
  // the authority — but so that the common mistakes are caught before a round
  // trip, which is what keeps a rejection rare enough to be worth reading.
  const missing = !decision
    ? 'Choose who this is resolved for.'
    : decision === 'SPLIT' && !splitValid
      ? `Enter a refund between $0.01 and ${money(customerPaidCents - 1)}.`
      : reason.trim().length < MIN_RESOLUTION
        ? `Explain the decision — ${MIN_RESOLUTION - reason.trim().length} more character${
            MIN_RESOLUTION - reason.trim().length === 1 ? '' : 's'}.`
        : null

  // No success branch. A successful resolution revalidates the page, the
  // dispute is no longer open, and this form is replaced by the outcome read
  // back from the database — which is a more trustworthy thing to show than a
  // message held in client state saying what we asked for.

  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="disputeId" value={disputeId} />

      <fieldset>
        <legend>Decision</legend>
        {([
          ['WORKER', 'For the worker', `Worker paid ${money(workerPayoutCents)} · customer refunded nothing`],
          ['CUSTOMER', 'For the customer', `Customer refunded ${money(customerPaidCents)} · worker paid nothing`],
          ['SPLIT', 'Split it', `Refund part of ${money(customerPaidCents)}; the worker is paid for the rest`],
        ] as const).map(([value, title, consequence]) => (
          <label key={value} className={decision === value ? 'choice selected' : 'choice'}>
            <input
              type="radio" name="decision" value={value}
              checked={decision === value} onChange={() => setDecision(value)}
            />
            <span>
              <strong>{title}</strong>
              <em>{consequence}</em>
            </span>
          </label>
        ))}
      </fieldset>

      {decision === 'SPLIT' ? (
        <div className="resolve-split">
          <label htmlFor={`refund-${disputeId}`}>Refund to the customer</label>
          <div className="resolve-amount">
            <span aria-hidden>$</span>
            <input
              id={`refund-${disputeId}`} name="refundDollars" inputMode="decimal"
              value={refund} onChange={(e) => setRefund(e.target.value)}
              placeholder="0.00" autoComplete="off"
            />
          </div>
          <p className="muted">
            {workerUnderSplit === null
              ? `Between $0.01 and ${money(customerPaidCents - 1)}.`
              : `The worker is paid ${money(workerUnderSplit)}.`}
          </p>
        </div>
      ) : null}

      <label htmlFor={`why-${disputeId}`}>What you decided, and why</label>
      <textarea
        id={`why-${disputeId}`} name="resolution" rows={3}
        value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="Both people are shown this, and it is the record if the decision is questioned later."
      />

      {result?.error ? <p className="resolve-error">{result.error}</p> : null}

      <div className="resolve-submit">
        <button type="submit" disabled={pending || missing !== null}>
          {pending ? 'Resolving…' : 'Resolve and settle'}
        </button>
        {missing ? <span className="muted">{missing}</span> : null}
      </div>
    </form>
  )
}
