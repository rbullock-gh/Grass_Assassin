'use client'

/**
 * The waitlist form.
 *
 * Progressive enhancement, deliberately: without JavaScript this is a plain
 * POST to the form provider, which renders its own confirmation. The client
 * code only upgrades that to an inline confirmation so the visitor is not
 * thrown onto a third-party page. If the fetch fails for any reason the
 * browser's own submit still works on the next attempt.
 *
 * The endpoint is a build-time variable because the site is statically
 * exported. When it is missing the form renders visibly broken rather than
 * silently discarding signups — a waitlist page that looks fine and drops
 * every address is the most expensive bug this page can ship.
 */
import { useState } from 'react'
import { Arrow, Check } from './Icons'

const ENDPOINT = process.env.NEXT_PUBLIC_WAITLIST_ENDPOINT ?? ''

export interface WaitlistFormProps {
  /** Which side of the marketplace this signup is, recorded with the address. */
  audience: string
  idPrefix: string
  heading: string
  intro: string
  fine: string
}

type State = 'idle' | 'sending' | 'done' | 'error'

export function WaitlistForm({ audience, idPrefix, heading, intro, fine }: WaitlistFormProps) {
  const [state, setState] = useState<State>('idle')

  if (!ENDPOINT) {
    return (
      <div className="signup">
        <h2 className="signup__h">{heading}</h2>
        <p className="signup__intro">{intro}</p>
        <p className="signup__fine signup__error" role="alert">
          This form has no endpoint yet. Set NEXT_PUBLIC_WAITLIST_ENDPOINT and rebuild,
          or every signup will be discarded.
        </p>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div className="signup">
        <div className="signup__done" role="status">
          <Check />
          <strong>You&rsquo;re on the list.</strong>
          <p>We&rsquo;ll email you when GrassAssassin opens near you. Nothing else.</p>
        </div>
      </div>
    )
  }

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget
    if (!form.checkValidity()) return // let the browser show its own messages

    event.preventDefault()
    setState('sending')
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'application/json' },
      })
      setState(res.ok ? 'done' : 'error')
    } catch {
      setState('error')
    }
  }

  return (
    <form className="signup" action={ENDPOINT} method="POST" onSubmit={onSubmit}>
      <h2 className="signup__h">{heading}</h2>
      <p className="signup__intro">{intro}</p>

      <input type="hidden" name="audience" value={audience} />
      {/* Honeypot: bots fill it, people never see it. */}
      <p className="signup__hp" aria-hidden="true">
        <label>
          Leave this empty
          <input type="text" name="_gotcha" tabIndex={-1} autoComplete="off" />
        </label>
      </p>

      <div className="signup__row">
        <div className="field">
          <label htmlFor={`${idPrefix}-email`}>Email</label>
          <input
            id={`${idPrefix}-email`}
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-zip`}>ZIP code</label>
          <input
            id={`${idPrefix}-zip`}
            type="text"
            name="zip"
            required
            inputMode="numeric"
            pattern="[0-9]{5}"
            maxLength={5}
            autoComplete="postal-code"
            placeholder="39429"
          />
        </div>
      </div>

      <button className="btn btn--lg" type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Join the waitlist'}
        {state === 'sending' ? null : <Arrow />}
      </button>

      {state === 'error' ? (
        <p className="signup__fine signup__error" role="alert">
          That didn&rsquo;t go through. Please try again in a moment.
        </p>
      ) : (
        <p className="signup__fine">{fine}</p>
      )}
    </form>
  )
}
