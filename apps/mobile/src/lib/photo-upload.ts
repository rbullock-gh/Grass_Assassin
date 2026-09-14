import type { PhotoKind } from '@grassassassin/client'
import { api } from './api'

/**
 * Taking a photo and getting it to storage.
 *
 * Three steps, and all three have to succeed or the photo does not count:
 * ask the API for an upload URL, PUT the bytes straight to storage, then tell
 * the API they landed. The middle step bypasses the API entirely — a worker on
 * a rural signal pushing four 3MB images through it would hold a connection
 * open for minutes.
 *
 * The confirm is what makes a photo real. Until then the row is PENDING and
 * does not satisfy the before/after gate, which is deliberate: presigning alone
 * must not be a way to tick the box without uploading anything.
 */

export interface UploadedPhoto {
  id: string
  url: string
}

export type UploadFailure =
  | { reason: 'CANCELLED' }
  | { reason: 'PERMISSION' }
  | { reason: 'TOO_LARGE'; maxBytes: number }
  | { reason: 'NETWORK'; message: string }

export type UploadResult =
  | { ok: true; photo: UploadedPhoto }
  | { ok: false; failure: UploadFailure }

/** JPEG everywhere: it is what the server accepts and what a camera produces. */
export const UPLOAD_CONTENT_TYPE = 'image/jpeg'

/**
 * How hard to compress before uploading.
 *
 * 0.7 at 1600px keeps a lawn legible for a dispute while taking a 4MB camera
 * frame to roughly 400KB. The photo exists to answer "was this actually mowed",
 * not to be printed.
 */
export const UPLOAD_QUALITY = 0.7

export interface ImageAsset {
  uri: string
  fileSize?: number | undefined
}

/**
 * The upload itself, separated from the picker so it can be tested.
 *
 * Takes an already-chosen image and a fetch, so the whole three-step dance can
 * be exercised without a camera, a device, or a network.
 */
export async function uploadJobPhoto(params: {
  jobId: string
  kind: PhotoKind
  asset: ImageAsset
  capturedLocation?: { lat: number; lng: number } | undefined
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}): Promise<UploadResult> {
  const doFetch = params.fetchImpl ?? fetch

  let presigned
  try {
    presigned = await api.presignPhoto(params.jobId, {
      kind: params.kind,
      contentType: UPLOAD_CONTENT_TYPE,
    })
  } catch (error) {
    return { ok: false, failure: { reason: 'NETWORK', message: messageOf(error) } }
  }

  // Checked before spending the worker's data on an upload the server will
  // reject on confirm anyway.
  if (params.asset.fileSize !== undefined && params.asset.fileSize > presigned.maxBytes) {
    return { ok: false, failure: { reason: 'TOO_LARGE', maxBytes: presigned.maxBytes } }
  }

  try {
    const body = await (await doFetch(params.asset.uri)).blob()
    const response = await doFetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.requiredHeaders,
      body,
    })
    if (!response.ok) {
      return { ok: false, failure: { reason: 'NETWORK', message: `Upload failed (${response.status})` } }
    }
  } catch (error) {
    return { ok: false, failure: { reason: 'NETWORK', message: messageOf(error) } }
  }

  try {
    const confirmed = await api.confirmPhoto(presigned.photoId, {
      capturedAt: new Date().toISOString(),
      ...(params.capturedLocation ? { capturedLocation: params.capturedLocation } : {}),
    })
    return { ok: true, photo: { id: confirmed.id, url: confirmed.url } }
  } catch (error) {
    // The bytes are in storage but the server does not know. Reported as a
    // failure because from the worker's side nothing has happened — the gate
    // is still closed and they need to try again.
    return { ok: false, failure: { reason: 'NETWORK', message: messageOf(error) } }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Check your connection and try again.'
}

/** What to tell the worker when an upload does not work. */
export function failureMessage(failure: UploadFailure): string {
  switch (failure.reason) {
    case 'CANCELLED':
      return ''
    case 'PERMISSION':
      return 'GrassAssassin needs camera access to take before and after photos. Enable it in Settings.'
    case 'TOO_LARGE':
      return `That photo is too large — the limit is ${Math.round(failure.maxBytes / 1_000_000)}MB. Try again with a lower camera resolution.`
    case 'NETWORK':
      return failure.message
  }
}

/**
 * How many photos each gate needs.
 *
 * Stated here rather than inline so the screen and the message agree about
 * what is required. Both gates are one photo: more is better evidence, but
 * demanding four before a worker can start is how a gate becomes a reason to
 * quit the job.
 */
export const REQUIRED_PHOTOS: Record<'BEFORE' | 'AFTER', number> = { BEFORE: 1, AFTER: 1 }

export function gateSatisfied(kind: 'BEFORE' | 'AFTER', confirmedCount: number): boolean {
  return confirmedCount >= REQUIRED_PHOTOS[kind]
}

export function gatePrompt(kind: 'BEFORE' | 'AFTER', confirmedCount: number): string {
  if (gateSatisfied(kind, confirmedCount)) {
    return kind === 'BEFORE'
      ? `${confirmedCount} before photo${confirmedCount === 1 ? '' : 's'} — you can start`
      : `${confirmedCount} after photo${confirmedCount === 1 ? '' : 's'} — you can finish`
  }
  return kind === 'BEFORE'
    ? 'Take a photo of the yard before you start. It is what protects you if the customer disputes the work.'
    : 'Take a photo of the finished work. The customer sees this when they approve.'
}
