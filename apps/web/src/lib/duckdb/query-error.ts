import type { TFunction } from 'i18next'
import { formatApiError } from '@/lib/api-client'

// The server's wording for a file database whose file is gone (moved, deleted,
// or a server path that no longer resolves): data_source_service.py.
const FILE_MISSING = /no readable database file|database file is missing|no database file uploaded/i

/**
 * A query error as a sentence for the user: the server's `{"detail": …}`
 * unwrapped, and the missing-file case said in plain words, since the fix is on
 * the database page, not in the SQL being written.
 */
export function queryErrorMessage(err: unknown, t: TFunction, databaseName: string): string {
  const { summary, summaryKey, summaryCount } = formatApiError(err)
  const text = summary ?? (summaryKey ? t(summaryKey, { count: summaryCount }) : String(err))
  if (FILE_MISSING.test(text)) return t('databases.error_file_missing', { name: databaseName })
  return text.replace(/ \(HTTP \d+\)$/, '')
}
