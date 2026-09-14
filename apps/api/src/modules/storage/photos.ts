import type { Db } from '../../lib/prisma.js'
import { Prisma, type JobPhotoKind } from '@prisma/client'
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../../lib/errors.js'
import {
  isAllowedImageType, MAX_PHOTO_BYTES, type StorageProvider,
} from './provider.js'
import type { LatLng } from '@grassassassin/shared'

/**
 * Job photos.
 *
 * Before/after photos are not decoration — they are the evidence package that
 * decides a chargeback. Which is why:
 *
 *   · Only the assigned worker may upload BEFORE/AFTER photos, and only while
 *     the job is in a state where that work is plausible.
 *   · Capture location and time are stored alongside, corroborating the
 *     geofenced check-in.
 *   · A photo row exists in PENDING state from the moment it is presigned, so
 *     an abandoned upload is visible rather than invisible.
 */

export interface PhotoDeps {
  db: Db
  storage: StorageProvider
}

/** Who may upload which kind, and when. */
function assertMayUpload(params: {
  kind: JobPhotoKind
  actorUserId: string
  job: { customerId: string; claimedByWorkerId: string | null; status: string }
}): void {
  const { kind, actorUserId, job } = params
  const isCustomer = job.customerId === actorUserId
  const isWorker = job.claimedByWorkerId === actorUserId

  if (kind === 'LISTING') {
    if (!isCustomer) throw new ForbiddenError('Only the customer can add listing photos')
    if (!['DRAFT', 'POSTED'].includes(job.status)) {
      throw new ConflictError('TOO_LATE', 'Listing photos can only be added before a pro claims the job')
    }
    return
  }

  if (kind === 'BEFORE' || kind === 'AFTER') {
    if (!isWorker) throw new ForbiddenError('Only the assigned pro can add work photos')
    const allowed = kind === 'BEFORE'
      ? ['CLAIMED', 'EN_ROUTE', 'IN_PROGRESS']
      : ['IN_PROGRESS', 'PENDING_APPROVAL']
    if (!allowed.includes(job.status)) {
      throw new ConflictError(
        'WRONG_STAGE',
        `${kind === 'BEFORE' ? 'Before' : 'After'} photos cannot be added while the job is ${job.status}`,
      )
    }
    return
  }

  // ISSUE photos are how a dispute gets evidence, so either party may add them.
  if (!isCustomer && !isWorker) {
    throw new ForbiddenError('You are not a party to this job')
  }
}

export const MAX_PHOTOS_PER_KIND = 10

export interface PresignResult {
  photoId: string
  uploadUrl: string
  requiredHeaders: Record<string, string>
  expiresAt: Date
  maxBytes: number
}

export async function presignJobPhoto(deps: PhotoDeps, params: {
  jobId: string
  actorUserId: string
  kind: JobPhotoKind
  contentType: string
}): Promise<PresignResult> {
  const { db, storage } = deps

  if (!isAllowedImageType(params.contentType)) {
    throw new ValidationError(`Unsupported image type: ${params.contentType}`)
  }

  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: { id: true, customerId: true, claimedByWorkerId: true, status: true },
  })
  if (!job) throw new NotFoundError('Job')

  assertMayUpload({ kind: params.kind, actorUserId: params.actorUserId, job })

  const existing = await db.jobPhoto.count({ where: { jobId: job.id, kind: params.kind } })
  if (existing >= MAX_PHOTOS_PER_KIND) {
    throw new ConflictError('TOO_MANY_PHOTOS', `A job can have at most ${MAX_PHOTOS_PER_KIND} ${params.kind.toLowerCase()} photos`)
  }

  const presigned = await storage.presignUpload({
    keyPrefix: `jobs/${job.id}/${params.kind.toLowerCase()}`,
    contentType: params.contentType,
    maxBytes: MAX_PHOTO_BYTES,
  })

  // The row is created now, in PENDING, so an upload that is started and
  // abandoned is visible rather than leaving an orphaned object nobody knows about.
  const photo = await db.jobPhoto.create({
    data: {
      jobId: job.id,
      uploadedById: params.actorUserId,
      kind: params.kind,
      storageKey: presigned.storageKey,
      url: presigned.publicUrl,
      moderationStatus: 'PENDING',
    },
    select: { id: true },
  })

  return {
    photoId: photo.id,
    uploadUrl: presigned.uploadUrl,
    requiredHeaders: presigned.requiredHeaders,
    expiresAt: presigned.expiresAt,
    maxBytes: MAX_PHOTO_BYTES,
  }
}

/**
 * Confirms an upload landed.
 *
 * The server cannot see the bytes go by, so it verifies afterwards: the object
 * must exist, be within the size cap, and still be an allowed type. A photo
 * that fails any of those is deleted rather than left half-real, because a
 * BEFORE photo that does not exist would otherwise let a worker start a job
 * they are not at.
 */
export async function confirmJobPhoto(deps: PhotoDeps, params: {
  photoId: string
  actorUserId: string
  capturedAt?: Date
  capturedLocation?: LatLng
}): Promise<{ id: string; url: string; bytes: number }> {
  const { db, storage } = deps

  const photo = await db.jobPhoto.findUnique({
    where: { id: params.photoId },
    select: { id: true, jobId: true, uploadedById: true, storageKey: true, url: true, moderationStatus: true },
  })
  if (!photo) throw new NotFoundError('Photo')
  if (photo.uploadedById !== params.actorUserId) {
    throw new ForbiddenError('That is not your upload')
  }

  const object = await storage.headObject(photo.storageKey)
  if (!object.exists) {
    await db.jobPhoto.delete({ where: { id: photo.id } })
    throw new ConflictError('UPLOAD_MISSING', 'The upload did not complete. Please try again.')
  }
  if (object.bytes > MAX_PHOTO_BYTES) {
    await storage.deleteObject(photo.storageKey)
    await db.jobPhoto.delete({ where: { id: photo.id } })
    throw new ValidationError('That image is too large')
  }
  if (object.contentType && !isAllowedImageType(object.contentType)) {
    await storage.deleteObject(photo.storageKey)
    await db.jobPhoto.delete({ where: { id: photo.id } })
    throw new ValidationError('That file is not a supported image')
  }

  await db.jobPhoto.update({
    where: { id: photo.id },
    data: {
      bytes: object.bytes,
      capturedAt: params.capturedAt ?? new Date(),
      // Automated moderation runs asynchronously; APPROVED here means the
      // upload is structurally valid, not that a human has reviewed it.
      moderationStatus: 'APPROVED',
    },
  })

  if (params.capturedLocation) {
    // Corroborates the geofenced check-in. A dispute is much easier to answer
    // with "the photos were taken at the property" than with photos alone.
    await db.$executeRaw(Prisma.sql`
      UPDATE "job_photos"
         SET "capturedLocation" = ST_SetSRID(ST_MakePoint(
               ${params.capturedLocation.lng}::float8, ${params.capturedLocation.lat}::float8), 4326)::geography
       WHERE "id" = ${photo.id}
    `)
  }

  return { id: photo.id, url: photo.url, bytes: object.bytes }
}

/**
 * Photos that were presigned but never confirmed.
 *
 * Swept so an abandoned upload does not count toward the per-kind limit
 * forever, and so a PENDING before-photo cannot be mistaken for a real one.
 */
export async function sweepAbandonedPhotos(db: Db, olderThanMinutes = 60): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
  const result = await db.jobPhoto.deleteMany({
    where: { moderationStatus: 'PENDING', createdAt: { lt: cutoff } },
  })
  return result.count
}

/** Photos that count as real proof. PENDING ones do not. */
export async function confirmedPhotoKinds(db: Db, jobId: string): Promise<Set<JobPhotoKind>> {
  const photos = await db.jobPhoto.findMany({
    where: { jobId, moderationStatus: { not: 'PENDING' } },
    select: { kind: true },
  })
  return new Set(photos.map((p) => p.kind))
}
