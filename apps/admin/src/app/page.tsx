import { loadMetrics, loadRecentJobs, loadTopWorkers, loadJobTrend } from '@/lib/metrics'
import { money, moneyCompact, percent, relativeTime, duration, statusTone, titleCase } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const [metrics, recentJobs, topWorkers, trend] = await Promise.all([
    loadMetrics(), loadRecentJobs(10), loadTopWorkers(6), loadJobTrend(14),
  ])

  const peak = Math.max(1, ...trend.map((d) => Math.max(d.posted, d.completed)))
  const ledgerHealthy = metrics.ledgerDeltaCents === 0

  return (
    <>
      <div className="page-head">
        <h1>Marketplace overview</h1>
        <p>
          Every figure is computed from primary data rather than a stored counter, so this page
          cannot drift away from what actually happened.
        </p>
      </div>

      <div className="stats">
        <Stat label="Gross volume" value={moneyCompact(metrics.grossMarketplaceVolumeCents)}
              sub={`${metrics.jobsCompleted} completed jobs`} />
        <Stat label="Platform revenue" value={moneyCompact(metrics.platformRevenueCents)}
              sub="Commission + service fees" />
        <Stat label="Open jobs" value={String(metrics.jobsOpen)}
              sub={`${metrics.jobsPosted} posted all time`} />
        <Stat label="Avg job price" value={money(metrics.averageJobPriceCents)} sub="Completed jobs" />
        <Stat label="Time to claim" value={metrics.averageMinutesToClaim === null ? '—' : duration(metrics.averageMinutesToClaim)}
              sub="Median over 30 days" />
        <Stat label="Claim rate" value={percent(metrics.claimRate, 0)}
              sub={`${percent(metrics.completionRate, 0)} completed`} />
        <Stat label="Active workers" value={String(metrics.activeWorkers)}
              sub={`${metrics.activeCustomers} customers`} />
        <Stat
          label="Ledger balance"
          value={ledgerHealthy ? 'Balanced' : money(metrics.ledgerDeltaCents)}
          sub={ledgerHealthy ? 'Every cent accounted for' : 'INVESTIGATE IMMEDIATELY'}
          tone={ledgerHealthy ? 'ok' : 'alert'}
        />
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Recent jobs</h2>
            <span>{recentJobs.length} most recent</span>
          </div>
          <div className="table-wrap">
            {recentJobs.length === 0 ? (
              <p className="empty">No jobs yet. Run the seed to populate a demo marketplace.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Job</th><th>Status</th><th>Area</th>
                    <th className="num">Price</th><th className="num">Payout</th><th>Posted</th>
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((job) => (
                    <tr key={job.id}>
                      <td className="strong">
                        {job.title}
                        <div className="muted" style={{ fontSize: 11.5 }}>{job.category.name}</div>
                      </td>
                      <td><span className={`pill ${statusTone(job.status)}`}>{titleCase(job.status)}</span></td>
                      <td className="muted">{job.generalArea}</td>
                      <td className="num">{money(job.priceCents)}</td>
                      <td className="num muted">{money(job.workerPayoutCents)}</td>
                      <td className="muted">{relativeTime(job.postedAt ?? job.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <div style={{ display: 'grid', gap: 18 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>Activity</h2>
              <span>Last 14 days</span>
            </div>
            <div className="panel-body">
              <div className="chart" role="img"
                   aria-label={`Jobs posted and completed over the last 14 days. Peak ${peak} in a day.`}>
                {trend.map((day) => (
                  <div className="chart-col" key={day.day.toISOString()}>
                    <div className="chart-bar posted"
                         style={{ height: `${(day.posted / peak) * 100}%` }} />
                    <div className="chart-bar completed"
                         style={{ height: `${(day.completed / peak) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="chart-axis">
                {trend.map((day, i) => (
                  <span key={day.day.toISOString()}>
                    {i % 3 === 0 ? new Date(day.day).getDate() : ''}
                  </span>
                ))}
              </div>
              <div className="legend">
                <span><i style={{ background: 'var(--brand-bright)' }} />Posted</span>
                <span><i style={{ background: 'var(--brand)' }} />Completed</span>
                <span className="muted tnum">peak {peak}/day</span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Leaderboard</h2>
              <span>All time</span>
            </div>
            <div className="table-wrap">
              {topWorkers.length === 0 ? (
                <p className="empty">No approved workers yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>#</th><th>Worker</th><th className="num">XP</th><th className="num">Jobs</th></tr>
                  </thead>
                  <tbody>
                    {topWorkers.map((worker, index) => (
                      <tr key={worker.id}>
                        <td className="muted tnum">{index + 1}</td>
                        <td>
                          <span className="strong">{worker.user.firstName}</span>
                          {worker.rank ? <span className="rank-chip" style={{ marginLeft: 7 }}>{worker.rank.name}</span> : null}
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {worker.averageRating ? `★ ${worker.averageRating.toFixed(1)}` : 'Unrated'}
                            {' · '}{percent(worker.completionRate, 0)} completion
                          </div>
                        </td>
                        <td className="num strong">{worker.points.toLocaleString()}</td>
                        <td className="num muted">{worker.completedJobs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>

      <p className="note">
        <strong>Dispute rate {percent(metrics.disputeRate, 1)}.</strong> Fraud and abuse signals are
        surfaced for human review rather than acted on automatically — an irreversible automated ban
        on a false positive costs a worker their income.
      </p>
    </>
  )
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'ok' | 'alert'
}) {
  const className = tone === 'alert' ? 'stat alert' : tone === 'ok' ? 'stat ok-badge' : 'stat'
  return (
    <div className={className}>
      <span className="stat-label">{label}</span>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  )
}
