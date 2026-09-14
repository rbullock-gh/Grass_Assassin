'use server'

import { revalidatePath } from 'next/cache'
import { CONFIG_FIELDS, validateConfigValue, validateConfigSet } from '@grassassassin/shared'
import { db } from '@/lib/db'

/**
 * Saving fee and policy settings.
 *
 * The read side of this has always been configurable; this is the half that was
 * missing, and its absence made the page's own promise untrue — it said rates
 * were editable per market while offering no way to edit them.
 *
 * Three things this deliberately does:
 *
 * It validates with the SAME registry the form renders from, so the bounds
 * shown under an input and the bounds enforced on save cannot drift apart.
 * A form that accepts what the writer rejects is a worse experience than no
 * form at all.
 *
 * It refuses the whole submission if any field is wrong, rather than saving the
 * good ones. A half-applied fee change is the state nobody can reason about:
 * commission moved, service fee did not, and the next customer is charged a
 * combination that was never approved.
 *
 * It writes an audit row for every change, with the previous value. "Who
 * changed the commission, when, and from what" is the first question asked
 * after a bad week of margins, and a settings page that cannot answer it is
 * worth very little.
 */

export interface SaveResult {
  ok: boolean
  /** Keyed by config key, for rendering under the right input. */
  fieldErrors?: Record<string, string>
  /** Problems involving more than one field. */
  formErrors?: string[]
  savedCount?: number
}

export async function saveConfig(_previous: SaveResult | null, form: FormData): Promise<SaveResult> {
  const scopeRaw = String(form.get('scopeKey') ?? '').trim()
  // An empty market means the global default, which is a real and distinct row
  // from any city's override — not a missing value.
  const scopeKey = scopeRaw === '' ? null : scopeRaw

  const fieldErrors: Record<string, string> = {}
  const values: Record<string, number> = {}

  for (const field of CONFIG_FIELDS) {
    const raw = form.get(field.key)
    // A field left out of the submission is not a change. Only what was sent
    // gets written, so a future partial form does not blank the rest.
    if (raw === null) continue

    const result = validateConfigValue(field.key, raw)
    if (!result.ok) fieldErrors[field.key] = result.error ?? 'Invalid value'
    else values[field.key] = result.value!
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }

  const formErrors = validateConfigSet(values)
  if (formErrors.length > 0) return { ok: false, formErrors }

  const existing = await db.platformConfig.findMany({
    where: { key: { in: Object.keys(values) }, scopeKey },
    select: { key: true, value: true },
  })
  const before = new Map(existing.map((row) => [row.key, row.value]))

  const changed = Object.entries(values).filter(([key, value]) => Number(before.get(key)) !== value)
  if (changed.length === 0) return { ok: true, savedCount: 0 }

  // Explicit update-or-create rather than upsert. Prisma's upsert addresses the
  // row by the ("scopeKey", key) unique constraint, and for a GLOBAL row that
  // constraint does not bite — PostgreSQL treats NULL as distinct from NULL, so
  // the lookup misses an existing row and the "create" branch inserts a
  // duplicate. A partial unique index now rejects that outright, which would
  // turn every global save into an error. Branching on what we already read is
  // both correct and clearer about which case is which.
  await db.$transaction([
    ...changed.map(([key, value]) =>
      before.has(key)
        ? db.platformConfig.updateMany({ where: { key, scopeKey }, data: { value } })
        : db.platformConfig.create({ data: { key, scopeKey, value } })),
    db.auditLog.create({
      data: {
        actorType: 'ADMIN',
        action: 'platform_config.updated',
        entityType: 'PlatformConfig',
        entityId: scopeKey ?? 'global',
        before: Object.fromEntries(changed.map(([key]) => [key, before.get(key) ?? null])),
        after: Object.fromEntries(changed),
      },
    }),
  ])

  revalidatePath('/config')
  return { ok: true, savedCount: changed.length }
}
