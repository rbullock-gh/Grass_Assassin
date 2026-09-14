import { db } from '@/lib/db'
import { loadTrialBalance } from '@/lib/metrics'
import { money, relativeTime, titleCase } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function PaymentsPage() {
  const [trialBalance, transactions, tips] = await Promise.all([
    loadTrialBalance(),
    db.transaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        id: true, kind: true, status: true, amountCents: true, createdAt: true,
        failureMessage: true, stripePaymentIntentId: true,
        job: { select: { title: true } },
      },
    }),
    db.tip.aggregate({ _sum: { amountCents: true }, _count: true }),
  ])

  const delta = trialBalance.reduce((sum, row) => sum + row.balanceCents, 0)
  const balanced = delta === 0

  return (
    <>
      <div className="page-head">
        <h1>Ledger</h1>
        <p>
          Transactions record <em>intent</em>; ledger entries record <em>effect</em>, as balanced
          double-entry lines. The two are kept separate so our books can be reconciled against the
          processor independently of what we believed we were doing.
        </p>
      </div>

      <div className="stats">
        <div className={balanced ? 'stat ok-badge' : 'stat alert'}>
          <span className="stat-label">Trial balance</span>
          <div className="stat-value">{balanced ? 'Balanced' : money(delta)}</div>
          <div className="stat-sub">
            {balanced ? 'All accounts net to zero' : 'Books do not reconcile — investigate'}
          </div>
        </div>
        <div className="stat">
          <span className="stat-label">Tips paid</span>
          <div className="stat-value">{money(tips._sum.amountCents ?? 0)}</div>
          <div className="stat-sub">{tips._count} tips · 0% platform cut</div>
        </div>
        <div className="stat">
          <span className="stat-label">Transactions</span>
          <div className="stat-value">{transactions.length}</div>
          <div className="stat-sub">Most recent shown</div>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Transactions</h2>
            <span>Intent records</span>
          </div>
          <div className="table-wrap">
            {transactions.length === 0 ? (
              <p className="empty">No transactions yet.</p>
            ) : (
              <table>
                <thead>
                  <tr><th>Job</th><th>Kind</th><th>Status</th><th className="num">Amount</th><th>When</th></tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td className="strong">
                        {tx.job?.title ?? <span className="muted">—</span>}
                        {tx.failureMessage ? (
                          <div className="muted" style={{ fontSize: 11.5, color: 'var(--danger)' }}>
                            {tx.failureMessage}
                          </div>
                        ) : null}
                      </td>
                      <td className="muted">{titleCase(tx.kind)}</td>
                      <td>
                        <span className={`pill ${
                          tx.status === 'SUCCEEDED' ? 'success'
                            : tx.status === 'FAILED' ? 'danger'
                            : tx.status === 'PENDING' ? 'warning' : 'neutral'
                        }`}>{titleCase(tx.status)}</span>
                      </td>
                      <td className="num">{money(tx.amountCents)}</td>
                      <td className="muted">{relativeTime(tx.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Trial balance</h2>
            <span>Effect records</span>
          </div>
          <div className="table-wrap">
            {trialBalance.length === 0 ? (
              <p className="empty">No ledger entries yet.</p>
            ) : (
              <table>
                <thead><tr><th>Account</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  {trialBalance.map((row) => (
                    <tr key={row.account}>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{row.account}</td>
                      <td className="num strong"
                          style={{ color: row.balanceCents < 0 ? 'var(--ink-2)' : undefined }}>
                        {money(row.balanceCents)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid var(--line-2)' }}>
                    <td className="strong">Net</td>
                    <td className="num strong" style={{ color: balanced ? 'var(--brand)' : 'var(--danger)' }}>
                      {money(delta)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      <p className="note">
        A non-zero net is not a rounding artefact — <code>postEntry</code> refuses to write lines
        that do not sum to zero, so any imbalance here means a write bypassed the ledger entirely.
      </p>
    </>
  )
}
