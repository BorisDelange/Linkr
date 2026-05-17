import { getStorage } from '@/lib/storage'

const OPFS_DIR = 'scores'
const OPFS_FILE = (projectId: string) => `${projectId}.parquet`
const PROBE_FILE = '__opfs_probe__'

let _opfsAvailable: boolean | null = null

async function probeOPFS(): Promise<boolean> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return false
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(PROBE_FILE, { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Uint8Array([0]))
    await writable.close()
    await root.removeEntry(PROBE_FILE)
    return true
  } catch {
    return false
  }
}

async function isOPFSAvailable(): Promise<boolean> {
  if (_opfsAvailable !== null) return _opfsAvailable
  _opfsAvailable = await probeOPFS()
  if (_opfsAvailable) {
    try { await navigator.storage.persist?.() } catch { /* ignore */ }
  }
  return _opfsAvailable
}

async function getOPFSDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_DIR, { create: true })
}

export async function saveScoresFile(projectId: string, file: File): Promise<void> {
  if (await isOPFSAvailable()) {
    try {
      const dir = await getOPFSDir()
      const handle = await dir.getFileHandle(OPFS_FILE(projectId), { create: true })
      const writable = await handle.createWritable()
      try {
        await writable.truncate(0)
        await writable.write(file)
      } finally {
        await writable.close()
      }
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        throw new Error('Browser storage quota exceeded. Free up space or reduce top-K when generating scores.')
      }
      throw err
    }
  }

  const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' })
  await getStorage().scoresBlob.put(projectId, blob)
}

export async function getScoresFile(projectId: string): Promise<File | null> {
  if (await isOPFSAvailable()) {
    try {
      const dir = await getOPFSDir()
      const handle = await dir.getFileHandle(OPFS_FILE(projectId), { create: false })
      return await handle.getFile()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null
      throw err
    }
  }

  const blob = await getStorage().scoresBlob.get(projectId)
  if (!blob) return null
  return new File([blob], `${projectId}.parquet`, { type: blob.type })
}

export async function deleteScoresFile(projectId: string): Promise<void> {
  if (await isOPFSAvailable()) {
    try {
      const dir = await getOPFSDir()
      await dir.removeEntry(OPFS_FILE(projectId))
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
    }
    return
  }

  await getStorage().scoresBlob.delete(projectId)
}

export async function hasScoresFile(projectId: string): Promise<boolean> {
  return (await getScoresFile(projectId)) !== null
}
