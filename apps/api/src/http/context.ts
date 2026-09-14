import type { FastifyRequest } from 'fastify'
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
