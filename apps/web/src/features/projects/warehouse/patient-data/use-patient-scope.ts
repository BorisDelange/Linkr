import { useEffect, useMemo, useState } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { toMs } from '@/lib/duckdb/value-coercion'
import {
  buildStayWindowQuery,
  buildVisitWindowQuery,
  type PatientScope,
  type TimeWindow,
} from '@/lib/duckdb/patient-scope'

/** Windows already read, per database and id: every widget of a board asks for the same one. */
const windows = new Map<string, Promise<TimeWindow | null>>()

/** The window bound as the UTC ISO string `patient-scope.ts` writes as a literal. */
function toIso(v: unknown): string | null {
  const ms = toMs(v)
  return ms == null ? null : new Date(ms).toISOString()
}

function readWindow(dataSourceId: string, sql: string | null): Promise<TimeWindow | null> {
  if (!sql) return Promise.resolve(null)
  const key = `${dataSourceId}\u0001${sql}`
  let hit = windows.get(key)
  if (!hit) {
    hit = queryDataSource(dataSourceId, sql)
      .then((rows) => {
        const start = toIso(rows[0]?.window_start)
        return start ? { start, end: toIso(rows[0]?.window_end) } : null
      })
      .catch(() => {
        windows.delete(key)
        return null
      })
    windows.set(key, hit)
  }
  return hit
}

export interface PatientScopeState {
  patientId: string | null
  /** Stable until the selection or its dates change: a safe effect dependency. */
  scope: PatientScope
  /** False while a selected hospitalisation's or stay's dates are being read:
   *  a query fired then would show the wider scope for a moment. */
  ready: boolean
}

/**
 * The patient, hospitalisation and stay the board is on, with the dates a
 * widget needs to scope the rows that record no visit id (see `patient-scope.ts`).
 */
export function usePatientScope(
  projectUid: string,
  dataSourceId: string | undefined,
  mapping: SchemaMapping | undefined,
): PatientScopeState {
  const patientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const visitId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const visitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)
  const wanted = `${dataSourceId ?? ''}|${visitId ?? ''}|${visitDetailId ?? ''}`
  const [loaded, setLoaded] = useState<{ wanted: string; visit: TimeWindow | null; stay: TimeWindow | null } | null>(null)

  useEffect(() => {
    if (!dataSourceId || !mapping || (!visitId && !visitDetailId)) return
    let cancelled = false
    void Promise.all([
      visitId ? readWindow(dataSourceId, buildVisitWindowQuery(mapping, visitId)) : null,
      visitDetailId ? readWindow(dataSourceId, buildStayWindowQuery(mapping, visitDetailId)) : null,
    ]).then(([visit, stay]) => {
      if (!cancelled) setLoaded({ wanted, visit, stay })
    })
    return () => { cancelled = true }
  }, [wanted, dataSourceId, mapping, visitId, visitDetailId])

  const needsWindows = !!dataSourceId && !!mapping && (!!visitId || !!visitDetailId)
  const current = loaded?.wanted === wanted ? loaded : null
  const ready = !needsWindows || current !== null

  return useMemo(() => {
    const scope: PatientScope = { visitId, visit: current?.visit ?? null, stay: current?.stay ?? null }
    return { patientId, scope, ready }
  }, [patientId, visitId, current, ready])
}
