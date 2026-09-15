import type { FastifyInstance } from 'fastify'
import { registerDeviceSchema, deregisterDeviceSchema } from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'

/**
 * Where a device says "push to me here".
 *
 * Until this existed the Device table was never written to, which meant the
 * notifier — quiet hours, daily caps, per-category preferences, all of it
 * tested and correct — found zero devices for every user and recorded
 * "No registered device" forever. The whole notification system was a diary.
 *
 * Registration is an upsert on the token rather than a create, because the same
 * token comes back on every launch. A create would either throw on the unique
 * index or pile up rows.
 */
export async function registerDeviceRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  app.post('/devices', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = registerDeviceSchema.parse(request.body)

    /*
     * The token is keyed to whoever is holding the phone NOW.
     *
     * A shared or resold device, or one person signing out and another signing
     * in, otherwise keeps pushing the first person's job alerts — including
     * addresses — to the second. Re-pointing the row at the current user on
     * every registration is the whole fix, and it is why userId is in the
     * update and not only the create.
     */
    const device = await deps.db.device.upsert({
      where: { pushToken: body.pushToken },
      create: {
        userId: identity.userId,
        pushToken: body.pushToken,
        platform: body.platform,
        appVersion: body.appVersion ?? null,
        tzOffsetMinutes: body.tzOffsetMinutes ?? null,
      },
      update: {
        userId: identity.userId,
        platform: body.platform,
        appVersion: body.appVersion ?? null,
        tzOffsetMinutes: body.tzOffsetMinutes ?? null,
        lastSeenAt: new Date(),
      },
      select: { id: true, platform: true, lastSeenAt: true },
    })

    return reply.status(200).send({ device })
  })

  /**
   * Sign-out, uninstall, or notifications turned off in settings.
   *
   * Scoped to the caller's own devices: a token is a bearer-ish string that
   * travels in logs and crash reports, and letting anyone delete any device by
   * quoting one would be a free way to silence another user's job alerts.
   */
  app.delete('/devices', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = deregisterDeviceSchema.parse(request.body)

    const { count } = await deps.db.device.deleteMany({
      where: { pushToken: body.pushToken, userId: identity.userId },
    })

    // 204 either way. A client signing out should not have to care whether the
    // token was already gone, and telling it which is the case would answer
    // "does this token belong to someone else" for anybody who asks.
    return reply.status(204).send()
  })
}
