import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  NOTIFICATION_GROUPS, groupsFor, type NotificationGroup,
} from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'

/**
 * Turning notifications off.
 *
 * The notifier has consulted notification_preferences on every single send
 * since it was written, and nothing could write a row to it — so the answer was
 * always the default and no notification in the product could be muted. That
 * was survivable while push was recorded and discarded. It stopped being
 * survivable the day push started actually arriving on people's phones.
 *
 * Preferences are stored per CATEGORY because that is what the notifier looks
 * up, and presented per GROUP because fourteen switches is not a settings
 * screen. The grouping lives in @grassassassin/shared so the two cannot drift.
 */
const updateSchema = z.object({
  /** Group key to whether push is wanted. Absent groups are left alone. */
  groups: z.record(z.string(), z.boolean()),
})

export async function registerPreferenceRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  app.get('/notification-preferences', async (request) => {
    const identity = requireIdentity(request)

    const [user, rows] = await Promise.all([
      deps.db.user.findUniqueOrThrow({
        where: { id: identity.userId },
        select: { roles: true },
      }),
      deps.db.notificationPreference.findMany({
        where: { userId: identity.userId },
        select: { category: true, push: true },
      }),
    ])

    const muted = new Set(rows.filter((row) => !row.push).map((row) => row.category))

    return {
      groups: groupsFor(user.roles).map((group) => ({
        key: group.key,
        label: group.label,
        detail: group.detail,
        cost: group.cost ?? null,
        /*
         * On unless every category in the group is muted.
         *
         * Opt-out, matching the notifier: somebody who has never opened this
         * screen still hears about the job they are working. A half-muted group
         * reads as on, which is the safer of the two lies and the one that
         * matches what they will actually receive.
         */
        enabled: !group.categories.every((category) => muted.has(category)),
      })),
    }
  })

  app.put('/notification-preferences', async (request) => {
    const identity = requireIdentity(request)
    const body = updateSchema.parse(request.body)

    const byKey = new Map<string, NotificationGroup>(
      NOTIFICATION_GROUPS.map((group) => [group.key, group]),
    )

    const writes = []
    for (const [key, enabled] of Object.entries(body.groups)) {
      const group = byKey.get(key)
      // An unknown key is ignored rather than refused. A client on an older
      // build sending a group we have since renamed should still be able to
      // save the switches it does know about.
      if (!group) continue

      for (const category of group.categories) {
        writes.push(deps.db.notificationPreference.upsert({
          where: { userId_category: { userId: identity.userId, category } },
          create: { userId: identity.userId, category, push: enabled },
          update: { push: enabled },
        }))
      }
    }

    // One transaction: a half-applied group would leave someone muted for
    // "a pro is on the way" and not for "work started", which is not a state
    // any screen can explain.
    if (writes.length > 0) await deps.db.$transaction(writes)

    const rows = await deps.db.notificationPreference.findMany({
      where: { userId: identity.userId },
      select: { category: true, push: true },
    })
    const muted = new Set(rows.filter((row) => !row.push).map((row) => row.category))

    const user = await deps.db.user.findUniqueOrThrow({
      where: { id: identity.userId },
      select: { roles: true },
    })

    return {
      groups: groupsFor(user.roles).map((group) => ({
        key: group.key,
        enabled: !group.categories.every((category) => muted.has(category)),
      })),
    }
  })
}
