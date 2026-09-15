'use client'

import { useActionState, useState } from 'react'
import { actOnReportAction, type ModerationResult } from './actions'

const MIN_NOTE = 15

const OPTIONS = [
  {
    value: 'DISMISS',
    label: 'Nothing happened here',
    detail: 'No action against the account. The report is closed.',
  },
  {
    value: 'WARN',
    label: 'Warn them',
    detail: 'Recorded against the account. They keep working.',
  },
  {
    value: 'SUSPEND_7',
    label: 'Suspend for 7 days',
    detail: 'They cannot claim or post for a week. Their income stops.',
  },
  {
    value: 'SUSPEND_30',
    label: 'Suspend for 30 days',
    detail: 'A month off the platform. Use for something serious.',
  },
  {
    value: 'BAN',
    label: 'Ban permanently',
    detail: 'They are finished here. There is no undo in this screen.',
  },
] as const

/**
 * Deciding one report.
 *
 * Every option says what it costs the person on the other end, in plain words,
 * next to the button that does it. The expensive mistake on this screen is not
 * a typo — it is not registering that "suspend for 30 days" is a month of
 * somebody's income, decided on one stranger's account of what happened.
 *
 * Fields are controlled for the same reason as the dispute form: React resets a
 * form after a form action, and a rejected submission that silently erases the
 * paragraph an administrator just wrote is how a careful note becomes a
 * one-liner on the second attempt.
 */
export function ReportForm({ reportId, subjectName }: { reportId: string; subjectName: string }) {
  const [result, action, pending] = useActionState<ModerationResult | null, FormData>(
    actOnReportAction, null,
  )
  const [outcome, setOutcome] = useState('')
  const [note, setNote] = useState('')

  const short = MIN_NOTE - note.trim().length
  const missing = !outcome
    ? 'Choose what to do.'
    : short > 0
      ? `Say why — ${short} more character${short === 1 ? '' : 's'}.`
      : null

  return (
    <form action={action} className="resolve-form">
      <input type="hidden" name="reportId" value={reportId} />

      {/*
        * A fieldset, not a .resolve-split.
        *
        * The first version wrapped these in .resolve-split, whose label rule is
        * `text-transform: uppercase` — which cascaded into every option, so the
        * screen where somebody decides whether to take a person's income away
        * SHOUTED FIVE OPTIONS AT THEM IN CAPITALS. Caught by looking at the
        * rendered page rather than the JSX.
        */}
      <fieldset>
        <legend>What happens to {subjectName}</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`choice${outcome === option.value ? ' selected' : ''}`}
          >
            <input
              type="radio"
              name="outcome"
              value={option.value}
              checked={outcome === option.value}
              onChange={() => setOutcome(option.value)}
            />
            <span>
              <strong>{option.label}</strong>
              <em>{option.detail}</em>
            </span>
          </label>
        ))}
      </fieldset>

      <label htmlFor={`note-${reportId}`}>What you decided, and why</label>
      <textarea
        id={`note-${reportId}`}
        name="note"
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="This is the record if the decision is questioned later."
      />

      <div className="resolve-submit">
        <button type="submit" disabled={pending || missing !== null}>
          {pending ? 'Saving…' : 'Record this decision'}
        </button>
        {missing ? <span className="muted">{missing}</span> : null}
      </div>

      {result?.error ? <p className="resolve-error">{result.error}</p> : null}
      {result?.ok ? <p className="resolve-done">{result.summary}</p> : null}
    </form>
  )
}
