import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { authenticateAdmin } from '@/lib/admin-user'
import { checkThrottle, recordFailure, recordSuccess } from '@/lib/throttle'
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
  searchParams: Promise<{ next?: string; error?: string; blocked?: string }>
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
    const source = await clientSource()

    // Checked BEFORE the password, so a blocked source cannot keep guessing and
    // learn anything from how long the answer takes.
    const throttle = checkThrottle(source)
    if (throttle.blocked) {
      redirect(
        `/sign-in?blocked=${throttle.retryAfterSeconds}&next=${encodeURIComponent(destination)}`,
      )
    }
    // Above the global threshold everything slows down. Not a block: one
    // attacker must not be able to lock every administrator out by guessing
    // badly a hundred times.
    if (throttle.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, throttle.delayMs))
    }

    const admin = await authenticateAdmin(email, password)
    if (!admin) {
      recordFailure(source)
      redirect(`/sign-in?error=1&next=${encodeURIComponent(destination)}`)
    }
    recordSuccess(source)

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

        {params.blocked ? (
          <p className="signin-error">
            Too many failed attempts. Try again in {retryText(params.blocked)}.
          </p>
        ) : params.error ? (
          <p className="signin-error">Those credentials are not valid.</p>
        ) : null}

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

/**
 * Who is attempting this.
 *
 * Reads the forwarded address, which is only trustworthy behind a proxy that
 * sets it — so this is one layer, not the layer. The global tarpit in
 * throttle.ts is what survives a spoofed or absent header, because it counts
 * failures in aggregate and cannot be evaded by claiming a different origin.
 */
async function clientSource(): Promise<string> {
  const store = await headers()
  const forwarded = store.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || store.get('x-real-ip')?.trim() || 'unknown'
}

function retryText(seconds: string): string {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return 'a few minutes'
  const minutes = Math.ceil(value / 60)
  return minutes <= 1 ? 'a minute' : `${minutes} minutes`
}
