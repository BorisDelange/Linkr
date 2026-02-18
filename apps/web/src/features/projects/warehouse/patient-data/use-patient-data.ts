import { useState, useEffect, useCallback, useRef } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { Cohort } from '@/types'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useCohortStore } from '@/stores/cohort-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildPatientListQuery,
  buildPatientCountQuery,
  buildVisitListQuery,
  buildVisitDetailListQuery,
  buildPatientDemographicsQuery,
  type PatientFilters,
} from '@/lib/duckdb/patient-data-queries'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatientRow {
  patient_id: string
  gender?: string
  age?: number
  visit_count?: number
}

export interface VisitRow {
  visit_id: string
  start_date: string
  end_date?: string
  visit_type?: string
}

export interface VisitDetailRow {
  visit_detail_id: string
  start_date: string
  end_date?: string
  unit?: string
}

export interface PatientDemographics {
  patient_id: string
  gender?: string
  age?: number
  visit_count?: number
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePatientData(
  dataSourceId: string | undefined,
  schemaMapping: SchemaMapping | undefined,
  projectUid: string,
) {
  const {
    selectedCohortId,
    selectedPatientId,
    selectedVisitId,
    selectedVisitDetailId,
    setSelectedPatient,
    setSelectedVisit,
    setSelectedVisitDetail,
  } = usePatientChartStore()

  const { getProjectCohorts } = useCohortStore()
  const cohorts = getProjectCohorts(projectUid)

  const cohortId = selectedCohortId[projectUid] ?? null
  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null
  const visitDetailId = selectedVisitDetailId[projectUid] ?? null

  const selectedCohort: Cohort | null =
    cohortId ? (cohorts.find((c) => c.id === cohortId) ?? null) : null

  // --- Patient filters ---
  const [patientFilters, setPatientFilters] = useState<PatientFilters>({})
  const filtersKey = JSON.stringify(patientFilters)

  // --- Patient list ---
  const [patients, setPatients] = useState<PatientRow[]>([])
  const [patientCount, setPatientCount] = useState(0)
  const [patientPage, setPatientPage] = useState(0)
  const [patientsLoading, setPatientsLoading] = useState(false)
  const patientPageSize = 50
  const patientCacheRef = useRef<Map<string, { rows: PatientRow[]; count: number }>>(new Map())

  const loadPatients = useCallback(
    async (page: number) => {
      if (!dataSourceId || !schemaMapping) return
      const cacheKey = `${cohortId ?? 'all'}-${filtersKey}-${page}`
      const cached = patientCacheRef.current.get(cacheKey)
      if (cached) {
        setPatients(cached.rows)
        setPatientCount(cached.count)
        return
      }

      setPatientsLoading(true)
      try {
        const listSql = buildPatientListQuery(
          schemaMapping,
          selectedCohort,
          patientPageSize,
          page * patientPageSize,
          patientFilters,
        )
        const countSql = buildPatientCountQuery(schemaMapping, selectedCohort, patientFilters)

        const [rows, countResult] = await Promise.all([
          listSql ? queryDataSource(dataSourceId, listSql) : [],
          countSql ? queryDataSource(dataSourceId, countSql) : [],
        ])

        const patientRows = (rows as PatientRow[]) ?? []
        const count = Number((countResult as Record<string, unknown>[])?.[0]?.cnt ?? 0)

        setPatients(patientRows)
        setPatientCount(count)
        patientCacheRef.current.set(cacheKey, { rows: patientRows, count })
      } catch (err) {
        console.error('Failed to load patients:', err)
        setPatients([])
        setPatientCount(0)
      } finally {
        setPatientsLoading(false)
      }
    },
    [dataSourceId, schemaMapping, selectedCohort, cohortId, filtersKey, patientFilters],
  )

  // Load patients when page/cohort/filters change
  useEffect(() => {
    loadPatients(patientPage)
  }, [loadPatients, patientPage])

  // Reset page when cohort or filters change
  useEffect(() => {
    setPatientPage(0)
    patientCacheRef.current.clear()
  }, [cohortId, filtersKey])

  // --- Visit list ---
  const [visits, setVisits] = useState<VisitRow[]>([])
  const [visitsLoading, setVisitsLoading] = useState(false)

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !patientId) {
      setVisits([])
      return
    }

    let cancelled = false
    setVisitsLoading(true)

    const sql = buildVisitListQuery(schemaMapping, patientId)
    if (!sql) {
      setVisits([])
      setVisitsLoading(false)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) {
          setVisits((rows as VisitRow[]) ?? [])
          // Auto-select first visit
          if (rows.length > 0 && !visitId) {
            const firstVisit = rows[0] as VisitRow
            setSelectedVisit(projectUid, String(firstVisit.visit_id))
          }
        }
      })
      .catch((err) => {
        console.error('Failed to load visits:', err)
        if (!cancelled) setVisits([])
      })
      .finally(() => {
        if (!cancelled) setVisitsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, projectUid, setSelectedVisit, visitId])

  // --- Visit details (sub-stays) ---
  const [visitDetails, setVisitDetails] = useState<VisitDetailRow[]>([])
  const [visitDetailsLoading, setVisitDetailsLoading] = useState(false)
  const hasVisitDetailTable = !!schemaMapping?.visitDetailTable

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !visitId || !hasVisitDetailTable) {
      setVisitDetails([])
      return
    }

    let cancelled = false
    setVisitDetailsLoading(true)

    const sql = buildVisitDetailListQuery(schemaMapping, visitId)
    if (!sql) {
      setVisitDetails([])
      setVisitDetailsLoading(false)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) {
          setVisitDetails((rows as VisitDetailRow[]) ?? [])
        }
      })
      .catch((err) => {
        console.error('Failed to load visit details:', err)
        if (!cancelled) setVisitDetails([])
      })
      .finally(() => {
        if (!cancelled) setVisitDetailsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, visitId, hasVisitDetailTable])

  // --- Demographics ---
  const [demographics, setDemographics] = useState<PatientDemographics | null>(null)

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !patientId) {
      setDemographics(null)
      return
    }

    let cancelled = false
    const sql = buildPatientDemographicsQuery(schemaMapping, patientId, visitId)
    if (!sql) {
      setDemographics(null)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled && rows.length > 0) {
          setDemographics(rows[0] as PatientDemographics)
        }
      })
      .catch(() => {
        if (!cancelled) setDemographics(null)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, visitId])

  return {
    // Cohorts
    cohorts,
    selectedCohort,

    // Patients
    patients,
    patientCount,
    patientPage,
    patientPageSize,
    patientsLoading,
    setPatientPage,
    patientFilters,
    setPatientFilters,

    // Visits (hospitalizations)
    visits,
    visitsLoading,

    // Visit details (stays within a hospitalization)
    visitDetails,
    visitDetailsLoading,
    hasVisitDetailTable,

    // Demographics
    demographics,

    // Current selection
    patientId,
    visitId,
    visitDetailId,
    cohortId,

    // Actions
    selectPatient: (id: string | null) => setSelectedPatient(projectUid, id),
    selectVisit: (id: string | null) => setSelectedVisit(projectUid, id),
    selectVisitDetail: (id: string | null) => setSelectedVisitDetail(projectUid, id),
  }
}
