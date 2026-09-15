import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { sessionCookieName } from '@/lib/session'

/**
 * Signing out.
 *
 * A form rather than a link: a GET that ends your session can be triggered by
 * any image tag on any page, and a dashboard nobody can stay signed in to is
 * its own kind of broken.
 */
export function SignOut() {
  async function signOut() {
    'use server'
    const store = await cookies()
    store.delete(sessionCookieName())
    redirect('/sign-in')
  }

  return (
    <form action={signOut}>
      <button type="submit" className="sign-out">Sign out</button>
    </form>
  )
}
