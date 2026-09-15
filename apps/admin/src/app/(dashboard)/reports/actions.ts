'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { requireAdminUser } from '@/lib/admin-user'

/**
 * Acting on a safety report.
 *
 * The queue rendered a status column and offered no way to change it, so every
 * report stayed OPEN forever and the "oldest waiting" number the page leads
 * with only ever went up.
 *
 * Suspension is time-boxed rather than permanent by default. A suspension is a
 * person's income stopping, and the difference between "we are looking into
 * this" and "you are finished here" should be a decision somebody makes on
 * purpose, not the default shape of the only button available. Every outcome
 * writes an audit entry naming the administrator, because the record of who
 * decided what is the only defence when a decision is questioned later.
 */

export interface ModerationResult {
  ok: boolean
  error?: string
  summary?: string
}

const MIN_NOTE = 15

const OUTCOMES = {
  DISMISS: 'dismissed',
  WARN: 'warned',
  SUSPEND_7: 'suspended for 7 days',
  SUSPEND_30: 'suspended for 30 days',
  BAN: 'banned',
} as const

type Outcome = keyof typeof OUTCOMES

export async function actOnReportAction(
  _previous: ModerationResult | null,
  form: FormData,
): Promise<ModerationResult> {
  const admin = await requireAdminUser()

  const reportId = String(form.get('reportId') ?? '')
  const outcome = String(form.get('outcome') ?? '') as Outcome
  const note = String(form.get('note') ?? '').trim()

  if (!(outcome in OUTCOMES)) return { ok: false, error: 'Choose what to do.' }
  if (note.length < MIN_NOTE) {
    return {
      ok: false,
      error: `Say why in at least ${MIN_NOTE} characters — this is the record if the decision is questioned.`,
    }
  }

  const report = await db.report.findUnique({
    where: { id: reportId },
    select: {
      id: true, status: true, subjectId: true,
      subject: { select: { status: true, suspendedUntil: true, firstName: true } },
    },
  })
  if (!report) return { ok: false, error: 'That report is gone.' }
  if (report.status === 'ACTIONED' || report.status === 'DISMISSED') {
    // Two administrators opening the same queue is normal. Acting twice on one
    // report is how somebody gets suspended for fourteen days by accident.
    return { ok: false, error: 'Somebody already decided this one.' }
  }

  const now = new Date()
  const suspendedUntil = outcome === 'SUSPEND_7'
    ? new Date(now.getTime() + 7 * 86_400_000)
    : outcome === 'SUSPEND_30'
      ? new Date(now.getTime() + 30 * 86_400_000)
      : null

  const nextAccountStatus = outcome === 'BAN'
    ? 'BANNED'
    : suspendedUntil
      ? 'SUSPENDED'
      : null

  const before = {
    reportStatus: report.status,
    accountStatus: report.subject.status,
    suspendedUntil: report.subject.suspendedUntil?.toISOString() ?? null,
  }

  await db.$transaction([
    db.report.update({
      where: { id: report.id },
      data: {
        status: outcome === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
        action: OUTCOMES[outcome],
        reviewedById: admin.id,
        reviewedAt: now,
      },
    }),
    ...(nextAccountStatus
      ? [db.user.update({
        where: { id: report.subjectId },
        data: {
          status: nextAccountStatus,
          suspendedUntil,
          suspensionReason: note,
        },
      })]
      : []),
    db.auditLog.create({
      data: {
        actorId: admin.id,
        actorType: 'ADMIN',
        action: `report.${outcome === 'DISMISS' ? 'dismissed' : 'actioned'}`,
        entityType: 'Report',
        entityId: report.id,
        before,
        after: {
          reportStatus: outcome === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
          outcome: OUTCOMES[outcome],
          accountStatus: nextAccountStatus ?? report.subject.status,
          suspendedUntil: suspendedUntil?.toISOString() ?? null,
          note,
        },
      },
    }),
  ])

  revalidatePath('/reports')
  return { ok: true, summary: `${report.subject.firstName} — ${OUTCOMES[outcome]}.` }
}
