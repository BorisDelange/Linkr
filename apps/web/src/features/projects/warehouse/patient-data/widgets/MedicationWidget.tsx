import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { usePatientChartContext } from '../PatientChartContext'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildMedicationsQuery,
  getMedicationEventLabel,
} from '@/lib/duckdb/patient-data-queries'

interface MedRow {
  concept_id: number
  concept_name: string
  start_date: string
}

export function MedicationWidget() {
  const { t } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { selectedPatientId, selectedVisitId } = usePatientChartStore()
  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const [data, setData] = useState<MedRow[]>([])
  const [loading, setLoading] = useState(false)

  const eventLabel = schemaMapping
    ? getMedicationEventLabel(schemaMapping)
    : null

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !patientId) {
      setData([])
      return
    }

    let cancelled = false
    setLoading(true)

    const sql = buildMedicationsQuery(schemaMapping, patientId, visitId)
    if (!sql) {
      setData([])
      setLoading(false)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) setData((rows as MedRow[]) ?? [])
      })
      .catch(() => {
        if (!cancelled) setData([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, visitId])

  // No drug table in schema
  if (!eventLabel) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.no_medication_table')}
        </p>
      </div>
    )
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.no_data')}
        </p>
      </div>
    )
  }

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString()
    } catch {
      return d
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1">
        {data.map((row, i) => (
          <div
            key={`${row.concept_id}-${i}`}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
          >
            <Pill size={10} className="shrink-0 text-orange-500" />
            <span className="flex-1 font-medium truncate">
              {row.concept_name}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {formatDate(row.start_date)}
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
