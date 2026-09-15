import type { FastifyRequest } from 'fastify'
import type { Db } from '../lib/prisma.js'
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js'

/**
 * Request identity.
 *
 * Populated by the auth plugin from a verified JWT. Nothing here is ever read
 * from a request body or header other than the signed token — a client stating
 * its own role is not evidence of anything.
 */
export interface RequestIdentity {
  userId: string
  roles: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: RequestIdentity
  }
}

export function requireIdentity(request: FastifyRequest): RequestIdentity {
  if (!request.identity) throw new UnauthorizedError()
  return request.identity
}

export function requireRole(request: FastifyRequest, role: string): RequestIdentity {
  const identity = requireIdentity(request)
  if (!identity.roles.includes(role) && !identity.roles.includes('ADMIN')) {
    throw new ForbiddenError(`This action requires the ${role.toLowerCase()} role`)
  }
  return identity
}

export function requireAdmin(request: FastifyRequest): RequestIdentity {
  const identity = requireIdentity(request)
  if (!identity.roles.includes('ADMIN')) throw new ForbiddenError('Administrator access required')
  return identity
}

/**
 * Trusted first-party service calls, acting on behalf of a named administrator.
 *
 * The admin dashboard is a separate process with its own sign-in. It does not
 * hold a user's API token, and it must not: giving it one would mean storing a
 * long-lived credential for a human in a second place. It also must not hold
 * the Stripe keys — a refund should only ever be issued by the one process that
 * owns the money.
 *
 * So it presents a service token proving it is our dashboard, plus the id of
 * the administrator who clicked the button. The id is a claim, and claims are
 * not evidence, so it is checked against the database here: the account must
 * exist, still hold the ADMIN role, and still be active. A compromised
 * dashboard can therefore act only as somebody who really is an administrator,
 * and never as a customer or a worker.
 *
 * Both halves are required. The token alone would leave the audit trail
 * anonymous, which is the problem this whole path exists to avoid.
 */
export async function requireServiceAdmin(
  request: FastifyRequest,
  db: Db,
): Promise<RequestIdentity> {
  const expected = process.env.ADMIN_SERVICE_TOKEN
  if (!expected || expected.length < 32) {
    throw new ForbiddenError('Service-to-service calls are not configured')
  }

  const presented = request.headers['x-service-token']
  if (typeof presented !== 'string' || !timingSafeEqualString(presented, expected)) {
    throw new UnauthorizedError()
  }

  const actingId = request.headers['x-acting-admin-id']
  if (typeof actingId !== 'string' || actingId === '') {
    throw new ForbiddenError('A service call must name the administrator it acts for')
  }

  const user = await db.user.findUnique({
    where: { id: actingId },
    select: { id: true, roles: true, status: true, deletedAt: true, suspendedUntil: true },
  })

  if (
    !user ||
    !user.roles.includes('ADMIN') ||
    user.status !== 'ACTIVE' ||
    user.deletedAt !== null ||
    (user.suspendedUntil !== null && user.suspendedUntil > new Date())
  ) {
    throw new ForbiddenError('Administrator access required')
  }

  return { userId: user.id, roles: user.roles }
}

/** Compares without returning early on the first differing byte. */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}
