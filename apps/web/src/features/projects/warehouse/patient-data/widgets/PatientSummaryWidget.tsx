import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { User, Calendar, Activity } from 'lucide-react'
import { usePatientChartContext } from '../PatientChartContext'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildPatientDemographicsQuery } from '@/lib/duckdb/patient-data-queries'

interface DemoRow {
  patient_id: string
  gender?: string
  age?: number
  visit_count?: number
}

export function PatientSummaryWidget() {
  const { t } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { selectedPatientId, selectedVisitId } = usePatientChartStore()
  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null
  const [demo, setDemo] = useState<DemoRow | null>(null)

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !patientId) {
      setDemo(null)
      return
    }
    let cancelled = false
    const sql = buildPatientDemographicsQuery(schemaMapping, patientId, visitId)
    if (!sql) return
    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled && rows.length > 0) setDemo(rows[0] as DemoRow)
      })
      .catch(() => {
        if (!cancelled) setDemo(null)
      })
    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, visitId])

  const gv = schemaMapping?.genderValues
  const formatGender = (g: string | undefined) => {
    if (!g || !gv) return g ?? '—'
    if (g === gv.male) return t('patient_data.male')
    if (g === gv.female) return t('patient_data.female')
    return g
  }

  if (!patientId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.select_patient_first')}
        </p>
      </div>
    )
  }

  if (!demo) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Patient ID */}
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10">
          <User size={14} className="text-violet-500" />
        </div>
        <div>
          <p className="text-sm font-bold font-mono">{demo.patient_id}</p>
          <p className="text-[10px] text-muted-foreground">
            {t('patient_data.patient_id')}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">{t('patient_data.age')}</p>
          <p className="text-sm font-semibold">
            {demo.age != null ? Math.round(Number(demo.age)) : '—'}
          </p>
        </div>
        <div className="rounded-lg bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">{t('patient_data.gender_label')}</p>
          <p className="text-sm font-semibold">
            {formatGender(demo.gender != null ? String(demo.gender) : undefined)}
          </p>
        </div>
        <div className="rounded-lg bg-muted/50 px-2 py-1.5">
          <p className="text-[10px] text-muted-foreground">{t('patient_data.visit_count')}</p>
          <p className="text-sm font-semibold">
            {demo.visit_count ?? '—'}
          </p>
        </div>
      </div>

      {/* Current visit info */}
      {visitId && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Calendar size={10} />
          <span>
            {t('patient_data.current_visit')}: {visitId}
          </span>
        </div>
      )}
    </div>
  )
}
