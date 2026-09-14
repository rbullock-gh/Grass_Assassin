import type { FastifyInstance } from 'fastify'
import { FakeStorageProvider, MAX_PHOTO_BYTES } from '../../modules/storage/provider.js'
import type { ServerDeps } from '../server.js'

/**
 * Local stand-in for S3, so photo upload works in development.
 *
 * Without it the fake provider hands out a URL on a host that does not exist,
 * and the app's upload path cannot be exercised on a simulator, a device, or in
 * a smoke test — you find out it is broken in staging. The smoke test used to
 * work around this by UPDATE-ing the database directly, which proved the gate
 * but not the upload.
 *
 * It enforces what a real presigned URL enforces, because a dev double that is
 * more permissive than production teaches you the wrong thing: the key must
 * have an unexpired grant, the signature must match, the content type must be
 * the one that was signed for, and the body must be within the signed size.
 *
 * NEVER REGISTERED IN PRODUCTION. The guard is in the caller, and this module
 * refuses to register itself against a real provider as a second line.
 */
export async function registerDevStorageRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const storage = deps.storage
  if (!(storage instanceof FakeStorageProvider)) return
  if (deps.config.isProduction) return

  // Fastify parses JSON by default; these are raw image bytes.
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES },
    (_request, body, done) => done(null, body),
  )

  app.put<{ Params: { '*': string }; Querystring: { sig?: string } }>(
    '/dev-storage/*',
    async (request, reply) => {
      const storageKey = request.params['*']
      const grant = storage.grantFor(storageKey)

      if (!grant) return reply.status(403).send({ error: 'No presigned grant for this key' })
      if (grant.expiresAt < new Date()) return reply.status(403).send({ error: 'Presigned URL has expired' })
      if (request.query.sig !== storage.signatureFor(storageKey)) {
        return reply.status(403).send({ error: 'Signature does not match' })
      }

      const contentType = request.headers['content-type']
      if (contentType !== grant.contentType) {
        return reply.status(400).send({ error: `Signed for ${grant.contentType}, received ${contentType}` })
      }

      const body = request.body as Buffer | undefined
      if (!body || body.length === 0) return reply.status(400).send({ error: 'Empty body' })
      if (body.length > grant.maxBytes) return reply.status(413).send({ error: 'Too large' })

      storage.completeUpload(storageKey, body.length, grant.contentType)
      return reply.status(200).send({ ok: true, bytes: body.length })
    },
  )

  /** Serves the object back, so an uploaded photo actually renders in the app. */
  app.get<{ Params: { '*': string } }>('/dev-storage/*', async (request, reply) => {
    const object = storage.readObject(request.params['*'])
    if (!object) return reply.status(404).send({ error: 'Not found' })

    // The bytes themselves are not kept — only the size — so this returns a
    // placeholder of the right type and length. Enough for the app to render
    // something and for Content-Length to be honest.
    return reply
      .header('content-type', object.contentType)
      .header('cache-control', 'no-store')
      .status(200)
      .send(Buffer.alloc(object.bytes))
  })
}
