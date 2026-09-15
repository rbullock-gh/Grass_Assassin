import { adminEnv } from '@/lib/session'
import { Nav } from './nav'

/**
 * The signed-in shell.
 *
 * Everything under this group is behind the middleware gate, so the navigation
 * here is only ever rendered to someone holding a valid session.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
              <path d="M3 20h18" /><path d="M7 20v-5" /><path d="M11 20v-8" /><path d="M15 20v-6" /><path d="M19 20v-9" />
            </svg>
          </div>
          <div>
            <div className="brand-name">Grass<span>Assassin</span></div>
          </div>
        </div>
        <Nav />
        <div style={{ marginTop: 'auto', padding: '0 8px' }}>
          <span className="brand-env">Development</span>
        </div>
      </aside>
      <main className="main">
        {/* Says plainly when the dashboard is running unauthenticated, so
            nobody discovers it by finding the fee form wide open. In
            production adminEnv() throws rather than reaching this. */}
        {adminEnv() === null ? (
          <div className="no-auth-banner">
            No ADMIN_PASSWORD set — this dashboard is unauthenticated. Fine locally;
            it refuses to start this way in production.
          </div>
        ) : null}
        {children}
      </main>
    </div>
  )
}
