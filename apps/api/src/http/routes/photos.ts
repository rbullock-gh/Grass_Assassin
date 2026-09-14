import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { latLngSchema } from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { presignJobPhoto, confirmJobPhoto } from '../../modules/storage/photos.js'
import { ALLOWED_IMAGE_TYPES } from '../../modules/storage/provider.js'

export async function registerPhotoRoutes(
  app: FastifyInstance,
  deps: ServerDeps & { storage: NonNullable<ServerDeps['storage']> },
): Promise<void> {
  /**
   * Requests an upload URL.
   *
   * The device then PUTs the bytes straight to storage. Photos never pass
   * through the API — a worker on a rural signal uploading four 3MB images
   * would otherwise hold an API connection open for minutes.
   */
  app.post<{ Params: { id: string } }>('/jobs/:id/photos/presign', {
    config: app.rateLimits.enabled
      ? { rateLimit: { max: 40, timeWindow: '5 minutes' } }
      : {},
  }, async (request, reply) => {
    const identity = requireIdentity(request)
    const body = z.object({
      kind: z.enum(['LISTING', 'BEFORE', 'AFTER', 'ISSUE']),
      contentType: z.enum(ALLOWED_IMAGE_TYPES),
    }).parse(request.body)

    const result = await presignJobPhoto(
      { db: deps.db, storage: deps.storage },
      { jobId: request.params.id, actorUserId: identity.userId, ...body },
    )
    return reply.status(201).send(result)
  })

  /** Confirms the bytes landed. Until this runs, the photo does not count as proof. */
  app.post<{ Params: { photoId: string } }>('/photos/:photoId/confirm', async (request) => {
    const identity = requireIdentity(request)
    const body = z.object({
      capturedAt: z.coerce.date().optional(),
      capturedLocation: latLngSchema.optional(),
    }).parse(request.body ?? {})

    return confirmJobPhoto(
      { db: deps.db, storage: deps.storage },
      { photoId: request.params.photoId, actorUserId: identity.userId, ...body },
    )
  })
}
