import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildOverviewInventoryQuery,
  buildOverviewUnitStaysQuery,
  buildOverviewDeathQuery,
  buildOverviewDensityQuery,
} from '@/lib/duckdb/patient-overview-queries'
import { toMs } from '@/lib/duckdb/value-coercion'
import type { PatientScope } from '@/lib/duckdb/patient-scope'
import type { SchemaMapping } from '@/types/schema-mapping'
import { sameBounds } from './timeline-view'
import { isoOrNull } from './use-overview-data'
import type { OverviewDataCache } from './overview-tiles'
import type { OverviewConceptRow } from './overview-layout'
import { RANGE_BUCKETS, type OverviewDensity, type UnitStay } from './overview-helpers'

type ViewWindow = { lo: number; hi: number }

interface OverviewRecordInput {
  visible: boolean
  scopeReady: boolean
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
  selectedPatientId: string | null
  selectedVisitId: string | null
  scope: PatientScope
  showUnitStays: boolean
  showDeath: boolean
  /** Frames the view on a newly loaded record — the raw setter, not a gesture. */
  setViewRaw: Dispatch<SetStateAction<ViewWindow | null>>
  paintFailedRef: RefObject<boolean>
  dataRef: RefObject<OverviewDataCache>
}

/** The patient's record for the overview: its concepts, unit stays, death,
 *  time bounds and whole-record density, reloaded when the patient, the scope
 *  or the settings change. */
export function useOverviewRecord({
  visible, scopeReady, dataSourceId, schemaMapping, selectedPatientId, selectedVisitId, scope,
  showUnitStays, showDeath, setViewRaw, paintFailedRef, dataRef,
}: OverviewRecordInput) {
  const [concepts, setConcepts] = useState<OverviewConceptRow[]>([])
  const [units, setUnits] = useState<UnitStay[]>([])
  const [death, setDeath] = useState<number | null>(null)
  const [bounds, setBounds] = useState<{ lo: number; hi: number } | null>(null)
  /** The bounds of the record currently loaded, read during the load itself —
   *  where the `bounds` state is still the previous render's value. */
  const boundsRef = useRef<{ lo: number; hi: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<OverviewDensity | null>(null)

  useEffect(() => {
    if (!visible) return
    // A selected hospitalisation or stay whose dates are still being read.
    if (!scopeReady) return
    if (!dataSourceId || !schemaMapping || !selectedPatientId) {
      setConcepts([])
      setUnits([])
      setDeath(null)
      boundsRef.current = null
      setBounds(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    paintFailedRef.current = false
    dataRef.current.clear()

    /**
     * The range selector's background: the whole record in one histogram,
     * aggregated in SQL. One query for every table at once, so it costs the same
     * whether the patient has 80k events or 400k.
     */
    const loadOverviewDensity = async (
      b: { lo: number; hi: number },
      rows: OverviewConceptRow[],
    ) => {
      const byTable = new Map<string, string[]>()
      for (const r of rows) {
        const list = byTable.get(r.table)
        if (list) list.push(r.conceptId)
        else byTable.set(r.table, [r.conceptId])
      }
      const bands = [...byTable].map(([table, conceptIds]) => ({ key: table, table, conceptIds }))
      const from = isoOrNull(b.lo)
      const to = isoOrNull(b.hi)
      if (!from || !to || bands.length === 0) return
      const sql = buildOverviewDensityQuery(
        schemaMapping, selectedPatientId, scope, from, to, RANGE_BUCKETS, bands,
      )
      if (!sql) return
      try {
        const raw = await queryDataSource(dataSourceId, sql)
        if (cancelled) return
        const counts = new Float64Array(RANGE_BUCKETS)
        let max = 0
        for (const r of raw) {
          const i = Number(r.bucket)
          if (!Number.isFinite(i) || i < 0 || i >= RANGE_BUCKETS) continue
          counts[i] += Number(r.n ?? 0)
          if (counts[i] > max) max = counts[i]
        }
        setOverview({ counts, max })
      } catch {
        // The strip simply stays empty; it is navigation aid, not data.
        setOverview(null)
      }
    }

    const run = async () => {
      try {
        const invSql = buildOverviewInventoryQuery(
          schemaMapping, selectedPatientId, scope,
        )
        const inv = invSql ? await queryDataSource(dataSourceId, invSql) : []
        if (cancelled) return

        const rows: OverviewConceptRow[] = inv.map((r) => ({
          table: String(r.table_label),
          conceptId: String(r.concept_id),
          conceptName: String(r.concept_name ?? r.concept_id),
          conceptCode: r.concept_code == null ? null : String(r.concept_code),
          conceptClass: r.concept_class == null ? null : String(r.concept_class),
          unit: r.unit == null ? null : String(r.unit),
          unitCount: Number(r.unit_count ?? 0),
          eventCount: Number(r.event_count ?? 0),
          durational: r.durational === true || r.durational === 'true',
          drug: r.is_drug === true || r.is_drug === 'true',
        }))

        let lo = Infinity
        let hi = -Infinity
        for (const r of inv) {
          const a = toMs(r.first_event)
          const b = toMs(r.last_event)
          if (a != null && a < lo) lo = a
          if (b != null && b > hi) hi = b
        }

        let stays: UnitStay[] = []
        if (showUnitStays) {
          const sql = buildOverviewUnitStaysQuery(schemaMapping, selectedPatientId, selectedVisitId)
          if (sql) {
            const raw = await queryDataSource(dataSourceId, sql)
            if (cancelled) return
            stays = raw
              .map((r) => ({
                start: toMs(r.stay_start) ?? 0,
                end: toMs(r.stay_end),
                name: String(r.unit_name ?? ''),
                category: r.unit_category == null ? null : String(r.unit_category),
              }))
              .filter((s) => s.start > 0)
            for (const s of stays) {
              if (s.start < lo) lo = s.start
              const e = s.end ?? s.start
              if (e > hi) hi = e
            }
          }
        }

        let deathMs: number | null = null
        if (showDeath) {
          const sql = buildOverviewDeathQuery(schemaMapping, selectedPatientId)
          if (sql) {
            const raw = await queryDataSource(dataSourceId, sql)
            if (cancelled) return
            deathMs = raw.length ? toMs(raw[0].death_date) : null
            if (deathMs != null) {
              if (deathMs < lo) lo = deathMs
              if (deathMs > hi) hi = deathMs
            }
          }
        }

        if (cancelled) return
        setConcepts(rows)
        setUnits(stays)
        setDeath(deathMs)
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          const pad = (hi - lo) * 0.01 || 86_400_000
          const b = { lo: lo - pad, hi: hi + pad }
          const sameRecord = sameBounds(boundsRef.current, b)
          boundsRef.current = b
          setBounds(b)
          // Frame the record only when the window does not already belong to it.
          // This effect re-runs whenever the tab becomes visible again, and
          // reframing there threw away whatever the user had zoomed to. Bounds
          // identify the record: a different patient or visit gives different
          // ones and still resets.
          //
          // setViewRaw, not setView: this is the widget framing itself, not a
          // gesture. Broadcasting it would yank every synced peer back to full
          // extent each time this one reloads.
          setViewRaw((prev) => (prev && sameRecord ? prev : b))
          void loadOverviewDensity(b, rows)
        } else {
          boundsRef.current = null
          setBounds(null)
          setViewRaw(null)
          setOverview(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [visible, scopeReady, dataSourceId, schemaMapping, selectedPatientId, selectedVisitId, scope, showUnitStays, showDeath, setViewRaw, paintFailedRef, dataRef])

  return { concepts, units, death, bounds, loading, error, setError, overview }
}
