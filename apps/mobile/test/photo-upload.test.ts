import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  uploadJobPhoto, failureMessage, gateSatisfied, gatePrompt, REQUIRED_PHOTOS,
} from '@/lib/photo-upload'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: { presignPhoto: vi.fn(), confirmPhoto: vi.fn() },
}))

const presign = vi.mocked(api.presignPhoto)
const confirm = vi.mocked(api.confirmPhoto)

const PRESIGNED = {
  photoId: 'photo-1',
  uploadUrl: 'https://storage.test/upload/photo-1',
  requiredHeaders: { 'content-type': 'image/jpeg', 'x-amz-acl': 'private' },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  maxBytes: 10_000_000,
}

const CONFIRMED = {
  id: 'photo-1', kind: 'BEFORE' as const, url: 'https://storage.test/photo-1.jpg',
  bytes: 412_000, createdAt: new Date().toISOString(),
}

function fakeFetch(overrides: { putStatus?: number; throwOn?: 'READ' | 'PUT' } = {}) {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    if (init?.method === 'PUT') {
      if (overrides.throwOn === 'PUT') throw new Error('Network request failed')
      return { ok: (overrides.putStatus ?? 200) < 400, status: overrides.putStatus ?? 200 }
    }
    if (overrides.throwOn === 'READ') throw new Error('Could not read the image')
    return { ok: true, status: 200, blob: async () => new Uint8Array([1, 2, 3]) }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.clearAllMocks()
  presign.mockResolvedValue(PRESIGNED)
  confirm.mockResolvedValue(CONFIRMED)
})

describe('uploading a job photo', () => {
  it('presigns, PUTs the bytes, then confirms', async () => {
    const doFetch = fakeFetch()
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/photo.jpg', fileSize: 412_000 },
      fetchImpl: doFetch,
    })

    expect(result).toEqual({ ok: true, photo: { id: 'photo-1', url: CONFIRMED.url } })
    expect(presign).toHaveBeenCalledWith('job-1', { kind: 'BEFORE', contentType: 'image/jpeg' })
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('sends the required headers verbatim on the PUT', async () => {
    // Storage rejects the upload without them, and the failure is a 403 that
    // says nothing useful.
    const doFetch = fakeFetch()
    await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/photo.jpg' },
      fetchImpl: doFetch,
    })
    const put = vi.mocked(doFetch).mock.calls.find(([, init]) => (init as { method?: string })?.method === 'PUT')
    expect(put?.[0]).toBe(PRESIGNED.uploadUrl)
    expect((put?.[1] as { headers: unknown }).headers).toEqual(PRESIGNED.requiredHeaders)
  })

  it('attaches the location when we have one', async () => {
    // "The photo was taken at the property" is the single most useful fact in
    // a dispute.
    await uploadJobPhoto({
      jobId: 'job-1', kind: 'AFTER',
      asset: { uri: 'file:///tmp/photo.jpg' },
      capturedLocation: { lat: 36.1627, lng: -86.7816 },
      fetchImpl: fakeFetch(),
    })
    expect(confirm).toHaveBeenCalledWith('photo-1', expect.objectContaining({
      capturedLocation: { lat: 36.1627, lng: -86.7816 },
    }))
  })

  it('still uploads when there is no location', async () => {
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'AFTER',
      asset: { uri: 'file:///tmp/photo.jpg' },
      fetchImpl: fakeFetch(),
    })
    expect(result.ok).toBe(true)
    expect(confirm.mock.calls[0]![1]).not.toHaveProperty('capturedLocation')
  })

  it('refuses an oversized photo BEFORE spending the data on it', async () => {
    const doFetch = fakeFetch()
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/huge.jpg', fileSize: 40_000_000 },
      fetchImpl: doFetch,
    })
    expect(result).toEqual({ ok: false, failure: { reason: 'TOO_LARGE', maxBytes: 10_000_000 } })
    // The whole point: no upload was attempted.
    expect(vi.mocked(doFetch)).not.toHaveBeenCalled()
  })

  it('reports a rejected upload rather than claiming success', async () => {
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/photo.jpg' },
      fetchImpl: fakeFetch({ putStatus: 403 }),
    })
    expect(result.ok).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not confirm a photo whose bytes never arrived', async () => {
    // Confirming an upload that failed would tick the gate with nothing behind
    // it — the exact hole the PENDING state exists to close.
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/photo.jpg' },
      fetchImpl: fakeFetch({ throwOn: 'PUT' }),
    })
    expect(result.ok).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('treats a failed confirm as a failure, not a success', async () => {
    // The bytes are in storage but the server does not know, so the gate is
    // still shut. Telling the worker it worked would strand them.
    confirm.mockRejectedValueOnce(new Error('Gateway timeout'))
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/photo.jpg' },
      fetchImpl: fakeFetch(),
    })
    expect(result.ok).toBe(false)
  })

  it('reports a presign failure without attempting an upload', async () => {
    presign.mockRejectedValueOnce(new Error('You are not on this job'))
    const doFetch = fakeFetch()
    const result = await uploadJobPhoto({
      jobId: 'job-1', kind: 'BEFORE',
      asset: { uri: 'file:///tmp/photo.jpg' },
      fetchImpl: doFetch,
    })
    expect(result).toEqual({ ok: false, failure: { reason: 'NETWORK', message: 'You are not on this job' } })
    expect(vi.mocked(doFetch)).not.toHaveBeenCalled()
  })
})

describe('what the worker is told', () => {
  it('says nothing when they simply backed out', () => {
    expect(failureMessage({ reason: 'CANCELLED' })).toBe('')
  })

  it('says how to fix a permission problem', () => {
    expect(failureMessage({ reason: 'PERMISSION' })).toContain('Settings')
  })

  it('gives the size limit in megabytes, not bytes', () => {
    expect(failureMessage({ reason: 'TOO_LARGE', maxBytes: 10_000_000 })).toContain('10MB')
  })

  it("passes the server's own message through", () => {
    expect(failureMessage({ reason: 'NETWORK', message: 'You are not on this job' }))
      .toBe('You are not on this job')
  })
})

describe('the gates', () => {
  it('needs one photo each, not a portfolio', () => {
    // Demanding four before a worker can start is how a gate becomes a reason
    // to abandon the job.
    expect(REQUIRED_PHOTOS).toEqual({ BEFORE: 1, AFTER: 1 })
  })

  it('is shut at zero and open at one', () => {
    expect(gateSatisfied('BEFORE', 0)).toBe(false)
    expect(gateSatisfied('BEFORE', 1)).toBe(true)
    expect(gateSatisfied('AFTER', 0)).toBe(false)
    expect(gateSatisfied('AFTER', 2)).toBe(true)
  })

  it("explains why the photo matters, from the worker's side", () => {
    // "Protects you if the customer disputes" is a reason to comply.
    // "Required" is a reason to resent it.
    expect(gatePrompt('BEFORE', 0)).toContain('protects you')
    expect(gatePrompt('AFTER', 0)).toContain('customer sees this')
  })

  it('confirms the gate is open once it is', () => {
    expect(gatePrompt('BEFORE', 1)).toContain('you can start')
    expect(gatePrompt('AFTER', 1)).toContain('you can finish')
  })
})
