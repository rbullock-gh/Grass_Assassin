import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { authenticateAdmin } from '@/lib/admin-user'
import {
  adminSecret, issueSession, sessionCookieName, sessionMaxAgeSeconds,
} from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The only page reachable without a session.
 *
 * Deliberately uninformative on failure. "Those credentials are not valid"
 * covers no such account, wrong password, and a real account without the
 * administrator role — telling them apart would let anyone map out who has
 * access here, and helps nobody who is genuinely trying to sign in.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const params = await searchParams
  if (!adminSecret()) redirect('/')

  async function signIn(form: FormData) {
    'use server'
    const secret = adminSecret()
    if (!secret) redirect('/')

    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    const destination = safeNext(String(form.get('next') ?? '/'))

    const admin = await authenticateAdmin(email, password)
    if (!admin) {
      redirect(`/sign-in?error=1&next=${encodeURIComponent(destination)}`)
    }

    const store = await cookies()
    store.set(sessionCookieName(), await issueSession(secret, admin.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: sessionMaxAgeSeconds(),
    })
    redirect(destination)
  }

  return (
    <div className="signin-wrap">
      <form action={signIn} className="signin">
        <h1>GrassAssassin admin</h1>
        <p className="muted">
          This dashboard can change platform fees and resolve disputes. It is not a
          read-only view.
        </p>

        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" autoFocus />

        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" />
        <input type="hidden" name="next" value={params.next ?? '/'} />

        {params.error ? <p className="signin-error">Those credentials are not valid.</p> : null}

        <button type="submit">Sign in</button>
      </form>
    </div>
  )
}

/**
 * Only same-site paths.
 *
 * Without this, ?next=https://evil.example turns the sign-in page into an open
 * redirect that borrows our domain's credibility.
 */
function safeNext(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
}
