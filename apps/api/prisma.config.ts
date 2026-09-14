import { defineConfig } from 'prisma/config'
import { config as loadDotenv } from 'dotenv'

/**
 * Prisma CLI configuration.
 *
 * Declaring a config file turns OFF Prisma's automatic .env loading, so it has
 * to be done explicitly here — without this, `prisma migrate deploy` fails with
 * "Environment variable not found: DATABASE_URL" even though .env is sitting
 * right there.
 */
loadDotenv({ path: new URL('.env', import.meta.url).pathname, quiet: true })

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { seed: 'tsx prisma/seed.ts' },
})
