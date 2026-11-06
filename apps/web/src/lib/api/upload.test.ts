import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/lib/i18n'
import { uploadFileInChunks } from './upload'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noSpace = { detail: { code: 'upload_no_space', message: 'Not enough free space', reserveMb: 5120 } }
const quota = { detail: { code: 'upload_quota_exceeded', message: 'quota', quotaMb: 100 } }
const file = new Blob(['abc'])

describe('uploadFileInChunks', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('says in the user\'s language when the server has no room, whichever step refuses', async () => {
    const expected = i18n.t('api_errors.upload_no_space', { reserveMb: 5120 })
    expect(expected).not.toBe('api_errors.upload_no_space')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(noSpace, 507)))
    await expect(uploadFileInChunks(file, 'f')).rejects.toThrow(expected)

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ uploadId: 'u', received: [] }))
      .mockResolvedValueOnce(json(noSpace, 507)))
    await expect(uploadFileInChunks(file, 'f')).rejects.toThrow(expected)

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ uploadId: 'u', received: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(noSpace, 507)))
    await expect(uploadFileInChunks(file, 'f')).rejects.toThrow(expected)
  })

  it('names the quota when that is what refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(quota, 413)))
    await expect(uploadFileInChunks(file, 'f')).rejects.toThrow(i18n.t('api_errors.upload_quota_exceeded', { quotaMb: 100 }))
  })

  it('keeps the plain failure for any other chunk error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ uploadId: 'u', received: [] }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 })))
    await expect(uploadFileInChunks(file, 'f')).rejects.toThrow('chunk 0 upload failed (500)')
  })
})
