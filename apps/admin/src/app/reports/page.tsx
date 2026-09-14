import { db } from '@/lib/db'
import { relativeTime, titleCase } from '@/lib/format'

export const dynamic = 'force-dynamic'

/**
 * User reports and account moderation.
 *
 * Reports are about safety between strangers on private property, so the queue
 * leads with what is unresolved and how long it has been waiting. A report
 * sitting for two days is the number that matters, not the total.
 */
export default async function ReportsPage() {
  const [reports, suspended, blocks] = await Promise.all([
    db.report.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 60,
      select: {
        id: true, category: true, description: true, status: true,
        createdAt: true, reviewedAt: true, action: true,
        reporter: { select: { firstName: true, email: true } },
        subject: {
          select: {
            firstName: true, email: true, status: true,
            workerProfile: { select: { completedJobs: true, averageRating: true } },
          },
        },
      },
    }),
    db.user.findMany({
      where: { status: { in: ['SUSPENDED', 'BANNED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: {
        id: true, firstName: true, email: true, status: true,
        suspendedUntil: true, suspensionReason: true, updatedAt: true,
      },
    }),
    db.userBlock.count(),
  ])

  const openReports = reports.filter((r) => r.status === 'OPEN' || r.status === 'REVIEWING')
  const oldestOpen = openReports.length > 0
    ? openReports.reduce((oldest, r) => (r.createdAt < oldest ? r.createdAt : oldest), openReports[0]!.createdAt)
    : null

  return (
    <>
      <div className="page-head">
        <h1>Reports &amp; moderation</h1>
        <p>
          These are about safety between strangers on private property. The number that matters is
          how long the oldest one has been waiting, not how many there are.
        </p>
      </div>

      <div className="stats">
        <div className={openReports.length > 0 ? 'stat alert' : 'stat ok-badge'}>
          <span className="stat-label">Open reports</span>
          <div className="stat-value">{openReports.length}</div>
          <div className="stat-sub">
            {oldestOpen ? `Oldest ${relativeTime(oldestOpen)}` : 'Queue is clear'}
          </div>
        </div>
        <div className="stat">
          <span className="stat-label">Suspended</span>
          <div className="stat-value">{suspended.length}</div>
          <div className="stat-sub">Accounts restricted</div>
        </div>
        <div className="stat">
          <span className="stat-label">User blocks</span>
          <div className="stat-value">{blocks}</div>
          <div className="stat-sub">People who chose not to match again</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Reports</h2>
          <span>{reports.length} shown</span>
        </div>
        <div className="table-wrap">
          {reports.length === 0 ? (
            <p className="empty">No reports.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Reported</th><th>Category</th><th>Detail</th>
                  <th>By</th><th>Status</th><th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td className="strong">
                      {report.subject.firstName}
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {report.subject.workerProfile
                          ? `${report.subject.workerProfile.completedJobs} jobs · ${
                              report.subject.workerProfile.averageRating
                                ? `★ ${report.subject.workerProfile.averageRating.toFixed(1)}`
                                : 'unrated'}`
                          : 'Customer'}
                      </div>
                    </td>
                    <td>{titleCase(report.category)}</td>
                    <td className="muted wrap-any" style={{ fontSize: 12, maxWidth: 320 }}>
                      {report.description}
                    </td>
                    <td className="muted">{report.reporter.firstName}</td>
                    <td>
                      <span className={`pill ${
                        report.status === 'OPEN' ? 'danger'
                          : report.status === 'REVIEWING' ? 'warning'
                          : report.status === 'ACTIONED' ? 'success' : 'neutral'
                      }`}>{titleCase(report.status)}</span>
                    </td>
                    <td className="muted">{relativeTime(report.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h2>Restricted accounts</h2>
          <span>Suspensions lift automatically when they expire</span>
        </div>
        <div className="table-wrap">
          {suspended.length === 0 ? (
            <p className="empty">No restricted accounts.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Account</th><th>Status</th><th>Reason</th><th>Until</th></tr>
              </thead>
              <tbody>
                {suspended.map((user) => (
                  <tr key={user.id}>
                    <td className="strong">{user.firstName}
                      <div className="muted" style={{ fontSize: 11.5 }}>{user.email}</div>
                    </td>
                    <td>
                      <span className={`pill ${user.status === 'BANNED' ? 'danger' : 'warning'}`}>
                        {titleCase(user.status)}
                      </span>
                    </td>
                    <td className="muted">{user.suspensionReason ?? '—'}</td>
                    <td className="muted">
                      {user.status === 'BANNED'
                        ? 'Permanent'
                        : user.suspendedUntil
                          ? relativeTime(user.suspendedUntil)
                          : 'Indefinite'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <p className="note">
        A lapsed suspension restores itself on the account&rsquo;s next sign-in. Making someone contact
        support to undo something that already expired is a penalty nobody decided to impose.
      </p>
    </>
  )
}
