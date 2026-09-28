import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { fetchDatabaseConnectionInfo, type DatabaseConnectionInfo } from '@/lib/api/data-sources'
import type { DataSource } from '@/types'

export interface DatabaseLocation {
  /** What the server answered, or null (client-only build, external engine, no answer yet). */
  info: DatabaseConnectionInfo | null
  /** The files the database reads are gone from where it points. */
  missing: boolean
  /** Where they were expected, when that is a path worth showing. */
  path: string | null
}

/** A browser file handle whose file was moved or deleted throws a NotFoundError. */
const HANDLE_NOT_FOUND = /NotFoundError|could not be found/i

/**
 * Whether a database's files are still where it points. Server mode asks the
 * server (connection-info); the client-only build reads the error its mount
 * recorded, since a file handle only fails once it is read.
 *
 * Re-read on `status` and `managedPath`: a rebuild or a move keeps the id.
 */
export function useDatabaseLocation(source: DataSource | undefined): DatabaseLocation {
  const [info, setInfo] = useState<DatabaseConnectionInfo | null>(null)
  const managedPath = (source?.connectionConfig as { managedPath?: string } | undefined)?.managedPath
  const [reloadKey, setReloadKey] = useState(0)
  const id = source?.id
  const status = source?.status

  useEffect(() => {
    if (!isServerMode() || !id) {
      setInfo(null)
      return
    }
    let cancelled = false
    fetchDatabaseConnectionInfo(id)
      .then((r) => { if (!cancelled) setInfo(r) })
      .catch(() => { if (!cancelled) setInfo(null) })
    return () => { cancelled = true }
  }, [id, status, managedPath, reloadKey])

  // Refetch when another view (a compaction, a move) changed the files.
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setReloadKey((k) => k + 1)
    }
    window.addEventListener(LOCATION_CHANGED, onChange)
    return () => window.removeEventListener(LOCATION_CHANGED, onChange)
  }, [id])

  if (!source) return { info: null, missing: false, path: null }
  if (!isServerMode()) {
    const missing = source.status === 'error' && HANDLE_NOT_FOUND.test(source.errorMessage ?? '')
    return { info: null, missing, path: null }
  }
  const missing = !!info && (info.kind === 'file' || info.kind === 'parquet-folder') && !info.exists
  return { info, missing, path: info?.path ?? null }
}

const LOCATION_CHANGED = 'linkr:database-location-changed'

/** Tell every `useDatabaseLocation` of this database to re-read it. */
export function notifyDatabaseLocationChanged(dataSourceId: string): void {
  window.dispatchEvent(new CustomEvent(LOCATION_CHANGED, { detail: dataSourceId }))
}
