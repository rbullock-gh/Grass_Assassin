import { createHash, randomBytes } from 'node:crypto'

/**
 * Object storage port.
 *
 * Photos are uploaded DIRECTLY from the device to storage using a presigned
 * URL. They never pass through the API, for three reasons:
 *
 *   · A worker on a rural signal uploading four 3MB photos would hold an API
 *     connection open for minutes; the API process is not where that belongs.
 *   · Proxying doubles the bandwidth bill — in once, out once.
 *   · A presigned URL is scoped to one key, one method and a short expiry, so
 *     a leaked one is far less dangerous than an upload endpoint.
 *
 * The tradeoff is that the server cannot inspect the bytes, so the constraints
 * have to be baked into the presigned policy (content type, max size) and the
 * result confirmed afterwards.
 */

export interface PresignedUpload {
  /** Where the client PUTs the bytes. */
  uploadUrl: string
  /** Storage key, recorded so the object can be found or deleted later. */
  storageKey: string
  /** Public URL once the upload completes. */
  publicUrl: string
  /** Headers the client must send, or the signature will not match. */
  requiredHeaders: Record<string, string>
  expiresAt: Date
}

export interface StorageProvider {
  readonly name: string
  presignUpload(params: {
    keyPrefix: string
    contentType: string
    maxBytes: number
    expiresInSeconds?: number
  }): Promise<PresignedUpload>
  /** Confirms an object exists and reports its size, for post-upload validation. */
  headObject(storageKey: string): Promise<{ exists: boolean; bytes: number; contentType: string | null }>
  deleteObject(storageKey: string): Promise<void>
}

/** Image types we accept. Deliberately narrow. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/**
 * 12MB.
 *
 * A modern phone photo is 2–5MB and the client resizes to 1600px before
 * upload, so this is generous headroom rather than a target. It exists to stop
 * someone using our storage as a free file host.
 */
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024

export function isAllowedImageType(contentType: string): contentType is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)
}

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/heic': return 'heic'
    default: return 'jpg'
  }
}

/**
 * In-memory storage for tests and local development.
 *
 * Models the parts that matter: a key is only writable through a presigned URL
 * that has not expired, and headObject reports what was actually stored.
 */
export class FakeStorageProvider implements StorageProvider {
  readonly name = 'fake'
  private readonly objects = new Map<string, { bytes: number; contentType: string }>()
  private readonly presigned = new Map<string, { expiresAt: Date; contentType: string; maxBytes: number }>()

  async presignUpload(params: {
    keyPrefix: string
    contentType: string
    maxBytes: number
    expiresInSeconds?: number
  }): Promise<PresignedUpload> {
    const storageKey = `${params.keyPrefix}/${randomBytes(12).toString('hex')}.${extensionFor(params.contentType)}`
    const expiresAt = new Date(Date.now() + (params.expiresInSeconds ?? 900) * 1000)
    this.presigned.set(storageKey, {
      expiresAt, contentType: params.contentType, maxBytes: params.maxBytes,
    })
    return {
      uploadUrl: `https://storage.test/upload/${storageKey}?sig=${createHash('sha256').update(storageKey).digest('hex').slice(0, 16)}`,
      storageKey,
      publicUrl: `https://cdn.test/${storageKey}`,
      requiredHeaders: { 'content-type': params.contentType },
      expiresAt,
    }
  }

  async headObject(storageKey: string) {
    const object = this.objects.get(storageKey)
    return object
      ? { exists: true, bytes: object.bytes, contentType: object.contentType }
      : { exists: false, bytes: 0, contentType: null }
  }

  async deleteObject(storageKey: string): Promise<void> {
    this.objects.delete(storageKey)
  }

  /** Test helper: simulates the client completing an upload. */
  completeUpload(storageKey: string, bytes: number, contentType = 'image/jpeg'): boolean {
    const grant = this.presigned.get(storageKey)
    if (!grant) return false
    if (grant.expiresAt < new Date()) return false
    if (bytes > grant.maxBytes) return false
    this.objects.set(storageKey, { bytes, contentType })
    return true
  }

  /** Test helper: expires a grant without waiting. */
  expireGrant(storageKey: string): void {
    const grant = this.presigned.get(storageKey)
    if (grant) grant.expiresAt = new Date(Date.now() - 1000)
  }

  reset(): void {
    this.objects.clear()
    this.presigned.clear()
  }
}
