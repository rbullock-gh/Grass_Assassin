import { db } from '@/lib/db'
import { money, percent, relativeTime } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function WorkersPage() {
  const workers = await db.workerProfile.findMany({
    orderBy: [{ status: 'asc' }, { points: 'desc' }],
    take: 60,
    select: {
      id: true, status: true, points: true, completedJobs: true, cancelledJobs: true,
      averageRating: true, ratingCount: true, completionRate: true, onTimeRate: true,
      currentStreak: true, repeatCustomers: true, availableBalanceCents: true,
      lifetimeEarningsCents: true, payoutsEnabled: true, backgroundCheckStatus: true,
      serviceRadiusMiles: true, createdAt: true,
      user: { select: { firstName: true, email: true } },
      rank: { select: { name: true, verifiedBadge: true } },
    },
  })

  const pending = workers.filter((w) => w.status !== 'APPROVED')

  return (
    <>
      <div className="page-head">
        <h1>Workers</h1>
        <p>
          Rank requires points <em>and</em> a quality floor, so a high-volume, low-quality worker
          stalls rather than climbing. Reputation figures are recalculated from primary data,
          never incremented.
        </p>
      </div>

      {pending.length > 0 ? (
        <section className="panel" style={{ marginBottom: 18 }}>
          <div className="panel-head">
            <h2>Approval queue</h2>
            <span>{pending.length} awaiting review</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Worker</th><th>Status</th><th>Background check</th><th>Payouts</th><th>Joined</th></tr>
              </thead>
              <tbody>
                {pending.map((worker) => (
                  <tr key={worker.id}>
                    <td className="strong">{worker.user.firstName}<div className="muted" style={{ fontSize: 11.5 }}>{worker.user.email}</div></td>
                    <td><span className="pill warning">{worker.status.replace(/_/g, ' ').toLowerCase()}</span></td>
                    <td className="muted">{worker.backgroundCheckStatus.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="muted">{worker.payoutsEnabled ? 'Ready' : 'Not set up'}</td>
                    <td className="muted">{relativeTime(worker.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>All workers</h2>
          <span>{workers.length} shown</span>
        </div>
        <div className="table-wrap">
          {workers.length === 0 ? (
            <p className="empty">No workers yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Worker</th><th>Rank</th>
                  <th className="num">XP</th><th className="num">Jobs</th>
                  <th className="num">Rating</th><th className="num">Completion</th>
                  <th className="num">On time</th><th className="num">Balance</th>
                  <th className="num">Lifetime</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.id}>
                    <td className="strong">
                      {worker.user.firstName}
                      {worker.rank?.verifiedBadge ? <span className="pill success" style={{ marginLeft: 6 }}>Verified</span> : null}
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {worker.serviceRadiusMiles} mi radius · {worker.repeatCustomers} repeat
                      </div>
                    </td>
                    <td>{worker.rank ? <span className="rank-chip">{worker.rank.name}</span> : <span className="muted">—</span>}</td>
                    <td className="num strong">{worker.points.toLocaleString()}</td>
                    <td className="num">{worker.completedJobs}</td>
                    <td className="num">{worker.averageRating ? `★ ${worker.averageRating.toFixed(1)}` : <span className="muted">—</span>}</td>
                    <td className="num muted">{percent(worker.completionRate, 0)}</td>
                    <td className="num muted">{percent(worker.onTimeRate, 0)}</td>
                    <td className="num">{money(worker.availableBalanceCents)}</td>
                    <td className="num muted">{money(worker.lifetimeEarningsCents)}</td>
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
