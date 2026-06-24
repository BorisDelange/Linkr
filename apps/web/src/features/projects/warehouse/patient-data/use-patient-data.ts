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
  stay_count?: number
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
  death_date?: string | null
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
  // When prev/next crosses a page boundary, remember which edge patient of the
  // newly loaded page to auto-select once it arrives.
  const pendingEdgeSelectRef = useRef<'first' | 'last' | null>(null)

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

  // After a page change driven by prev/next at a boundary, select the edge
  // patient of the freshly loaded page so navigation continues seamlessly.
  useEffect(() => {
    const edge = pendingEdgeSelectRef.current
    if (!edge || patients.length === 0) return
    pendingEdgeSelectRef.current = null
    const target = edge === 'first' ? patients[0] : patients[patients.length - 1]
    setSelectedPatient(projectUid, String(target.patient_id))
  }, [patients, projectUid, setSelectedPatient])

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
          // rows come from a dynamic SQL query shaped to match VisitRow
          setVisits((rows as unknown as VisitRow[]) ?? [])
          // No auto-selection: a patient defaults to "All hospitalizations"
          // (visitId = null) so widgets show the full record until the user
          // narrows to one hospitalization.
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
  }, [dataSourceId, schemaMapping, patientId])

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
          // rows come from a dynamic SQL query shaped to match VisitDetailRow
          setVisitDetails((rows as unknown as VisitDetailRow[]) ?? [])
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
          // row comes from a dynamic SQL query shaped to match PatientDemographics
          setDemographics(rows[0] as unknown as PatientDemographics)
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

    // Navigation helpers
    ...buildNavHelpers({
      patients,
      patientId,
      patientPage,
      patientPageSize,
      patientCount,
      setPatientPage,
      selectPatient: (id: string | null) => setSelectedPatient(projectUid, id),
      requestEdgeSelect: (edge) => { pendingEdgeSelectRef.current = edge },
      visits,
      visitId,
      selectVisit: (id: string | null) => setSelectedVisit(projectUid, id),
      visitDetails,
      visitDetailId,
      selectVisitDetail: (id: string | null) => setSelectedVisitDetail(projectUid, id),
    }),
  }
}

// ---------------------------------------------------------------------------
// Navigation helpers (patient index + prev/next for patient / visit / stay)
// ---------------------------------------------------------------------------

interface NavInput {
  patients: PatientRow[]
  patientId: string | null
  patientPage: number
  patientPageSize: number
  patientCount: number
  setPatientPage: (page: number) => void
  selectPatient: (id: string | null) => void
  /** Queue selecting the first/last patient of the next page to load. */
  requestEdgeSelect: (edge: 'first' | 'last') => void
  visits: VisitRow[]
  visitId: string | null
  selectVisit: (id: string | null) => void
  visitDetails: VisitDetailRow[]
  visitDetailId: string | null
  selectVisitDetail: (id: string | null) => void
}

function buildNavHelpers(n: NavInput) {
  const patientIndexInPage = n.patients.findIndex((p) => String(p.patient_id) === n.patientId)
  // Global 1-based index across the whole cohort, when the patient is on the page.
  const patientGlobalIndex =
    patientIndexInPage >= 0
      ? n.patientPage * n.patientPageSize + patientIndexInPage + 1
      : null

  const goPrevPatient = () => {
    if (patientIndexInPage > 0) {
      n.selectPatient(String(n.patients[patientIndexInPage - 1].patient_id))
    } else if (patientIndexInPage === 0 && n.patientPage > 0) {
      n.requestEdgeSelect('last')
      n.setPatientPage(n.patientPage - 1)
    }
  }
  const goNextPatient = () => {
    if (patientIndexInPage >= 0 && patientIndexInPage < n.patients.length - 1) {
      n.selectPatient(String(n.patients[patientIndexInPage + 1].patient_id))
    } else if (
      patientIndexInPage === n.patients.length - 1 &&
      (n.patientPage + 1) * n.patientPageSize < n.patientCount
    ) {
      n.requestEdgeSelect('first')
      n.setPatientPage(n.patientPage + 1)
    }
  }
  const canPrevPatient =
    patientIndexInPage > 0 || (patientIndexInPage === 0 && n.patientPage > 0)
  const canNextPatient =
    (patientIndexInPage >= 0 && patientIndexInPage < n.patients.length - 1) ||
    (patientIndexInPage === n.patients.length - 1 &&
      (n.patientPage + 1) * n.patientPageSize < n.patientCount)

  const visitIndex = n.visits.findIndex((v) => String(v.visit_id) === n.visitId)
  const goPrevVisit = () => {
    if (visitIndex > 0) n.selectVisit(String(n.visits[visitIndex - 1].visit_id))
  }
  const goNextVisit = () => {
    if (visitIndex >= 0 && visitIndex < n.visits.length - 1) {
      n.selectVisit(String(n.visits[visitIndex + 1].visit_id))
    }
  }

  const detailIndex = n.visitDetails.findIndex(
    (vd) => String(vd.visit_detail_id) === n.visitDetailId,
  )
  const goPrevVisitDetail = () => {
    if (detailIndex > 0) n.selectVisitDetail(String(n.visitDetails[detailIndex - 1].visit_detail_id))
  }
  const goNextVisitDetail = () => {
    if (detailIndex >= 0 && detailIndex < n.visitDetails.length - 1) {
      n.selectVisitDetail(String(n.visitDetails[detailIndex + 1].visit_detail_id))
    }
  }

  return {
    patientGlobalIndex,
    goPrevPatient,
    goNextPatient,
    canPrevPatient,
    canNextPatient,
    visitIndex,
    goPrevVisit,
    goNextVisit,
    detailIndex,
    goPrevVisitDetail,
    goNextVisitDetail,
  }
}
