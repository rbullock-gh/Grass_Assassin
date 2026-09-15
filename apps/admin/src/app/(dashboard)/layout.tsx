import { redirect } from 'next/navigation'
import { adminSecret } from '@/lib/session'
import { currentAdmin } from '@/lib/admin-user'
import { Nav } from './nav'
import { SignOut } from './sign-out'

/**
 * The signed-in shell.
 *
 * The middleware has already checked the cookie's signature, but a signature
 * only proves the cookie was ours when it was issued. This re-reads the account
 * so an administrator who has since been suspended, deleted, or stripped of the
 * role loses access on their next page load rather than when the cookie
 * happens to expire.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const configured = adminSecret() !== null
  const admin = configured ? await currentAdmin() : null

  if (configured && !admin) redirect('/sign-in')

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
          {admin ? (
            <div className="signed-in">
              {/* Named, because every consequential action on this dashboard is
                  recorded against this person. They should be able to see who
                  the audit log is about to name. */}
              <div className="signed-in-name">{admin.firstName} {admin.lastName ?? ''}</div>
              <div className="signed-in-email">{admin.email}</div>
              <SignOut />
            </div>
          ) : null}
          <span className="brand-env">Development</span>
        </div>
      </aside>
      <main className="main">
        {/* Says plainly when the dashboard is running unauthenticated, so
            nobody discovers it by finding the fee form wide open. In
            production adminSecret() throws rather than reaching this. */}
        {!configured ? (
          <div className="no-auth-banner">
            No ADMIN_SESSION_SECRET set — this dashboard is unauthenticated. Fine locally;
            it refuses to start this way in production.
          </div>
        ) : null}
        {children}
      </main>
    </div>
  )
}
