import { PrismaClient } from '@prisma/client'

/**
 * Single Prisma instance per process.
 *
 * In development, tsx watch reloads modules on every save; without this guard
 * each reload would open a fresh connection pool and exhaust Postgres within a
 * few minutes of editing.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export type Db = PrismaClient
/** Transaction client — the subset available inside prisma.$transaction. */
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>
