import { loadFeeConfig } from '@/lib/metrics'
import { db } from '@/lib/db'
import { money, relativeTime } from '@/lib/format'

export const dynamic = 'force-dynamic'

const DESCRIPTIONS: Record<string, string> = {
  'fees.worker_commission_bps': 'Commission deducted from the job price, in basis points',
  'fees.customer_service_fee_bps': 'Service fee added on top of the job price, in basis points',
  'fees.customer_service_fee_min_cents': 'Floor for the service fee, so small jobs still cover processing',
  'fees.min_job_price_cents': 'Minimum publishable job price — below this, unit economics invert',
  'fees.max_job_price_cents': 'Maximum publishable price, guarding fat-finger entry and fraud',
  'cancellation.grace_minutes': 'Free-cancellation window after a worker claims',
  'cancellation.late_hours': 'Hours before the scheduled window where the late penalty applies',
  'cancellation.early_penalty_bps': 'Customer penalty outside the late window, paid to the worker',
  'cancellation.late_penalty_bps': 'Customer penalty inside the late window, paid to the worker',
  'approval.auto_approve_hours': 'How long a customer has before work auto-approves',
}

function renderValue(key: string, value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  if (key.endsWith('_bps')) return `${(numeric / 100).toFixed(2)}%`
  if (key.endsWith('_cents')) return money(numeric)
  if (key.endsWith('_hours')) return `${numeric}h`
  if (key.endsWith('_minutes')) return `${numeric} min`
  return String(numeric)
}

export default async function ConfigPage() {
  const [config, areas, categories, ranks] = await Promise.all([
    loadFeeConfig(),
    db.serviceArea.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true, active: true, radiusMiles: true, launchedAt: true } }),
    db.serviceCategory.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, active: true, difficulty: true, typicalLowCents: true, typicalHighCents: true } }),
    db.rank.findMany({ orderBy: { minPoints: 'asc' }, select: { key: true, name: true, minPoints: true, commissionDiscountBps: true, minRating: true, minCompletionRate: true } }),
  ])

  return (
    <>
      <div className="page-head">
        <h1>Fees &amp; configuration</h1>
        <p>
          Nothing about our economics is hard-coded. Rates are editable per market and every change
          is audited — a marketplace that needs an engineer and a deploy to change a commission rate
          cannot respond to a competitor or run the experiments that find the right number.
        </p>
      </div>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Fees and policy</h2>
            <span>{config.length} settings</span>
          </div>
          <div className="panel-body">
            {config.length === 0 ? (
              <p className="empty">Not configured — compiled defaults are in effect.</p>
            ) : (
              <div className="kv">
                {config.map((row) => (
                  <div className="kv-row" key={row.id}>
                    <div className="kv-key">
                      {row.key}
                      {row.scopeKey ? <span className="scope-tag">{row.scopeKey}</span> : null}
                      <small>{DESCRIPTIONS[row.key] ?? 'Custom setting'}</small>
                    </div>
                    <div className="kv-value">{renderValue(row.key, row.value)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <div style={{ display: 'grid', gap: 18 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>Service areas</h2>
              <span>Launch gates</span>
            </div>
            <div className="table-wrap">
              {areas.length === 0 ? (
                <p className="empty">No service areas configured.</p>
              ) : (
                <table>
                  <thead><tr><th>Market</th><th>Status</th><th className="num">Radius</th></tr></thead>
                  <tbody>
                    {areas.map((area) => (
                      <tr key={area.id}>
                        <td className="strong">{area.name}<div className="muted" style={{ fontSize: 11.5 }}>{area.slug}</div></td>
                        <td>
                          <span className={`pill ${area.active ? 'success' : 'neutral'}`}>
                            {area.active ? 'Live' : 'Not launched'}
                          </span>
                        </td>
                        <td className="num muted">{area.radiusMiles ? `${area.radiusMiles} mi` : 'polygon'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Ranks</h2>
              <span>Earned, never purchased</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Rank</th><th className="num">XP</th><th className="num">Discount</th><th className="num">Min rating</th></tr></thead>
                <tbody>
                  {ranks.map((rank) => (
                    <tr key={rank.key}>
                      <td className="strong">{rank.name}</td>
                      <td className="num tnum">{rank.minPoints.toLocaleString()}</td>
                      <td className="num muted">{rank.commissionDiscountBps ? `−${(rank.commissionDiscountBps / 100).toFixed(0)}%` : '—'}</td>
                      <td className="num muted">{rank.minRating ? `★ ${rank.minRating}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <div className="panel-head">
          <h2>Job categories</h2>
          <span>{categories.filter((c) => c.active).length} active of {categories.length}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Status</th><th className="num">Difficulty</th><th className="num">Typical range</th></tr></thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id}>
                  <td className="strong">{category.name}</td>
                  <td>
                    <span className={`pill ${category.active ? 'success' : 'neutral'}`}>
                      {category.active ? 'Active' : 'Seasonal — off'}
                    </span>
                  </td>
                  <td className="num muted">{category.difficulty} / 5</td>
                  <td className="num muted">{money(category.typicalLowCents)} – {money(category.typicalHighCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="note">
        Seasonal categories exist but are switched off. Lawn revenue collapses November–March in most
        US metros; leaf removal, gutters and snow work are how the category survives winter, and they
        open without a release precisely because categories are data rather than an enum.
      </p>
    </>
  )
}
