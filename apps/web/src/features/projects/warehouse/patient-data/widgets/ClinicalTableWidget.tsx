import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRightLeft, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { usePatientChartContext } from '../PatientChartContext'
import {
  usePatientChartStore,
  type ClinicalTableConfig,
} from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildClinicalTableQuery } from '@/lib/duckdb/patient-data-queries'

interface ClinicalTableWidgetProps {
  widgetId: string
  onConfigureConcepts?: () => void
}

interface ClinicalRow {
  concept_id: number
  concept_name: string
  value_numeric: number | null
  value_string: string | null
  event_date: string
}

export function ClinicalTableWidget({ widgetId, onConfigureConcepts }: ClinicalTableWidgetProps) {
  const { t } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { widgets, selectedPatientId, selectedVisitId, updateWidgetConfig } =
    usePatientChartStore()

  const widget = widgets.find((w) => w.id === widgetId)
  const config = (widget?.config ?? {
    conceptIds: [],
    orientation: 'concepts-as-rows',
  }) as ClinicalTableConfig

  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const [data, setData] = useState<ClinicalRow[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch data
  useEffect(() => {
    if (
      !dataSourceId ||
      !schemaMapping ||
      !patientId ||
      config.conceptIds.length === 0
    ) {
      setData([])
      return
    }

    let cancelled = false
    setLoading(true)

    const sql = buildClinicalTableQuery(
      schemaMapping,
      config.conceptIds,
      patientId,
      visitId,
    )

    if (!sql) {
      setData([])
      setLoading(false)
      return
    }

    queryDataSource(dataSourceId, sql)
      .then((rows) => {
        if (!cancelled) setData((rows as ClinicalRow[]) ?? [])
      })
      .catch((err) => {
        console.error('Clinical table query failed:', err)
        if (!cancelled) setData([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, visitId, config.conceptIds])

  const toggleOrientation = () => {
    updateWidgetConfig(widgetId, {
      ...config,
      orientation:
        config.orientation === 'concepts-as-rows'
          ? 'concepts-as-columns'
          : 'concepts-as-rows',
    })
  }

  const formatValue = (row: ClinicalRow) => {
    if (row.value_numeric != null) return String(Math.round(Number(row.value_numeric) * 100) / 100)
    if (row.value_string != null) return String(row.value_string)
    return '—'
  }

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return d
    }
  }

  // Empty state
  if (config.conceptIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.configure_concepts')}
        </p>
        {onConfigureConcepts && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={onConfigureConcepts}
          >
            <Settings2 size={12} />
            {t('patient_data.select_concepts')}
          </Button>
        )}
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

  // Concepts-as-rows: rows = concepts, columns = dates
  if (config.orientation === 'concepts-as-rows') {
    const conceptNames = [...new Set(data.map((d) => d.concept_name))]
    const dates = [
      ...new Set(data.map((d) => String(d.event_date))),
    ].sort()

    // Build lookup
    const lookup = new Map<string, string>()
    for (const row of data) {
      lookup.set(`${row.concept_name}|${row.event_date}`, formatValue(row))
    }

    return (
      <div className="relative h-full">
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-0 right-0 z-10"
          onClick={toggleOrientation}
        >
          <ArrowRightLeft size={10} />
        </Button>
        <ScrollArea className="h-full">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b">
                <th className="sticky left-0 bg-card px-2 py-1 text-left font-semibold">
                  {t('patient_data.concept')}
                </th>
                {dates.map((d) => (
                  <th key={d} className="px-2 py-1 text-right font-medium text-muted-foreground whitespace-nowrap">
                    {formatDate(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {conceptNames.map((name) => (
                <tr key={name} className="border-b last:border-0">
                  <td className="sticky left-0 bg-card px-2 py-1 font-medium whitespace-nowrap">
                    {name}
                  </td>
                  {dates.map((d) => (
                    <td key={d} className="px-2 py-1 text-right tabular-nums">
                      {lookup.get(`${name}|${d}`) ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </div>
    )
  }

  // Concepts-as-columns: rows = dates, columns = concepts
  const conceptNames = [...new Set(data.map((d) => d.concept_name))]
  const dates = [...new Set(data.map((d) => String(d.event_date)))].sort()

  const lookup = new Map<string, string>()
  for (const row of data) {
    lookup.set(`${row.event_date}|${row.concept_name}`, formatValue(row))
  }

  return (
    <div className="relative h-full">
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-0 right-0 z-10"
        onClick={toggleOrientation}
      >
        <ArrowRightLeft size={10} />
      </Button>
      <ScrollArea className="h-full">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="sticky left-0 bg-card px-2 py-1 text-left font-semibold">
                {t('patient_data.date')}
              </th>
              {conceptNames.map((name) => (
                <th key={name} className="px-2 py-1 text-right font-medium whitespace-nowrap">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => (
              <tr key={d} className="border-b last:border-0">
                <td className="sticky left-0 bg-card px-2 py-1 font-medium whitespace-nowrap text-muted-foreground">
                  {formatDate(d)}
                </td>
                {conceptNames.map((name) => (
                  <td key={name} className="px-2 py-1 text-right tabular-nums">
                    {lookup.get(`${d}|${name}`) ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  )
}
