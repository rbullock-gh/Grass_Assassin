import { NextResponse, type NextRequest } from 'next/server'
import { adminEnv, sessionCookieName, verifySession } from '@/lib/session'

/**
 * Nothing in here is reachable without a session.
 *
 * Applied at the edge rather than per page, because the failure mode of
 * per-page checks is the page somebody forgets — and on this dashboard the page
 * somebody forgets might be the one that changes the commission.
 */
export async function middleware(request: NextRequest) {
  const env = adminEnv()

  // Local development with no password set: open, and the banner on the page
  // says so. Production throws in adminEnv rather than reaching this branch.
  if (!env) return NextResponse.next()

  const { pathname } = request.nextUrl
  if (pathname.startsWith('/sign-in')) return NextResponse.next()

  if (await verifySession(env.secret, request.cookies.get(sessionCookieName())?.value)) {
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
