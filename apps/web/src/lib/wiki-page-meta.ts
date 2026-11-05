import type { WikiPage } from '@/types'

/**
 * Reads one `wiki/_tree.json` entry. Exports made before the review statuses
 * carry a `verified` flag instead; a verified page reads as approved.
 */
export function readWikiPageMeta<T extends Partial<WikiPage>>(meta: T): T {
  const { verified, verifiedAt, ...rest } = meta as T & { verified?: boolean; verifiedAt?: string | null }
  if (rest.status || !verified) return rest as T
  return { ...rest, status: 'approved', statusChangedAt: verifiedAt ?? undefined } as T
}
