import { useEffect, useState } from 'react'
import { fetchFlightStatus, type FlightStatus } from '@/lib/api/data-sources'
import { isServerMode } from '@/lib/api-client'
import type { DataSource, DatabaseConnectionConfig } from '@/types'

/** A Doris database's Flight status, fetched once per database; null elsewhere,
 *  and while it loads or when the database itself cannot be reached. */
export function useFlightStatus(source: DataSource | undefined): FlightStatus | null {
  const engine = (source?.connectionConfig as DatabaseConnectionConfig | undefined)?.engine
  const id = source?.id
  const [status, setStatus] = useState<{ id: string; value: FlightStatus } | null>(null)
  useEffect(() => {
    if (!id || engine !== 'doris' || !isServerMode()) return
    let cancelled = false
    fetchFlightStatus(id)
      .then((value) => { if (!cancelled) setStatus({ id, value }) })
      .catch(() => { /* the connection card already says the database is unreachable */ })
    return () => { cancelled = true }
  }, [id, engine])
  return status && status.id === id ? status.value : null
}
