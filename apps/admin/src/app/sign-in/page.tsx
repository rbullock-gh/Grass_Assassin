import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { adminEnv, issueSession, passwordMatches, sessionCookieName } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * The only page reachable without a session.
 *
 * One password, no account enumeration to worry about, and a deliberately
 * uninformative failure — "that is not the password" tells an attacker nothing
 * they did not already know, and tells the operator everything they need.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const params = await searchParams
  const env = adminEnv()
  if (!env) redirect('/')

  async function signIn(form: FormData) {
    'use server'
    const current = adminEnv()
    if (!current) redirect('/')

    const submitted = String(form.get('password') ?? '')
    const destination = safeNext(String(form.get('next') ?? '/'))

    if (!(await passwordMatches(current.password, submitted))) {
      redirect(`/sign-in?error=1&next=${encodeURIComponent(destination)}`)
    }

    const store = await cookies()
    store.set(sessionCookieName(), await issueSession(current.secret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
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

        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" autoFocus />
        <input type="hidden" name="next" value={params.next ?? '/'} />

        {params.error ? <p className="signin-error">That is not the password.</p> : null}

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
