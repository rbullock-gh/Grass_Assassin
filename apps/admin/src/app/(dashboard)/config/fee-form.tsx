'use client'

import { useActionState } from 'react'
import { CONFIG_FIELDS, formatConfigValue } from '@grassassassin/shared'
import { saveConfig, type SaveResult } from './actions'

/**
 * Editing fees and policy.
 *
 * Every input shows the unit it is in and what the value means in human terms
 * as you type, because the expensive mistake on this page is not a typo — it is
 * typing 12 into a basis-points box meaning 12%, and charging 0.12% instead.
 * The live translation underneath makes that mistake visible before saving
 * rather than after a day of jobs.
 */
export function FeeForm({ current, scopes }: {
  current: Record<string, number>
  scopes: Array<{ slug: string; name: string }>
}) {
  const [result, action, pending] = useActionState<SaveResult | null, FormData>(saveConfig, null)

  return (
    /**
     * noValidate deliberately.
     *
     * With min/max on a number input the BROWSER refuses the submission and
     * shows its own transient tooltip, so the server action never runs. That
     * silently disables every cross-field rule — a minimum price above the
     * maximum, a combined take over half the job — because those cannot be
     * expressed as an input attribute at all and only exist on the server.
     *
     * Letting the submission through means one validator, one set of messages,
     * and errors that stay on screen next to the field they belong to. The
     * min/max attributes stay as stepper hints.
     */
    <form action={action} className="config-form" noValidate>
      <div className="config-scope">
        <label htmlFor="scopeKey">Applies to</label>
        <select id="scopeKey" name="scopeKey" defaultValue="">
          <option value="">Everywhere (global default)</option>
          {scopes.map((scope) => (
            <option key={scope.slug} value={scope.slug}>{scope.name} only</option>
          ))}
        </select>
        <p className="muted">
          A market override wins over the global default for jobs in that market.
          Leave it global unless you are deliberately running a different rate somewhere.
        </p>
      </div>

      <div className="config-fields">
        {CONFIG_FIELDS.map((field) => {
          const value = current[field.key]
          const error = result?.fieldErrors?.[field.key]
          return (
            <div className="config-field" key={field.key}>
              <label htmlFor={field.key}>
                {field.label}
                <span className="unit">{unitLabel(field.unit)}</span>
              </label>
              <input
                id={field.key}
                name={field.key}
                type="number"
                inputMode="numeric"
                step="1"
                min={field.min}
                max={field.max}
                defaultValue={value ?? ''}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${field.key}-help`}
                className={error ? 'invalid' : undefined}
              />
              <p id={`${field.key}-help`} className={error ? 'field-error' : 'field-help'}>
                {error ?? field.help}
              </p>
              <p className="field-range">
                {formatConfigValue(field, field.min)} – {formatConfigValue(field, field.max)}
                {value !== undefined ? <> · currently <b>{formatConfigValue(field, value)}</b></> : null}
              </p>
            </div>
          )
        })}
      </div>

      {result?.formErrors?.length ? (
        <div className="config-errors" role="alert">
          {result.formErrors.map((problem) => <p key={problem}>{problem}</p>)}
        </div>
      ) : null}

      {result?.ok ? (
        <p className="config-saved" role="status">
          {result.savedCount === 0
            ? 'Nothing changed.'
            : `Saved ${result.savedCount} setting${result.savedCount === 1 ? '' : 's'}. The change is live and audited.`}
        </p>
      ) : null}

      <div className="config-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <span className="muted">
          Takes effect on the next job posted. Existing jobs keep the rate they were quoted at.
        </span>
      </div>
    </form>
  )
}

function unitLabel(unit: string): string {
  switch (unit) {
    case 'BPS': return 'basis points'
    case 'CENTS': return 'cents'
    case 'HOURS': return 'hours'
    case 'MINUTES': return 'minutes'
    default: return ''
  }
}
