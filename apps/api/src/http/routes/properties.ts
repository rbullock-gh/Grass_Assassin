import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { createPropertySchema } from '@grassassassin/shared'
import type { ServerDeps } from '../server.js'
import { requireIdentity } from '../context.js'
import { createProperty } from '../../modules/jobs/repository.js'
import { isWithinServiceArea } from '../../modules/geo/job-search.js'
import { NotFoundError, ForbiddenError, ConflictError } from '../../lib/errors.js'

export async function registerPropertyRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  app.post('/properties', async (request, reply) => {
    const identity = requireIdentity(request)
    const body = createPropertySchema.parse(request.body)

    // Tell someone honestly that we are not live near them rather than letting
    // them post a job onto an empty map and conclude the app is broken.
    if (!(await isWithinServiceArea(deps.db, body.location))) {
      throw new ConflictError(
        'OUTSIDE_SERVICE_AREA',
        'GrassAssassin is not in your area yet. Join the waitlist and we will let you know.',
      )
    }

    const { id } = await createProperty(deps.db, { ownerId: identity.userId, ...body })
    const property = await loadProperty(deps, id)
    return reply.status(201).send(property)
  })

  app.get('/properties', async (request) => {
    const identity = requireIdentity(request)
    const rows = await deps.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "id","label","addressLine1","addressLine2","city","state","postalCode",
             "yardSize"::text AS "yardSize","lotSizeAcres","hasDog","accessNotes",
             ST_Y("location"::geometry) AS lat, ST_X("location"::geometry) AS lng,
             "createdAt"
        FROM "properties"
       WHERE "ownerId" = ${identity.userId} AND "archivedAt" IS NULL
       ORDER BY "createdAt" ASC
    `)
    return { properties: rows }
  })

  app.get<{ Params: { id: string } }>('/properties/:id', async (request) => {
    const identity = requireIdentity(request)
    const property = await deps.db.property.findUnique({
      where: { id: request.params.id },
      select: { id: true, ownerId: true },
    })
    if (!property) throw new NotFoundError('Property')
    if (property.ownerId !== identity.userId) throw new ForbiddenError('That is not your property')
    return loadProperty(deps, request.params.id)
  })

  app.delete<{ Params: { id: string } }>('/properties/:id', async (request, reply) => {
    const identity = requireIdentity(request)
    const property = await deps.db.property.findUnique({
      where: { id: request.params.id },
      select: { id: true, ownerId: true },
    })
    if (!property) throw new NotFoundError('Property')
    if (property.ownerId !== identity.userId) throw new ForbiddenError('That is not your property')

    // Archive rather than delete — completed jobs reference this property and
    // their history must stay intact for disputes and tax records.
    await deps.db.property.update({
      where: { id: request.params.id },
      data: { archivedAt: new Date() },
    })
    return reply.status(204).send()
  })
}

async function loadProperty(deps: ServerDeps, id: string) {
  const rows = await deps.db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT "id","label","addressLine1","addressLine2","city","state","postalCode",
           "yardSize"::text AS "yardSize","lotSizeAcres","gateCode","hasDog","accessNotes",
           ST_Y("location"::geometry) AS lat, ST_X("location"::geometry) AS lng,
           "createdAt"
      FROM "properties" WHERE "id" = ${id}
  `)
  if (!rows[0]) throw new NotFoundError('Property')
  return rows[0]
}
