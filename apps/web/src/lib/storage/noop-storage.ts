import type { FileHandleStorage, ScoresBlobStorage, ScoresMetaStorage } from '@/lib/storage'

/**
 * No-op implementations for the stores that are inherently client-only
 * (fileHandles = FS Access API handles) or fully migrated to the server
 * (scoresBlob/scoresMeta). In server mode they must never touch IndexedDB, so
 * the whole IDB database is never opened on the client. Reads return empty,
 * writes/deletes do nothing — every remaining caller (e.g. defensive cleanup
 * in workspace/data-source deletion) becomes a true no-op without needing an
 * isServerMode() guard at each call site.
 */

export const noopFileHandleStorage: FileHandleStorage = {
  async getByDataSource() { return [] },
  async create() { /* handles never persisted server-side */ },
  async deleteByDataSource() { /* nothing to clean up */ },
}

export const noopScoresBlobStorage: ScoresBlobStorage = {
  async get() { return undefined },
  async put() { /* scores live in the blob store server-side */ },
  async delete() { /* nothing to clean up */ },
}

export const noopScoresMetaStorage: ScoresMetaStorage = {
  async get() { return undefined },
  async put() { /* index rebuilt from the server parquet */ },
  async delete() { /* nothing to clean up */ },
}
