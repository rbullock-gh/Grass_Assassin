import { Fragment } from 'react'
import { db } from '@/lib/db'
import { money, relativeTime, titleCase } from '@/lib/format'
import { ResolveForm } from './resolve-form'

export const dynamic = 'force-dynamic'

/**
 * Disputes and fraud signals.
 *
 * Both are deliberately HUMAN queues. Nothing here resolves automatically: an
 * irreversible automated decision on a false positive costs a worker their
 * income, and the evidence that settles a dispute — geofenced check-in
 * timestamps, before/after photos, the chat transcript — needs a person to
 * weigh it.
 */
export default async function DisputesPage() {
  const [disputes, flags, evidenceCounts] = await Promise.all([
    db.dispute.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 50,
      select: {
        id: true, reason: true, description: true, status: true,
        refundCents: true, createdAt: true, resolvedAt: true, resolution: true,
        job: {
          select: {
            id: true, title: true, priceCents: true, generalArea: true,
            claimedByWorkerId: true, completedAt: true, startedAt: true,
            customerTotalCents: true, workerPayoutCents: true,
            customer: { select: { firstName: true } },
          },
        },
      },
    }),
    db.fraudFlag.findMany({
      where: { dismissed: false, reviewedAt: null },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: { id: true, signal: true, severity: true, jobId: true, userId: true, details: true, createdAt: true },
    }),
    db.jobPhoto.groupBy({ by: ['jobId'], _count: true }),
  ])

  // What was actually paid out is recorded in the audit entry, not on the
  // dispute row — on a split the worker's share is proportional and the job's
  // stored payout is the pre-dispute figure, so showing that would be wrong.
  const settlements = await db.auditLog.findMany({
    where: { action: 'dispute.resolved', entityId: { in: disputes.map((d) => d.id) } },
    select: { entityId: true, after: true, actor: { select: { firstName: true, lastName: true } } },
  })
  const settledBy = new Map(settlements.map((s) => [s.entityId, s]))

  const photosByJob = new Map(evidenceCounts.map((e) => [e.jobId, e._count]))
  const open = disputes.filter((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW')

  return (
    <>
      <div className="page-head">
        <h1>Disputes &amp; flags</h1>
        <p>
          Human queues by design. An irreversible automated decision on a false positive costs a
          worker their income, so nothing here resolves itself.
        </p>
      </div>

      <div className="stats">
        <div className={open.length > 0 ? 'stat alert' : 'stat ok-badge'}>
          <span className="stat-label">Open disputes</span>
          <div className="stat-value">{open.length}</div>
          <div className="stat-sub">{open.length === 0 ? 'Nothing waiting' : 'Awaiting a decision'}</div>
        </div>
        <div className={flags.length > 0 ? 'stat' : 'stat ok-badge'}>
          <span className="stat-label">Unreviewed flags</span>
          <div className="stat-value">{flags.length}</div>
          <div className="stat-sub">Surfaced, never auto-actioned</div>
        </div>
        <div className="stat">
          <span className="stat-label">Resolved</span>
          <div className="stat-value">{disputes.length - open.length}</div>
          <div className="stat-sub">Of the {disputes.length} shown</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Disputes</h2>
          <span>Evidence strength shown per job</span>
        </div>
        <div className="table-wrap">
          {disputes.length === 0 ? (
            <p className="empty">No disputes. That is the number to keep.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Reason</th><th>Status</th>
                  <th className="num">Value</th><th>Evidence</th><th>Opened</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((dispute) => {
                  const photos = photosByJob.get(dispute.job.id) ?? 0
                  const geofenced = dispute.job.startedAt !== null
                  const row = (
                    <tr>
                      <td className="strong">
                        {dispute.job.title}
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {dispute.job.customer.firstName} · {dispute.job.generalArea}
                        </div>
                      </td>
                      <td>
                        {titleCase(dispute.reason)}
                        <div className="muted wrap-any" style={{ fontSize: 11.5, maxWidth: 280 }}>
                          {dispute.description}
                        </div>
                      </td>
                      <td>
                        <span className={`pill ${
                          dispute.status === 'OPEN' ? 'danger'
                            : dispute.status === 'UNDER_REVIEW' ? 'warning' : 'success'
                        }`}>{titleCase(dispute.status)}</span>
                      </td>
                      <td className="num">{money(dispute.job.priceCents)}</td>
                      <td>
                        {/* The evidence package, at a glance. A dispute with
                            photos and a geofenced start is answerable; one
                            without is a judgement call. */}
                        <span className={`pill ${photos >= 2 && geofenced ? 'success' : photos > 0 || geofenced ? 'warning' : 'danger'}`}>
                          {photos === 0 && !geofenced
                            ? 'None'
                            : `${photos} photo${photos === 1 ? '' : 's'}${geofenced ? ' · on site' : ''}`}
                        </span>
                      </td>
                      <td className="muted">{relativeTime(dispute.createdAt)}</td>
                    </tr>
                  )
                  const decidable = dispute.status === 'OPEN' || dispute.status === 'UNDER_REVIEW'
                  return (
                    <Fragment key={dispute.id}>
                      {row}
                      {decidable ? (
                        <tr className="resolve-row">
                          {/* The decision sits directly under the evidence it
                              is based on. A separate screen would mean deciding
                              from memory. */}
                          <td colSpan={6}>
                            <ResolveForm
                              disputeId={dispute.id}
                              customerPaidCents={dispute.job.customerTotalCents}
                              workerPayoutCents={dispute.job.workerPayoutCents}
                            />
                          </td>
                        </tr>
                      ) : dispute.resolution ? (
                        <tr className="resolve-row">
                          <td colSpan={6}>
                            <p className="resolved-note" data-dispute={dispute.id}>
                              <strong>{titleCase(dispute.status)}</strong>
                              {settlementSummary(settledBy.get(dispute.id))}
                              {' — '}{dispute.resolution}
                            </p>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h2>Fraud &amp; abuse signals</h2>
          <span>Surfaced for review</span>
        </div>
        <div className="table-wrap">
          {flags.length === 0 ? (
            <p className="empty">No unreviewed signals.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Signal</th><th>Severity</th><th>Subject</th><th>Detail</th><th>Raised</th></tr>
              </thead>
              <tbody>
                {flags.map((flag) => (
                  <tr key={flag.id}>
                    <td className="strong">{titleCase(flag.signal)}</td>
                    <td>
                      <span className={`pill ${flag.severity >= 4 ? 'danger' : flag.severity >= 2 ? 'warning' : 'neutral'}`}>
                        {flag.severity} / 5
                      </span>
                    </td>
                    <td className="muted mono-cell" style={{ maxWidth: 180 }}>
                      {flag.jobId ?? flag.userId ?? '—'}
                    </td>
                    <td className="muted wrap-any" style={{ fontSize: 12, maxWidth: 320 }}>
                      {flag.details ? JSON.stringify(flag.details) : '—'}
                    </td>
                    <td className="muted">{relativeTime(flag.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <p className="note">
        A chargeback raises a severity-5 flag automatically, but never suspends anyone. The worker
        keeps working while a person reviews the evidence.
      </p>
    </>
  )
}

interface SettlementRow {
  after: unknown
  actor: { firstName: string; lastName: string | null } | null
}

/**
 * What the resolution actually did, in money and by whom.
 *
 * Read from the audit entry rather than recomputed here, so the page cannot
 * drift from the record. A dashboard that shows a number it worked out itself
 * is exactly as trustworthy as the arithmetic nobody checked.
 */
function settlementSummary(row: SettlementRow | undefined): string {
  if (!row) return ''
  const after = row.after as Record<string, unknown> | null
  if (!after) return ''

  const refund = Number(after.customerRefundCents)
  const paid = Number(after.workerPaidCents)
  if (!Number.isFinite(refund) || !Number.isFinite(paid)) return ''

  const who = row.actor ? ` by ${row.actor.firstName}${row.actor.lastName ? ` ${row.actor.lastName}` : ''}` : ''
  // Only the movements that happened. "Refunded $0.00" is true but reads like
  // something went wrong, and on this page that costs a second look every time.
  const moves = [
    refund > 0 ? `refunded ${money(refund)}` : null,
    paid > 0 ? `worker paid ${money(paid)}` : null,
  ].filter(Boolean)
  if (moves.length === 0) return ` · no money moved${who}`
  return ` · ${moves.join(', ')}${who}`
}
