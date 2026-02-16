import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePatientChartContext } from '../PatientChartContext'
import {
  usePatientChartStore,
  type TimelineConfig,
} from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import { buildTimelineQuery } from '@/lib/duckdb/patient-data-queries'
import { ConceptPickerDialog } from '../ConceptPickerDialog'

interface TimelineWidgetProps {
  widgetId: string
}

interface TimelineRow {
  concept_id: number
  concept_name: string
  value: number
  event_date: string
}

const COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

export function TimelineWidget({ widgetId }: TimelineWidgetProps) {
  const { t } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { widgets, selectedPatientId, selectedVisitId, updateWidgetConfig } =
    usePatientChartStore()

  const widget = widgets.find((w) => w.id === widgetId)
  const config = (widget?.config ?? {
    conceptIds: [],
    eventTableLabel: '',
  }) as TimelineConfig

  const patientId = selectedPatientId[projectUid] ?? null
  const visitId = selectedVisitId[projectUid] ?? null

  const [data, setData] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Available event table labels
  const eventLabels = useMemo(
    () =>
      schemaMapping?.eventTables
        ? Object.keys(schemaMapping.eventTables)
        : [],
    [schemaMapping],
  )

  // Auto-set first event table if not configured
  useEffect(() => {
    if (!config.eventTableLabel && eventLabels.length > 0) {
      updateWidgetConfig(widgetId, {
        ...config,
        eventTableLabel: eventLabels[0],
      })
    }
  }, [config, eventLabels, widgetId, updateWidgetConfig])

  // Fetch data
  useEffect(() => {
    if (
      !dataSourceId ||
      !schemaMapping ||
      !patientId ||
      config.conceptIds.length === 0 ||
      !config.eventTableLabel
    ) {
      setData([])
      return
    }

    let cancelled = false
    setLoading(true)

    const sql = buildTimelineQuery(
      schemaMapping,
      config.eventTableLabel,
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
        if (!cancelled) setData((rows as TimelineRow[]) ?? [])
      })
      .catch((err) => {
        console.error('Timeline query failed:', err)
        if (!cancelled) setData([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId, visitId, config.conceptIds, config.eventTableLabel])

  // Reshape data for Recharts: pivot by date, one key per concept_name
  const { chartData, conceptNames } = useMemo(() => {
    const nameSet = new Set<string>()
    const byDate = new Map<string, Record<string, number | string>>()

    for (const row of data) {
      nameSet.add(row.concept_name)
      const dateKey = String(row.event_date)
      const existing = byDate.get(dateKey) ?? { date: dateKey }
      existing[row.concept_name] = Number(row.value)
      byDate.set(dateKey, existing)
    }

    const sorted = [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    )

    return { chartData: sorted, conceptNames: [...nameSet] }
  }, [data])

  const handleConceptsSelected = (ids: number[], label: string) => {
    updateWidgetConfig(widgetId, {
      ...config,
      conceptIds: ids,
      eventTableLabel: label,
    })
    setPickerOpen(false)
  }

  // Empty state — no concepts configured
  if (config.conceptIds.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.configure_concepts')}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => setPickerOpen(true)}
        >
          <Settings2 size={12} />
          {t('patient_data.select_concepts')}
        </Button>
        <ConceptPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          selectedConceptIds={config.conceptIds}
          eventTableLabel={config.eventTableLabel}
          onConfirm={handleConceptsSelected}
        />
      </div>
    )
  }

  // No patient selected
  if (!patientId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.select_patient_first')}
        </p>
      </div>
    )
  }

  // Loading
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  // No data
  if (data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-xs text-muted-foreground">
          {t('patient_data.no_data')}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => setPickerOpen(true)}
        >
          <Settings2 size={12} />
          {t('patient_data.select_concepts')}
        </Button>
        <ConceptPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          selectedConceptIds={config.conceptIds}
          eventTableLabel={config.eventTableLabel}
          onConfirm={handleConceptsSelected}
        />
      </div>
    )
  }

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return d
    }
  }

  return (
    <div className="relative h-full w-full">
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-0 right-0 z-10"
        onClick={() => setPickerOpen(true)}
      >
        <Settings2 size={10} />
      </Button>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9 }}
            tickFormatter={formatDate}
          />
          <YAxis tick={{ fontSize: 9 }} width={40} />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            labelFormatter={formatDate}
          />
          {conceptNames.length > 1 && (
            <Legend wrapperStyle={{ fontSize: 10 }} />
          )}
          {conceptNames.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={1.5}
              dot={{ r: 2 }}
              activeDot={{ r: 3 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <ConceptPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedConceptIds={config.conceptIds}
        eventTableLabel={config.eventTableLabel}
        onConfirm={handleConceptsSelected}
      />
    </div>
  )
}
