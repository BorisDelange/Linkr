import { apiFetch, apiRequest } from '@/lib/api-client'

const CHUNK_SIZE = 4 * 1024 * 1024 // 4 MiB

interface InitResponse {
  uploadId: string
  received: number[]
}

interface CompleteResponse {
  sha: string
  size: number
  fileName: string
}

/**
 * Upload a Blob to the backend in resumable chunks and return its content hash.
 * On a transient failure the caller can simply call this again with the same
 * uploadId (via `existingUploadId`) to resume — already-received chunks are skipped.
 */
export async function uploadFileInChunks(
  blob: Blob,
  fileName: string,
  onProgress?: (fraction: number) => void,
): Promise<CompleteResponse> {
  const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE))

  const init = await apiRequest<InitResponse>('/uploads', {
    method: 'POST',
    body: JSON.stringify({ fileName, totalChunks, fileSize: blob.size }),
  })
  const uploadId = init.uploadId
  const done = new Set(init.received)

  for (let i = 0; i < totalChunks; i++) {
    if (done.has(i)) continue
    const start = i * CHUNK_SIZE
    const slice = blob.slice(start, start + CHUNK_SIZE)
    const res = await apiFetch(`/api/v1/uploads/${uploadId}/chunk?index=${i}`, {
      method: 'PUT',
      body: slice,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    if (!res.ok) throw new Error(`chunk ${i} upload failed (${res.status})`)
    onProgress?.((i + 1) / totalChunks)
  }

  return apiRequest<CompleteResponse>(`/uploads/${uploadId}/complete`, { method: 'POST' })
}
