import type { LatLng } from '@grassassassin/shared'

/**
 * Typed API client, shared by the mobile app, the customer web app, and admin.
 *
 * Deliberately built on plain fetch with no HTTP library: React Native, Next.js
 * server components and the browser all provide fetch, and a dependency here
 * would have to work identically in all three.
 *
 * Token refresh is handled inside the client rather than at each call site.
 * A 401 triggers one refresh attempt and one retry; concurrent 401s share a
 * single in-flight refresh, because five screens refreshing at once would
 * otherwise rotate the token five times and trip the server's reuse detection —
 * logging the user out for doing nothing wrong.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** True when retrying later could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429
  }

  /** True when the user needs to sign in again. */
  get isAuthFailure(): boolean {
    return this.status === 401
  }
}

export interface TokenStore {
  getAccessToken(): Promise<string | null> | string | null
  getRefreshToken(): Promise<string | null> | string | null
  setTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> | void
  clear(): Promise<void> | void
}

/** In-memory store. Real clients use SecureStore (mobile) or httpOnly cookies (web). */
export class MemoryTokenStore implements TokenStore {
  private accessToken: string | null = null
  private refreshToken: string | null = null

  getAccessToken() { return this.accessToken }
  getRefreshToken() { return this.refreshToken }
  setTokens(tokens: { accessToken: string; refreshToken: string }) {
    this.accessToken = tokens.accessToken
    this.refreshToken = tokens.refreshToken
  }
  clear() {
    this.accessToken = null
    this.refreshToken = null
  }
}

export interface ClientOptions {
  baseUrl: string
  tokens?: TokenStore
  /** Called when refresh fails and the user must sign in again. */
  onAuthExpired?: () => void
  fetchImpl?: typeof fetch
}

export class GrassAssassinClient {
  private readonly baseUrl: string
  private readonly tokens: TokenStore
  private readonly fetchImpl: typeof fetch
  private readonly onAuthExpired?: () => void
  /** Shared across concurrent 401s so the refresh token rotates once, not N times. */
  private refreshInFlight: Promise<boolean> | null = null

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.tokens = options.tokens ?? new MemoryTokenStore()
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.onAuthExpired = options.onAuthExpired
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, unknown>; retryOn401?: boolean } = {},
  ): Promise<T> {
    const retryOn401 = options.retryOn401 ?? true
    const url = new URL(`${this.baseUrl}${path}`)

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item))
        } else {
          url.searchParams.set(key, String(value))
        }
      }
    }

    const accessToken = await this.tokens.getAccessToken()
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (accessToken) headers['authorization'] = `Bearer ${accessToken}`

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    if (response.status === 401 && retryOn401) {
      const refreshed = await this.refreshTokens()
      if (refreshed) {
        return this.request<T>(method, path, { ...options, retryOn401: false })
      }
      this.onAuthExpired?.()
    }

    if (response.status === 204) return undefined as T

    const text = await response.text()
    const payload: unknown = text ? JSON.parse(text) : null

    if (!response.ok) {
      const body = payload as ApiErrorBody | null
      throw new ApiError(
        body?.error?.code ?? 'UNKNOWN',
        body?.error?.message ?? `Request failed with status ${response.status}`,
        response.status,
        body?.error?.details,
      )
    }

    return payload as T
  }

  private refreshTokens(): Promise<boolean> {
    // Collapse concurrent refreshes into one. Rotating the refresh token five
    // times in parallel would look exactly like token theft to the server.
    this.refreshInFlight ??= (async () => {
      try {
        const refreshToken = await this.tokens.getRefreshToken()
        if (!refreshToken) return false

        const response = await this.fetchImpl(`${this.baseUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        if (!response.ok) {
          await this.tokens.clear()
          return false
        }
        const tokens = (await response.json()) as { accessToken: string; refreshToken: string }
        await this.tokens.setTokens(tokens)
        return true
      } catch {
        return false
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }

  // --- auth ---------------------------------------------------------------

  async register(input: {
    email: string; password: string; firstName: string
    lastName?: string; phone?: string; intent: 'CUSTOMER' | 'WORKER'
  }) {
    const result = await this.request<AuthResponse>('POST', '/v1/auth/register', { body: input })
    await this.tokens.setTokens(result.tokens)
    return result
  }

  async login(input: { email: string; password: string }) {
    const result = await this.request<AuthResponse>('POST', '/v1/auth/login', { body: input })
    await this.tokens.setTokens(result.tokens)
    return result
  }

  async logout() {
    const refreshToken = await this.tokens.getRefreshToken()
    if (refreshToken) {
      await this.request<void>('POST', '/v1/auth/logout', { body: { refreshToken } }).catch(() => undefined)
    }
    await this.tokens.clear()
  }

  me() { return this.request<MeResponse>('GET', '/v1/me') }

  addRole(role: 'CUSTOMER' | 'WORKER') {
    return this.request<{ roles: string[] }>('POST', '/v1/auth/add-role', { body: { role } })
  }

  // --- catalogue ----------------------------------------------------------

  categories() { return this.request<{ categories: Category[] }>('GET', '/v1/categories') }
  equipment() { return this.request<{ equipment: Equipment[] }>('GET', '/v1/equipment') }

  priceGuidance(categoryId: string, yardSize?: string) {
    return this.request<PriceGuidance>('GET', '/v1/jobs/price-guidance', {
      query: { categoryId, yardSize },
    })
  }

  // --- properties ---------------------------------------------------------

  properties() { return this.request<{ properties: PropertySummary[] }>('GET', '/v1/properties') }

  createProperty(input: CreatePropertyInput) {
    return this.request<PropertySummary>('POST', '/v1/properties', { body: input })
  }

  // --- jobs ---------------------------------------------------------------

  createJob(input: CreateJobInput) {
    return this.request<JobSummary>('POST', '/v1/jobs', { body: input })
  }

  searchJobs(input: SearchJobsInput) {
    return this.request<{ jobs: MapJob[]; radiusMilesApplied: number }>('GET', '/v1/jobs/search', {
      query: {
        lat: input.center.lat,
        lng: input.center.lng,
        // Sent so "due today" means today where the USER is, not where the
        // server is. Defaults to this device's offset rather than making every
        // caller remember.
        tzOffsetMinutes: input.tzOffsetMinutes ?? new Date().getTimezoneOffset(),
        radiusMiles: input.radiusMiles,
        minPayoutCents: input.minPayoutCents,
        categoryIds: input.categoryIds,
        equipmentProvided: input.equipmentProvided,
        difficulty: input.difficulty,
        dueToday: input.dueToday,
        dueThisWeek: input.dueThisWeek,
        sort: input.sort,
        limit: input.limit,
      },
    })
  }

  job(id: string) { return this.request<JobDetail>('GET', `/v1/jobs/${id}`) }

  myJobs(role: 'CUSTOMER' | 'WORKER', activeOnly = false) {
    return this.request<{ jobs: JobSummary[] }>('GET', '/v1/jobs/mine', {
      query: { role, active: activeOnly || undefined },
    })
  }

  /**
   * Claims a job.
   *
   * Losing is NOT an error — it resolves with outcome: 'LOST'. Treating a lost
   * race as an exception would push every caller into a try/catch for the
   * single most common non-happy outcome in the product.
   */
  claimJob(jobId: string, workerLocation?: LatLng) {
    return this.request<ClaimResponse>('POST', `/v1/jobs/${jobId}/claim`, {
      body: { workerLocation },
    })
  }

  updateJobStatus(jobId: string, to: string, options: { workerLocation?: LatLng; note?: string } = {}) {
    return this.request<{ status: string }>('POST', `/v1/jobs/${jobId}/status`, {
      body: { to, ...options },
    })
  }

  cancellationPreview(jobId: string) {
    return this.request<CancellationPreview>('GET', `/v1/jobs/${jobId}/cancellation-preview`)
  }

  cancelJob(jobId: string, reason?: string) {
    return this.request<CancellationPreview>('POST', `/v1/jobs/${jobId}/cancel`, { body: { reason } })
  }

  reviewJob(jobId: string, input: { rating: number; comment?: string; tags?: string[] }) {
    return this.request<unknown>('POST', `/v1/jobs/${jobId}/review`, { body: input })
  }

  tipWorker(jobId: string, amountCents: number) {
    return this.request<{ ok: boolean; tipId?: string }>('POST', `/v1/jobs/${jobId}/tip`, {
      body: { amountCents },
    })
  }

  /**
   * Turns a finished job into a standing appointment.
   *
   * Offered right after a good rating, which is the moment the customer has
   * just confirmed they are happy — see the recurring route for why that
   * placement matters more than the feature itself.
   */
  makeRecurring(jobId: string, input: {
    interval: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
    priceCents?: number
    preferPreviousWorker?: boolean
  }) {
    return this.request<RecurringJobSummary>('POST', `/v1/jobs/${jobId}/make-recurring`, { body: input })
  }

  recurringJobs() {
    return this.request<{ subscriptions: RecurringSubscription[] }>('GET', '/v1/recurring')
  }

  updateRecurringJob(id: string, input: {
    active?: boolean
    interval?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
    priceCents?: number
    /** Null clears an existing pause. */
    pauseUntil?: string | null
    nextRunAt?: string
  }) {
    return this.request<RecurringJobSummary>('PATCH', `/v1/recurring/${id}`, { body: input })
  }

  // --- messages -----------------------------------------------------------

  conversations() {
    return this.request<{ conversations: ConversationSummary[] }>('GET', '/v1/conversations')
  }

  /**
   * A job's thread. Addressed by job because that is what every caller has.
   *
   * Reading marks the other party's messages as read, so this is not safe to
   * call speculatively in the background.
   */
  jobMessages(jobId: string) {
    return this.request<MessageThread>('GET', `/v1/jobs/${jobId}/messages`)
  }

  sendMessage(jobId: string, body: string) {
    return this.request<{ message: ChatMessage; notice: string | null }>(
      'POST', `/v1/jobs/${jobId}/messages`, { body: { body } })
  }

  // --- worker -------------------------------------------------------------

  workerProfile(id: string) { return this.request<WorkerPublicProfile>('GET', `/v1/workers/${id}`) }
  earnings() { return this.request<Earnings>('GET', '/v1/worker/earnings') }

  updateWorkerProfile(input: {
    bio?: string; serviceRadiusMiles?: number; baseLocation?: LatLng
    categoryIds?: string[]; equipmentIds?: string[]
  }) {
    return this.request<{ ok: boolean }>('PATCH', '/v1/worker/profile', { body: input })
  }

  leaderboard(scope: 'LOCAL' | 'CITY' | 'ROOKIE' = 'CITY', period: 'WEEKLY' | 'MONTHLY' | 'ALL_TIME' = 'WEEKLY') {
    return this.request<Leaderboard>('GET', '/v1/leaderboard', { query: { scope, period } })
  }
}

// --- response shapes -------------------------------------------------------

export interface AuthResponse {
  user: { id: string; email: string; firstName: string; roles: string[] }
  tokens: { accessToken: string; refreshToken: string; expiresIn: number }
}

export interface MeResponse {
  id: string; email: string; firstName: string; lastName: string | null
  avatarUrl: string | null; roles: string[]
  emailVerifiedAt: string | null; phoneVerifiedAt: string | null
  customerProfile: {
    averageRating: number | null; ratingCount: number
    jobsPosted: number; jobsCompleted: number
  } | null
  workerProfile: {
    id: string; status: string; bio: string | null; serviceRadiusMiles: number
    points: number; completedJobs: number; averageRating: number | null; ratingCount: number
    completionRate: number; onTimeRate: number; currentStreak: number
    availableBalanceCents: number; lifetimeEarningsCents: number
    payoutsEnabled: boolean; backgroundCheckStatus: string
    rank: { key: string; name: string; minPoints: number; commissionDiscountBps: number; verifiedBadge: boolean } | null
  } | null
}

export interface Category {
  id: string; slug: string; name: string; icon: string | null
  difficulty: number; baseMinutes: number; typicalLowCents: number; typicalHighCents: number
}

export interface Equipment { id: string; slug: string; name: string; icon: string | null }

export interface PriceGuidance {
  suggestedLowCents: number; suggestedHighCents: number; estimatedMinutes: number
}

export interface PropertySummary {
  id: string; label: string; addressLine1: string; addressLine2: string | null
  city: string; state: string; postalCode: string
  yardSize: string; lotSizeAcres: number | null; hasDog: boolean
  lat: number; lng: number
}

export interface CreatePropertyInput {
  label: string; addressLine1: string; addressLine2?: string
  city: string; state: string; postalCode: string
  location: LatLng; yardSize: string
  gateCode?: string; hasDog?: boolean; accessNotes?: string
}

export interface CreateJobInput {
  propertyId: string; categoryId: string; title?: string; description?: string
  priceCents: number; dueAt: string
  windowStartAt?: string; windowEndAt?: string
  yardSize?: string; equipmentProvided?: boolean
  specialInstructions?: string; photoIds?: string[]
}

export interface MapJob {
  id: string; title: string; description: string | null
  categoryId: string; categoryName: string; categoryIcon: string | null
  priceCents: number; workerPayoutCents: number
  yardSize: string | null; estimatedMinutes: number | null; payPerHourCents: number | null
  difficulty: string; equipmentProvided: boolean
  dueAt: string; windowStartAt: string | null; windowEndAt: string | null; postedAt: string
  approximateLocation: LatLng; distanceMeters: number; distanceMiles: number
  generalArea: string
  customerRating: number | null; customerCompletedJobs: number
  isPremium: boolean; isFeatured: boolean
}

export interface JobSummary {
  id: string; title: string; status: string
  priceCents: number; workerPayoutCents: number
  dueAt: string; generalArea: string
  category?: { name: string; icon: string | null }
}

export interface AssignedWorker {
  id: string; firstName: string; avatarUrl: string | null
  rating: number | null; completedJobs: number; onTimeRate: number | null
  rank: { key: string; name: string; verifiedBadge: boolean; colorHex: string | null } | null
}

export interface RecurringJobSummary {
  id: string; interval: string; priceCents: number
  nextRunAt: string
  active?: boolean
  pausedUntil?: string | null
  preferredWorkerId?: string | null
}

export interface RecurringSubscription extends RecurringJobSummary {
  active: boolean
  lastRunAt: string | null
  pausedUntil: string | null
  category: { id: string; name: string; icon: string | null }
  property: { id: string; label: string; city: string; state: string }
  _count: { jobs: number }
}

export interface JobDetail extends JobSummary {
  description: string | null; specialInstructions: string | null
  yardSize: string | null
  serviceFeeCents?: number; customerTotalCents?: number
  estimatedMinutes: number | null; difficulty: string; equipmentProvided: boolean
  location: LatLng | null
  locationPrecision: 'EXACT' | 'APPROXIMATE'
  address: {
    addressLine1: string; addressLine2: string | null; city: string; state: string
    postalCode: string; gateCode: string | null; hasDog: boolean; accessNotes: string | null
  } | null
  photos: Array<{ id: string; kind: string; url: string; createdAt: string }>
  customer: { id: string; firstName: string; avatarUrl: string | null; rating: number | null; completedJobs: number }
  /** Null until someone has claimed. Reputation only — never contact details. */
  worker: AssignedWorker | null
  claimedAt: string | null
  completedAt: string | null
  /**
   * When unreviewed work will approve itself. Null unless awaiting approval.
   * Sent by the server because the window is admin-configurable.
   */
  autoApproveAt: string | null
  windowStartAt: string | null
  windowEndAt: string | null
  postedAt: string | null
  viewerRole: 'CUSTOMER' | 'WORKER' | 'VIEWER'
}

export interface SearchJobsInput {
  center: LatLng; radiusMiles?: number
  minPayoutCents?: number; categoryIds?: string[]
  equipmentProvided?: boolean; difficulty?: string
  dueToday?: boolean; dueThisWeek?: boolean
  /** From Date.getTimezoneOffset(); defaults to the current device. */
  tzOffsetMinutes?: number
  sort?: 'DISTANCE' | 'PAY_DESC' | 'NEWEST' | 'DUE_SOON' | 'PAY_PER_HOUR'
  limit?: number
}

export type ClaimResponse =
  | { outcome: 'WON'; jobId: string; claimId: string; expiresAt: string; status?: string }
  | { outcome: 'LOST'; jobId: string; reason: string; message: string }

export interface CancellationPreview {
  customerRefundCents: number; workerCompensationCents: number
  platformRetainedCents: number; reason: string
}

export interface WorkerPublicProfile {
  id: string; firstName: string; avatarUrl: string | null; bio: string | null
  rank: { key: string; name: string; verifiedBadge: boolean; colorHex: string | null } | null
  points: number; completedJobs: number
  rating: number | null; ratingCount: number
  completionRate: number; onTimeRate: number
  currentStreak: number; repeatCustomers: number; memberSince: string
  services: Array<{ id: string; name: string; icon: string | null }>
  equipment: Array<{ id: string; name: string; icon: string | null }>
  badges: Array<{ key: string; name: string; description: string; awardedAt: string }>
  reviews: Array<{
    rating: number; comment: string | null; tags: string[]; createdAt: string
    author: { firstName: string; avatarUrl: string | null }
  }>
}

export interface ChatMessage {
  id: string
  senderId: string | null
  kind: 'TEXT' | 'PHOTO' | 'SYSTEM'
  body: string | null
  attachmentUrl?: string | null
  readAt: string | null
  createdAt: string
}

export interface ConversationSummary {
  id: string
  jobId: string
  job: {
    id: string; title: string; status: string; dueAt: string
    category: { name: string; icon: string | null } | null
  }
  counterpartId: string
  lastMessage: Pick<ChatMessage, 'body' | 'kind' | 'senderId' | 'createdAt'> | null
  lastMessageAt: string | null
  unreadCount: number
  open: boolean
}

export interface MessageThread {
  conversationId: string
  jobId: string
  open: boolean
  /** Why it is read-only. Null while open. */
  closedReason: string | null
  counterpart: { id: string; firstName: string; avatarUrl: string | null }
  messages: ChatMessage[]
}

export interface Earnings {
  availableBalanceCents: number; pendingBalanceCents: number; lifetimeEarningsCents: number
  thisWeek: { earningsCents: number; jobsCompleted: number; tipsCents: number }
  payouts: Array<{
    id: string; amountCents: number; status: string
    instant: boolean; arrivalDate: string | null; createdAt: string
  }>
}

export interface Leaderboard {
  scope: string; period: string
  entries: Array<{
    rank: number; workerId: string; firstName: string; avatarUrl: string | null
    rankName: string | null; points: number; jobsCompleted: number
  }>
}
