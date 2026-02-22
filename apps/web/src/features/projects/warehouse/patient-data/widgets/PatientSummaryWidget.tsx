import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { User, Calendar, Bed, Heart, HeartOff } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { usePatientChartContext } from '../PatientChartContext'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildPatientSummaryQuery,
  buildPatientVisitSummaryQuery,
} from '@/lib/duckdb/patient-data-queries'

interface SummaryRow {
  patient_id: string
  gender?: string
  death_date?: string
  first_visit_start?: string
  last_visit_start?: string
  age_first_visit?: number
  age_last_visit?: number
  visit_count?: number
  visit_detail_count?: number
}

interface VisitRow {
  row_type: 'visit' | 'visit_detail'
  visit_id?: string
  visit_detail_id?: string
  start_date?: string
  end_date?: string
  visit_type?: string
  unit?: string
  los_days?: number
}

function daysBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

export function PatientSummaryWidget() {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { selectedPatientId } = usePatientChartStore()
  const patientId = selectedPatientId[projectUid] ?? null
  const [summary, setSummary] = useState<SummaryRow | null>(null)
  const [visits, setVisits] = useState<VisitRow[]>([])

  useEffect(() => {
    if (!dataSourceId || !schemaMapping || !patientId) {
      setSummary(null)
      setVisits([])
      return
    }
    let cancelled = false

    // Fetch summary
    const summSql = buildPatientSummaryQuery(schemaMapping, patientId)
    if (summSql) {
      queryDataSource(dataSourceId, summSql)
        .then((rows) => {
          if (!cancelled && rows.length > 0) setSummary(rows[0] as SummaryRow)
        })
        .catch(() => {
          if (!cancelled) setSummary(null)
        })
    }

    // Fetch visit list
    const visitSql = buildPatientVisitSummaryQuery(schemaMapping, patientId)
    if (visitSql) {
      queryDataSource(dataSourceId, visitSql)
        .then((rows) => {
          if (!cancelled) setVisits(rows as VisitRow[])
        })
        .catch(() => {
          if (!cancelled) setVisits([])
        })
    }

    return () => {
      cancelled = true
    }
  }, [dataSourceId, schemaMapping, patientId])

  const gv = schemaMapping?.genderValues
  const formatGender = (g: string | undefined) => {
    if (!g || !gv) return g ?? '—'
    if (g === gv.male) return t('patient_data.male')
    if (g === gv.female) return t('patient_data.female')
    return g
  }

  const formatDate = (d: string | undefined) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      if (i18n.language === 'fr') {
        return dt.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' })
      }
      const y = dt.getFullYear()
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      const dd = String(dt.getDate()).padStart(2, '0')
      return `${y}-${m}-${dd}`
    } catch {
      return d
    }
  }

  const formatDateShort = (d: string | undefined) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      if (i18n.language === 'fr') {
        return dt.toLocaleDateString('fr-FR', { month: '2-digit', day: '2-digit' })
      }
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      const dd = String(dt.getDate()).padStart(2, '0')
      return `${m}-${dd}`
    } catch {
      return d
    }
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

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  const isDead = !!summary.death_date
  const visitCount = summary.visit_count ?? 0
  const visitDetailCount = summary.visit_detail_count ?? 0

  // Group visit_detail rows under their parent visit
  const visitRows = visits.filter((r) => r.row_type === 'visit')
  const detailsByVisit = new Map<string, VisitRow[]>()
  for (const r of visits) {
    if (r.row_type === 'visit_detail' && r.visit_id) {
      const arr = detailsByVisit.get(String(r.visit_id)) ?? []
      arr.push(r)
      detailsByVisit.set(String(r.visit_id), arr)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden">
      {/* Patient ID header */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10">
          <User size={13} className="text-violet-500" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold font-mono truncate">{summary.patient_id}</p>
        </div>
      </div>

      {/* Stats row: Gender, Age first, Age last */}
      <div className="grid grid-cols-3 gap-1.5 shrink-0">
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.gender_label')}</p>
          <p className="text-xs font-semibold">
            {formatGender(summary.gender != null ? String(summary.gender) : undefined)}
          </p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.age_first_visit')}</p>
          <p className="text-xs font-semibold">
            {summary.age_first_visit != null
              ? `${Math.round(Number(summary.age_first_visit))} ${t('patient_data.years')}`
              : '—'}
          </p>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.age_last_visit')}</p>
          <p className="text-xs font-semibold">
            {summary.age_last_visit != null
              ? `${Math.round(Number(summary.age_last_visit))} ${t('patient_data.years')}`
              : '—'}
          </p>
        </div>
      </div>

      {/* Summary row: Death, Hospitalizations, Unit stays */}
      <div className="grid grid-cols-3 gap-1.5 shrink-0">
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.death')}</p>
          <div className="flex items-center gap-1">
            {isDead ? (
              <HeartOff size={10} className="text-red-500 shrink-0" />
            ) : (
              <Heart size={10} className="text-green-500 shrink-0" />
            )}
            <p className="text-xs font-semibold">
              {isDead
                ? formatDate(summary.death_date)
                : t('patient_data.death_no')}
            </p>
          </div>
        </div>
        <div className="rounded-md bg-muted/50 px-2 py-1">
          <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.visit_count')}</p>
          <p className="text-xs font-semibold">{visitCount}</p>
        </div>
        {visitDetailCount > 0 && (
          <div className="rounded-md bg-muted/50 px-2 py-1">
            <p className="text-[9px] text-muted-foreground leading-tight">{t('patient_data.unit_stays')}</p>
            <p className="text-xs font-semibold">{visitDetailCount}</p>
          </div>
        )}
      </div>

      {/* Hospitalization list */}
      {visitRows.length > 0 && (
        <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground shrink-0 mb-1">
            {t('patient_data.hospitalizations_list')}
          </h4>
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-1 pr-2 pb-1">
              {visitRows.map((v) => {
                const los = v.los_days ?? daysBetween(v.start_date, v.end_date)
                const details = detailsByVisit.get(String(v.visit_id)) ?? []
                return (
                  <div key={v.visit_id}>
                    {/* Hospitalization row */}
                    <div className="flex items-start gap-1.5 text-xs">
                      <Calendar size={10} className="shrink-0 text-muted-foreground mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1 flex-wrap">
                          <span className="font-medium">
                            {formatDate(v.start_date)}
                          </span>
                          {v.end_date && (
                            <>
                              <span className="text-muted-foreground">—</span>
                              <span className="font-medium">{formatDate(v.end_date)}</span>
                            </>
                          )}
                          {los != null && (
                            <span className="text-muted-foreground">
                              ({t('patient_data.days_short', { count: los })})
                            </span>
                          )}
                          {v.visit_type && (
                            <span className="text-muted-foreground ml-auto shrink-0">
                              {v.visit_type}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* Visit detail rows (unit stays) */}
                    {details.map((d) => {
                      const dLos = d.los_days ?? daysBetween(d.start_date, d.end_date)
                      return (
                        <div
                          key={d.visit_detail_id}
                          className="flex items-start gap-1.5 text-xs ml-4 mt-0.5"
                        >
                          <Bed size={9} className="shrink-0 text-muted-foreground mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-1 flex-wrap">
                              {d.unit && (
                                <span className="font-medium text-muted-foreground">
                                  {d.unit}
                                </span>
                              )}
                              <span className="text-muted-foreground">
                                {formatDateShort(d.start_date)}
                                {d.end_date ? ` — ${formatDateShort(d.end_date)}` : ''}
                              </span>
                              {dLos != null && (
                                <span className="text-muted-foreground">
                                  ({t('patient_data.days_short', { count: dLos })})
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
