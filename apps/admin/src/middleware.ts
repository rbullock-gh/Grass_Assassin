import { NextResponse, type NextRequest } from 'next/server'
import { adminSecret, sessionCookieName, readSession } from '@/lib/session'

/**
 * Nothing in here is reachable without a session.
 *
 * Applied at the edge rather than per page, because the failure mode of
 * per-page checks is the page somebody forgets — and on this dashboard the page
 * somebody forgets might be the one that changes the commission.
 *
 * This is the cheap check: signature and expiry only, no database. Whether the
 * account behind the session is still an active administrator is re-read per
 * request in currentAdmin, which is what actually gates the pages.
 */
export async function middleware(request: NextRequest) {
  const secret = adminSecret()

  // Local development with no secret set: open, and the banner on the page
  // says so. Production throws in adminSecret rather than reaching this branch.
  if (!secret) return NextResponse.next()

  const { pathname } = request.nextUrl
  if (pathname.startsWith('/sign-in')) return NextResponse.next()

  if (await readSession(secret, request.cookies.get(sessionCookieName())?.value)) {
    return NextResponse.next()
  }

  const signIn = request.nextUrl.clone()
  signIn.pathname = '/sign-in'
  // Where they were headed, so signing in does not dump them on the dashboard
  // when they clicked a link to a specific dispute.
  signIn.searchParams.set('next', pathname)
  return NextResponse.redirect(signIn)
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
}
