/**
 * Creates or promotes an administrator account.
 *
 * The admin dashboard authenticates against real user accounts so that every
 * fee change and dispute resolution is recorded against a named person. That
 * only works if there is a way to make the first one, and "insert a row by hand
 * with an argon2 hash you generated somehow" is not a way.
 *
 * Usage:
 *   pnpm --filter @grassassassin/api admin:create -- --email a@b.com --password '...' --name 'Ada L'
 *
 * Idempotent: an existing account with that email is granted the ADMIN role
 * rather than duplicated, and its password is only changed if one was given.
 */
import { PrismaClient } from '@prisma/client'
import argon2 from 'argon2'

const prisma = new PrismaClient()

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

// Short enough to type, long enough that the dashboard is not the weakest
// thing protecting the platform's money.
const MIN_PASSWORD = 12

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const email = (arg('--email') ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase()
  const password = arg('--password') ?? process.env.ADMIN_PASSWORD ?? ''
  const name = arg('--name') ?? 'Platform Admin'

  if (!email || !email.includes('@')) {
    throw new Error('An --email is required (or set ADMIN_EMAIL)')
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, roles: true, status: true },
  })

  if (password && password.length < MIN_PASSWORD) {
    throw new Error(`A password must be at least ${MIN_PASSWORD} characters`)
  }
  if (!existing && !password) {
    throw new Error('A --password is required when creating a new account (or set ADMIN_PASSWORD)')
  }

  const [firstName, ...rest] = name.trim().split(/\s+/)
  const lastName = rest.join(' ') || null

  if (existing) {
    const roles = existing.roles.includes('ADMIN') ? existing.roles : [...existing.roles, 'ADMIN' as const]
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        roles: { set: roles },
        // Reactivating deliberately: the operator asked for this account to be
        // an administrator, and leaving it suspended would silently not work.
        status: 'ACTIVE',
        suspendedUntil: null,
        deletedAt: null,
        ...(password ? { passwordHash: await argon2.hash(password, ARGON_OPTIONS) } : {}),
      },
    })
    console.log(
      existing.roles.includes('ADMIN')
        ? `Updated existing administrator ${email}${password ? ' (password changed)' : ''}`
        : `Granted ADMIN to existing account ${email}`,
    )
  } else {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password, ARGON_OPTIONS),
        firstName: firstName ?? 'Admin',
        lastName,
        roles: { set: ['ADMIN'] },
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    })
    console.log(`Created administrator ${email} (${user.id})`)
  }

  await prisma.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action: 'admin.granted',
      entityType: 'User',
      entityId: email,
      after: { email, viaCli: true },
    },
  })
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
