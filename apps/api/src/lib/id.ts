import { createId } from '@paralleldrive/cuid2'

/**
 * Identifier generator for rows inserted via raw SQL.
 *
 * Tables carrying PostGIS geography columns cannot be written through Prisma
 * Client (Prisma refuses `create` on a model with a required Unsupported
 * column), so those inserts are raw SQL and must supply their own id — Prisma's
 * `@default(cuid())` is applied client-side, not by the database.
 *
 * cuid2 is collision-resistant and, unlike a sequential id, does not leak row
 * counts to anyone who can see an identifier.
 */
export const newId = createId
