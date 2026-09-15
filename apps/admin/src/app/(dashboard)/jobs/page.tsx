import { db } from '@/lib/db'
import { money, relativeTime, statusTone, titleCase, duration } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function JobsPage() {
  const [jobs, byStatus] = await Promise.all([
    db.job.findMany({
      where: { status: { not: 'DRAFT' } },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        id: true, title: true, status: true, priceCents: true, workerPayoutCents: true,
        generalArea: true, postedAt: true, claimedAt: true, dueAt: true, completedAt: true,
        difficulty: true, estimatedMinutes: true,
        category: { select: { name: true } },
        customer: { select: { firstName: true } },
      },
    }),
    db.job.groupBy({ by: ['status'], _count: true }),
  ])

  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count]))

  return (
    <>
      <div className="page-head">
        <h1>Jobs</h1>
        <p>
          Every lifecycle transition is recorded in an append-only audit trail, so a disputed job
          can be reconstructed from its entire history rather than its current state.
        </p>
      </div>

      <div className="stats">
        {['POSTED', 'CLAIMED', 'IN_PROGRESS', 'PENDING_APPROVAL', 'PAID', 'DISPUTED'].map((status) => (
          <div className="stat" key={status}>
            <span className="stat-label">{titleCase(status)}</span>
            <div className="stat-value">{counts[status] ?? 0}</div>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>All jobs</h2>
          <span>{jobs.length} shown</span>
        </div>
        <div className="table-wrap">
          {jobs.length === 0 ? (
            <p className="empty">No jobs yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Customer</th><th>Status</th>
                  <th className="num">Price</th><th className="num">Payout</th>
                  <th className="num">Est.</th><th>Due</th><th>Claimed</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="strong">
                      {job.title}
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {job.category.name} · {titleCase(job.difficulty)} · {job.generalArea}
                      </div>
                    </td>
                    <td className="muted">{job.customer.firstName}</td>
                    <td><span className={`pill ${statusTone(job.status)}`}>{titleCase(job.status)}</span></td>
                    <td className="num">{money(job.priceCents)}</td>
                    <td className="num muted">{money(job.workerPayoutCents)}</td>
                    <td className="num muted">{duration(job.estimatedMinutes)}</td>
                    <td className="muted">{relativeTime(job.dueAt)}</td>
                    <td className="muted">{job.claimedAt ? relativeTime(job.claimedAt) : <span className="muted">unclaimed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  )
}
