import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { queryDataSource } from '@/lib/duckdb/engine'
import type { SchemaMapping } from '@/types/schema-mapping'
import { buildPatientSummaryQuery } from '@/lib/duckdb/patient-data-queries'
import { formatGender as fmtGender } from '@/lib/format-helpers'

interface PatientSummary {
  patient_id: string
  gender?: string
  death_date?: string | null
  age_first_visit?: number
  age_last_visit?: number
  visit_count?: number
  visit_detail_count?: number
  total_los_days?: number
}

interface PatientHoverCardProps {
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
  patientId: string
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-background/60">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

/**
 * Tooltip body for a patient row: lazy-loads a richer summary (ages, counts,
 * death status) on first hover. Rendered inside the tooltip's dark surface,
 * so colors are keyed off `background` to stay readable.
 */
export function PatientHoverCard({
  dataSourceId,
  schemaMapping,
  patientId,
}: PatientHoverCardProps) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<PatientSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!dataSourceId || !schemaMapping) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const sql = buildPatientSummaryQuery(schemaMapping, patientId)
    if (!sql) {
      setLoading(false)
      return
    }
    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled && rows.length > 0) setSummary(rows[0] as PatientSummary)
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId])

  const gv = schemaMapping?.genderValues
  const round = (n: number | undefined) =>
    n != null ? Math.round(Number(n)) : null

  const isDeceased = !!summary?.death_date

  return (
    <div className="min-w-44 space-y-1 text-xs">
      <div className="font-mono font-semibold">{patientId}</div>
      {loading ? (
        <div className="text-background/60">{t('common.loading')}</div>
      ) : summary ? (
        <div className="space-y-0.5">
          {summary.gender != null && (
            <Row
              label={t('patient_data.gender_label')}
              value={fmtGender(String(summary.gender), gv, t)}
            />
          )}
          {round(summary.age_first_visit) != null && (
            <Row
              label={t('patient_data.age_first_visit')}
              value={`${round(summary.age_first_visit)} ${t('patient_data.years')}`}
            />
          )}
          {round(summary.age_last_visit) != null && (
            <Row
              label={t('patient_data.age_last_visit')}
              value={`${round(summary.age_last_visit)} ${t('patient_data.years')}`}
            />
          )}
          {summary.visit_count != null && (
            <Row
              label={t('patient_data.hospitalization')}
              value={Number(summary.visit_count)}
            />
          )}
          {summary.visit_detail_count != null && Number(summary.visit_detail_count) > 0 && (
            <Row
              label={t('patient_data.stay')}
              value={Number(summary.visit_detail_count)}
            />
          )}
          {summary.total_los_days != null && (
            <Row
              label={t('patient_data.hospitalization_los')}
              value={t('patient_data.days_count', { count: Math.round(Number(summary.total_los_days)) })}
            />
          )}
          <Row
            label={t('patient_data.death_status')}
            value={
              <span className={isDeceased ? 'text-red-300' : 'text-emerald-300'}>
                {isDeceased ? t('patient_data.deceased') : t('patient_data.alive')}
              </span>
            }
          />
        </div>
      ) : null}
    </div>
  )
}
