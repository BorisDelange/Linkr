import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  ChevronRight,
  User,
  Calendar,
  Users,
  Bed,
  Filter,
  X,
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
import { Separator } from '@/components/ui/separator'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { usePatientData } from './use-patient-data'

export function PatientDataSidebar() {
  const { t } = useTranslation()
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const { setSelectedCohort } = usePatientChartStore()
  const [filtersOpen, setFiltersOpen] = useState(false)

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
      return new Date(d).toLocaleDateString()
    } catch {
      return d
    }
  }

  return (
    <div className="flex h-full flex-col border-l bg-card">
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
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                hasActiveFilters && 'text-primary',
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <Filter size={12} />
            </Button>
          </div>
        </div>

        {/* Patient filters */}
        {filtersOpen && (
          <div className="shrink-0 space-y-1.5 border-b px-3 pb-2.5">
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
        )}

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

      <Separator />

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
            <SelectTrigger className="mt-1 h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visits.map((v) => (
                <SelectItem key={v.visit_id} value={String(v.visit_id)}>
                  <div className="flex items-center gap-1.5">
                    <Calendar size={10} className="text-muted-foreground" />
                    <span>
                      {formatDate(v.start_date)}
                      {v.end_date ? ` — ${formatDate(v.end_date)}` : ''}
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
              <SelectTrigger className="mt-1 h-8 w-full text-xs">
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
                    <div className="flex items-center gap-1.5">
                      <Bed size={10} className="text-muted-foreground" />
                      <span>
                        {vd.unit ? `${vd.unit} · ` : ''}
                        {formatDate(vd.start_date)}
                        {vd.end_date ? ` — ${formatDate(vd.end_date)}` : ''}
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
        <div className="shrink-0 px-3 py-2.5">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <User size={10} />
              <span>{t('patient_data.age')}</span>
            </div>
            <span className="font-medium text-right">
              {demographics.age != null
                ? `${Math.round(Number(demographics.age))} ${t('patient_data.years')}`
                : '—'}
            </span>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Users size={10} />
              <span>{t('patient_data.gender_label')}</span>
            </div>
            <span className="font-medium text-right">
              {formatGender(demographics.gender != null ? String(demographics.gender) : undefined)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
