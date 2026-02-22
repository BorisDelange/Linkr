import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  ChevronLeft,
  ChevronRight,
  User,
  Calendar,
  Users,
  Bed,
  Filter,
  X,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { usePatientData } from './use-patient-data'

/** Compute days between two date strings. Returns null if either is missing. */
function daysBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

export function PatientDataSidebar() {
  const { t, i18n } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { setSelectedCohort } = usePatientChartStore()

  const {
    cohorts,
    cohortId,
    patients,
    patientCount,
    patientPage,
    patientPageSize,
    patientsLoading,
    setPatientPage,
    patientFilters,
    setPatientFilters,
    visits,
    visitsLoading,
    visitDetails,
    visitDetailsLoading,
    hasVisitDetailTable,
    demographics,
    patientId,
    visitId,
    visitDetailId,
    selectPatient,
    selectVisit,
    selectVisitDetail,
  } = usePatientData(dataSourceId, schemaMapping, projectUid)

  const totalPages = Math.ceil(patientCount / patientPageSize)
  const genderValues = schemaMapping?.genderValues
  const hasActiveFilters = !!(
    patientFilters.gender ||
    patientFilters.ageMin != null ||
    patientFilters.ageMax != null ||
    patientFilters.admissionAfter ||
    patientFilters.admissionBefore
  )

  const formatGender = (gender: string | undefined) => {
    if (!gender || !genderValues) return gender ?? '—'
    if (gender === genderValues.male) return t('patient_data.male')
    if (gender === genderValues.female) return t('patient_data.female')
    return gender
  }

  const formatGenderShort = (gender: string | undefined) => {
    if (!gender || !genderValues) return gender ?? '—'
    if (gender === genderValues.male) return t('patient_data.male_short')
    if (gender === genderValues.female) return t('patient_data.female_short')
    return gender
  }

  const formatDate = (d: string | undefined) => {
    if (!d) return '—'
    try {
      const dt = new Date(d)
      if (i18n.language === 'fr') {
        return dt.toLocaleDateString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit' })
      }
      // EN: YYYY-MM-DD
      const y = dt.getFullYear()
      const m = String(dt.getMonth() + 1).padStart(2, '0')
      const dd = String(dt.getDate()).padStart(2, '0')
      return `${y}-${m}-${dd}`
    } catch {
      return d
    }
  }

  // Compute LOS
  const selectedVisit = visits.find((v) => String(v.visit_id) === visitId)
  const hospitalizationLos = daysBetween(selectedVisit?.start_date, selectedVisit?.end_date)
  const selectedDetail = visitDetails.find((vd) => String(vd.visit_detail_id) === visitDetailId)
  const stayLos = daysBetween(selectedDetail?.start_date, selectedDetail?.end_date)

  return (
    <div className="flex h-full flex-col border-l bg-card">
      <Allotment vertical>
        {/* Top pane: Cohort + patient list */}
        <Allotment.Pane minSize={150}>
          <div className="flex h-full flex-col">
            {/* Cohort selector */}
            <div className="shrink-0 border-b px-3 py-2.5">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('patient_data.cohort')}
              </label>
              <Select
                value={cohortId ?? '__all__'}
                onValueChange={(v) =>
                  setSelectedCohort(projectUid, v === '__all__' ? null : v)
                }
              >
                <SelectTrigger className="mt-1 h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">
                    {t('patient_data.all_patients')}
                  </SelectItem>
                  {cohorts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Patient list */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 px-3 pt-2.5 pb-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('patient_data.patients')} ({patientCount})
                  </label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={cn(
                          hasActiveFilters && 'text-primary bg-primary/10',
                        )}
                      >
                        <Filter size={12} className={cn(hasActiveFilters && 'fill-current')} />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3" align="end">
                      <div className="space-y-2.5">
                        <h4 className="text-xs font-semibold">{t('patient_data.filters_title')}</h4>

                        {/* Gender filter */}
                        {genderValues && (
                          <div>
                            <label className="text-[10px] text-muted-foreground">
                              {t('patient_data.gender_label')}
                            </label>
                            <Select
                              value={patientFilters.gender ?? '__all__'}
                              onValueChange={(v) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  gender: v === '__all__' ? null : v,
                                })
                              }
                            >
                              <SelectTrigger className="mt-0.5 h-7 w-full text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__all__">
                                  {t('patient_data.filter_all')}
                                </SelectItem>
                                <SelectItem value={genderValues.male}>
                                  {t('patient_data.male')}
                                </SelectItem>
                                <SelectItem value={genderValues.female}>
                                  {t('patient_data.female')}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {/* Age range filter */}
                        <div>
                          <label className="text-[10px] text-muted-foreground">
                            {t('patient_data.age')}
                          </label>
                          <div className="mt-0.5 flex items-center gap-1">
                            <Input
                              type="number"
                              placeholder={t('cohorts.age_min')}
                              value={patientFilters.ageMin ?? ''}
                              onChange={(e) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  ageMin: e.target.value ? Number(e.target.value) : null,
                                })
                              }
                              className="h-7 text-xs"
                            />
                            <span className="text-xs text-muted-foreground">—</span>
                            <Input
                              type="number"
                              placeholder={t('cohorts.age_max')}
                              value={patientFilters.ageMax ?? ''}
                              onChange={(e) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  ageMax: e.target.value ? Number(e.target.value) : null,
                                })
                              }
                              className="h-7 text-xs"
                            />
                          </div>
                        </div>

                        {/* Admission date filter */}
                        <div>
                          <label className="text-[10px] text-muted-foreground">
                            {t('patient_data.admission_date')}
                          </label>
                          <div className="mt-0.5 flex items-center gap-1">
                            <Input
                              type="date"
                              value={patientFilters.admissionAfter ?? ''}
                              onChange={(e) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  admissionAfter: e.target.value || null,
                                })
                              }
                              className="h-7 text-xs"
                            />
                            <span className="text-xs text-muted-foreground">—</span>
                            <Input
                              type="date"
                              value={patientFilters.admissionBefore ?? ''}
                              onChange={(e) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  admissionBefore: e.target.value || null,
                                })
                              }
                              className="h-7 text-xs"
                            />
                          </div>
                        </div>

                        {/* Clear filters */}
                        {hasActiveFilters && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="gap-1 text-xs"
                            onClick={() => setPatientFilters({})}
                          >
                            <X size={10} />
                            {t('patient_data.clear_filters')}
                          </Button>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-2 pb-2">
                  {patientsLoading && patients.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  ) : patients.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      {t('patient_data.no_patients')}
                    </div>
                  ) : (
                    patients.map((p) => (
                      <button
                        key={p.patient_id}
                        onClick={() => selectPatient(String(p.patient_id))}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                          String(p.patient_id) === patientId
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-foreground hover:bg-accent/50',
                        )}
                      >
                        <User size={10} className="shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono text-[11px]">
                          {p.patient_id}
                        </span>
                        {p.gender && (
                          <span className="shrink-0 text-muted-foreground">
                            {formatGenderShort(String(p.gender))}
                          </span>
                        )}
                        {p.age != null && (
                          <span className="shrink-0 text-muted-foreground">
                            {Math.round(Number(p.age))}{t('patient_data.years')}
                          </span>
                        )}
                        {p.visit_count != null && (
                          <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                            {p.visit_count}{t('patient_data.visit_abbr')}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </ScrollArea>
              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex shrink-0 items-center justify-center gap-2 border-t px-2 py-1.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={patientPage === 0}
                    onClick={() => setPatientPage(patientPage - 1)}
                  >
                    <ChevronLeft size={12} />
                  </Button>
                  <span className="text-[10px] text-muted-foreground">
                    {patientPage + 1} / {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={patientPage >= totalPages - 1}
                    onClick={() => setPatientPage(patientPage + 1)}
                  >
                    <ChevronRight size={12} />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Allotment.Pane>

        {/* Bottom pane: Visit/Stay selectors + Demographics */}
        <Allotment.Pane minSize={100}>
          <ScrollArea className="h-full">
            {/* Hospitalization selector */}
            <div className="shrink-0 border-b px-3 py-2.5">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {hasVisitDetailTable
                  ? t('patient_data.hospitalization')
                  : t('patient_data.visit')}
              </label>
              {!patientId ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('patient_data.select_patient_first')}
                </p>
              ) : visitsLoading ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('common.loading')}
                </p>
              ) : visits.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('patient_data.no_visits')}
                </p>
              ) : (
                <Select
                  value={visitId ?? ''}
                  onValueChange={(v) => selectVisit(v || null)}
                >
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {visits.map((v) => (
                      <SelectItem key={v.visit_id} value={String(v.visit_id)}>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Calendar size={10} className="shrink-0 text-muted-foreground" />
                          <span className="truncate">
                            {formatDate(v.start_date)}
                            {v.end_date ? ` — ${formatDate(v.end_date)}` : ''}
                            {v.visit_type ? ` · ${v.visit_type}` : ''}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Stay selector (visit_detail) — only when visitDetailTable exists */}
            {hasVisitDetailTable && visitId && (
              <div className="shrink-0 border-b px-3 py-2.5">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('patient_data.stay')}
                </label>
                {visitDetailsLoading ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('common.loading')}
                  </p>
                ) : visitDetails.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('patient_data.no_stays')}
                  </p>
                ) : (
                  <Select
                    value={visitDetailId ?? '__all__'}
                    onValueChange={(v) =>
                      selectVisitDetail(v === '__all__' ? null : v)
                    }
                  >
                    <SelectTrigger className="mt-1 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">
                        {t('patient_data.all_stays')}
                      </SelectItem>
                      {visitDetails.map((vd) => (
                        <SelectItem
                          key={vd.visit_detail_id}
                          value={String(vd.visit_detail_id)}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Bed size={10} className="shrink-0 text-muted-foreground" />
                            <span className="truncate">
                              {formatDate(vd.start_date)}
                              {vd.end_date ? ` — ${formatDate(vd.end_date)}` : ''}
                              {vd.unit ? ` · ${vd.unit}` : ''}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {/* Patient demographics summary */}
            {demographics && (
              <div className="shrink-0 px-3 py-2.5 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <User size={10} />
                    <span>{t('patient_data.age')}</span>
                  </div>
                  <span className="font-medium">
                    {demographics.age != null
                      ? `${Math.round(Number(demographics.age))} ${t('patient_data.years')}`
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Users size={10} />
                    <span>{t('patient_data.gender_label')}</span>
                  </div>
                  <span className="font-medium">
                    {formatGender(demographics.gender != null ? String(demographics.gender) : undefined)}
                  </span>
                </div>
                {/* Hospitalization LOS */}
                {visitId && (
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock size={10} />
                      <span>{t('patient_data.hospitalization_los')}</span>
                    </div>
                    <span className="font-medium">
                      {hospitalizationLos != null
                        ? t('patient_data.days_count', { count: hospitalizationLos })
                        : '—'}
                    </span>
                  </div>
                )}
                {/* Stay LOS */}
                {visitDetailId && (
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Bed size={10} />
                      <span>{t('patient_data.stay_los')}</span>
                    </div>
                    <span className="font-medium">
                      {stayLos != null
                        ? t('patient_data.days_count', { count: stayLos })
                        : '—'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
