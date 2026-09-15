import { z } from 'zod'

/**
 * Environment is validated once at boot and then treated as trusted.
 * A missing secret should crash the process on startup, not produce a 500 at
 * 3am under load.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Where this server is reachable from a device, in development.
   *
   * Set it to the machine's LAN address so a phone on the same network can
   * complete a photo upload against the local fake storage; localhost on a
   * phone is the phone.
   */
  PUBLIC_BASE_URL: z.string().url().optional(),
  MAPBOX_ACCESS_TOKEN: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  REDIS_URL: z.string().optional(),

  /**
   * Push delivery through Expo.
   *
   * PUSH_ENABLED is separate from the access token on purpose: Expo accepts
   * unauthenticated sends until a project turns on push security, so "we have a
   * token" is not the same question as "should this process send". A staging
   * copy of production data with push on is how a customer gets a notification
   * about a job that does not exist.
   */
  PUSH_ENABLED: z.enum(['true', 'false']).default('false'),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  /**
   * Transactional email.
   *
   * EMAIL_ENABLED is separate from the API key for the same reason PUSH_ENABLED
   * is: having a credential is not the same question as whether this process
   * should be mailing real people. A staging environment restored from a
   * production dump has every real address in it.
   *
   * MAIL_FROM must be on a domain verified with the provider or every send is
   * refused — which is worth knowing at boot rather than the first time
   * somebody forgets their password.
   */
  EMAIL_ENABLED: z.enum(['true', 'false']).default('false'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().email().optional(),

  /**
   * Where a password-reset link points.
   *
   * The app's custom scheme, so the link opens the app rather than a browser.
   * Overridable for a development build, or for a web reset page later.
   */
  RESET_LINK_BASE: z.string().default('grassassassin://reset-password'),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  cached = parsed.data
  return cached
}

/** Test helper — never call in production code. */
export function resetEnvCache(): void {
  cached = null
}
