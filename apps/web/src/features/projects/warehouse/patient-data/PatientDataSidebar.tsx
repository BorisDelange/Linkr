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
  HeartPulse,
  Search,
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { DatePickerField } from '@/components/ui/date-picker-field'
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { usePatientData } from './use-patient-data'
import { PatientHoverCard } from './PatientHoverCard'
import { daysBetween, formatDate as fmtDate, formatGender as fmtGender, formatGenderShort as fmtGenderShort, formatStayDuration } from '@/lib/format-helpers'

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
  } = usePatientData(dataSourceId, schemaMapping, projectUid)

  const totalPages = Math.ceil(patientCount / patientPageSize)
  const genderValues = schemaMapping?.genderValues
  const hasActiveFilters = !!(
    patientFilters.gender ||
    patientFilters.ageMin != null ||
    patientFilters.ageMax != null ||
    patientFilters.admissionAfter ||
    patientFilters.admissionBefore ||
    patientFilters.deathStatus
  )

  // Debounced so typing an id doesn't fire a SQL count+page query per keystroke.
  const [idSearch, setIdSearch] = useState('')
  const debouncedIdSearch = useDebouncedValue(idSearch, 300)
  useEffect(() => {
    setPatientFilters((prev) =>
      (prev.patientIdSearch ?? '') === debouncedIdSearch
        ? prev
        : { ...prev, patientIdSearch: debouncedIdSearch || null },
    )
  }, [debouncedIdSearch, setPatientFilters])

  // Arrow-key navigation moves the selection, not the scroll position, so the
  // selected row walks out of view without this. `nearest` keeps the list still
  // while the row is already visible, instead of recentring on every keypress.
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const patientListRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [patientId, patientPage])

  /**
   * Hand focus back to the list after a page change.
   *
   * A page change unmounts every row, so if focus sat on one — Radix's tooltip
   * trigger focuses the row button, and clicking a row focuses it too — it
   * falls back to <body> and the arrows stop working. Clicking the ‹ › buttons
   * parks focus on the button, which is just as dead. Restoring whenever focus
   * is no longer inside the list covers all three, while still leaving it alone
   * when the user is typing in the search field.
   */
  const pageRef = useRef(patientPage)
  const wantFocusRef = useRef(false)
  useEffect(() => {
    if (pageRef.current !== patientPage) {
      pageRef.current = patientPage
      // Don't grab focus from someone typing a patient id.
      const active = document.activeElement
      wantFocusRef.current = !(
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      )
    }
    // Deliberately runs on every render until it succeeds, not once on the page
    // change: the new page's rows arrive asynchronously, and while the list is
    // still loading it is tabIndex=-1, so focus() is silently a no-op. Waiting
    // for rows to exist is what makes this stick.
    if (!wantFocusRef.current || patients.length === 0) return
    const list = patientListRef.current
    if (!list) return
    wantFocusRef.current = false
    list.focus({ preventScroll: true })
  }, [patientPage, patients])

  const formatGender = (gender: string | undefined) => fmtGender(gender, genderValues, t)
  const formatGenderShort = (gender: string | undefined) => fmtGenderShort(gender, genderValues, t)
  const formatDate = (d: string | undefined) => fmtDate(d, i18n.language)

  // Compute LOS
  const selectedVisit = visits.find((v) => String(v.visit_id) === visitId)
  const hospitalizationLos = daysBetween(selectedVisit?.start_date, selectedVisit?.end_date)
  const selectedDetail = visitDetails.find((vd) => String(vd.visit_detail_id) === visitDetailId)
  const stayLos = daysBetween(selectedDetail?.start_date, selectedDetail?.end_date)

  const isDeceased = !!demographics?.death_date

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden border-l bg-card">
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
                    <PopoverContent className="w-80 p-3" align="end">
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="text-xs font-semibold">
                            {t('patient_data.filters_title')}
                          </h4>
                          {hasActiveFilters && (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="-mr-1 h-6 gap-1 text-xs"
                              onClick={() => setPatientFilters({})}
                            >
                              <X size={10} />
                              {t('patient_data.clear_filters')}
                            </Button>
                          )}
                        </div>

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
                          {/* Stacked, not side by side: two dates sharing this
                              popover's width leave each field too narrow for the
                              icon, the formatted date and the clear button, so the
                              date was truncated whatever the popover width. */}
                          <div className="mt-0.5 space-y-1">
                            <DatePickerField
                              value={patientFilters.admissionAfter ?? undefined}
                              onChange={(v) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  admissionAfter: v ?? null,
                                })
                              }
                              placeholder={t('patient_data.admission_from')}
                            />
                            <DatePickerField
                              value={patientFilters.admissionBefore ?? undefined}
                              onChange={(v) =>
                                setPatientFilters({
                                  ...patientFilters,
                                  admissionBefore: v ?? null,
                                })
                              }
                              placeholder={t('patient_data.admission_to')}
                            />
                          </div>
                        </div>

                        {/* Death status filter */}
                        <div>
                          <label className="text-[10px] text-muted-foreground">
                            {t('patient_data.death_status')}
                          </label>
                          <Select
                            value={patientFilters.deathStatus ?? '__all__'}
                            onValueChange={(v) =>
                              setPatientFilters({
                                ...patientFilters,
                                deathStatus: v === '__all__' ? null : (v as 'alive' | 'deceased'),
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
                              <SelectItem value="alive">{t('patient_data.alive')}</SelectItem>
                              <SelectItem value="deceased">{t('patient_data.deceased')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="relative mt-1.5">
                  <Search
                    size={11}
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={idSearch}
                    onChange={(e) => setIdSearch(e.target.value)}
                    placeholder={t('patient_data.search_patient_id')}
                    className="h-7 pl-6 pr-6 text-xs"
                  />
                  {idSearch && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="absolute right-0.5 top-1/2 -translate-y-1/2"
                      onClick={() => setIdSearch('')}
                    >
                      <X size={10} />
                    </Button>
                  )}
                </div>
              </div>

              <ScrollArea className="flex-1 min-h-0 [&>div>div]:!block [&>div>div]:!min-w-0">
                {/* Roving focus stays on the list container rather than the rows:
                    the arrows must keep working across a page change, where the
                    previously focused row unmounts. tabIndex makes it focusable. */}
                <div
                  ref={patientListRef}
                  className="px-2 pb-2 outline-none"
                  tabIndex={patients.length > 0 ? 0 : -1}
                  role="listbox"
                  aria-label={t('patient_data.patients')}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
                    // Otherwise the ScrollArea also scrolls, doubling the movement.
                    e.preventDefault()
                    if (e.key === 'ArrowDown') goNextPatient()
                    else goPrevPatient()
                  }}
                >
                  {patientsLoading && patients.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      {t('common.loading')}
                    </div>
                  ) : patients.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      {t('patient_data.no_patients')}
                    </div>
                  ) : (
                    <TooltipProvider delayDuration={400}>
                      {patients.map((p) => {
                        const hosp = p.visit_count != null ? Number(p.visit_count) : null
                        return (
                          <Tooltip key={p.patient_id}>
                            <TooltipTrigger asChild>
                              <button
                                // Radix opens a tooltip on focus as well as on
                                // hover. A row takes focus when clicked, and
                                // again when the list is refocused after a page
                                // change, so the card appeared with the pointer
                                // nowhere near it. composeEventHandlers skips
                                // Radix's own handler once default is prevented,
                                // which leaves hover untouched.
                                onFocus={(e) => e.preventDefault()}
                                ref={
                                  String(p.patient_id) === patientId
                                    ? selectedRowRef
                                    : undefined
                                }
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
                                {hosp != null && (
                                  <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                                    {hosp}{t('patient_data.visit_abbr')}
                                  </span>
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              <PatientHoverCard
                                dataSourceId={dataSourceId}
                                schemaMapping={schemaMapping}
                                patientId={String(p.patient_id)}
                              />
                            </TooltipContent>
                          </Tooltip>
                        )
                      })}
                    </TooltipProvider>
                  )}
                </div>
              </ScrollArea>
              {/* Pagination + selected-patient navigation */}
              {(totalPages > 1 || patientGlobalIndex != null) && (
                <div className="flex shrink-0 items-center justify-between border-t px-2 py-1.5">
                  {/* Left: page navigation */}
                  {totalPages > 1 ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        data-patient-pager="true"
                        disabled={patientPage === 0}
                        onClick={() => setPatientPage(patientPage - 1)}
                      >
                        <ChevronLeft size={12} />
                      </Button>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {patientPage + 1} / {totalPages}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        data-patient-pager="true"
                        disabled={patientPage >= totalPages - 1}
                        onClick={() => setPatientPage(patientPage + 1)}
                      >
                        <ChevronRight size={12} />
                      </Button>
                    </div>
                  ) : (
                    <span />
                  )}

                  {/* Right: selected-patient index with prev/next */}
                  {patientGlobalIndex != null && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!canPrevPatient}
                        onClick={goPrevPatient}
                      >
                        <ChevronLeft size={12} />
                      </Button>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {patientGlobalIndex} / {patientCount}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!canNextPatient}
                        onClick={goNextPatient}
                      >
                        <ChevronRight size={12} />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Allotment.Pane>

        {/* Bottom pane: Visit/Stay selectors + Demographics.
            Radix renders the ScrollArea viewport child as `display:table`,
            which shrink-wraps to the widest content (long visit labels) and
            breaks `truncate`. Force that child to a width-respecting block. */}
        <Allotment.Pane minSize={100}>
          <ScrollArea className="h-full [&>div>div]:!block [&>div>div]:!min-w-0">
            {/* Hospitalization selector */}
            <div className="shrink-0 border-b px-3 py-2.5">
              <div className="flex items-center justify-between gap-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {hasVisitDetailTable
                    ? t('patient_data.hospitalization')
                    : t('patient_data.visit')}
                </label>
                {patientId && visits.length > 0 && (
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-5 w-5"
                      disabled={visitIndex <= 0}
                      onClick={goPrevVisit}
                    >
                      <ChevronLeft size={12} />
                    </Button>
                    <span className="min-w-8 text-center text-[10px] tabular-nums text-muted-foreground">
                      {visitIndex >= 0 ? `${visitIndex + 1} / ${visits.length}` : `· / ${visits.length}`}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-5 w-5"
                      disabled={visitIndex < 0 || visitIndex >= visits.length - 1}
                      onClick={goNextVisit}
                    >
                      <ChevronRight size={12} />
                    </Button>
                  </div>
                )}
              </div>
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
                  value={visitId ?? '__all__'}
                  onValueChange={(v) => selectVisit(v === '__all__' ? null : v)}
                >
                  <SelectTrigger className="mt-1 h-8 w-full min-w-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  {/* Sized to its rows, not to the (narrow) trigger: the aligned
                      date/duration columns plus the check mark do not fit the
                      sidebar width, and would be clipped at the screen edge. */}
                  <SelectContent className="w-auto max-w-[min(30rem,90vw)] pr-2">
                    <SelectItem value="__all__">
                      {hasVisitDetailTable
                        ? t('patient_data.all_hospitalizations')
                        : t('patient_data.all_visits')}
                    </SelectItem>
                    {visits.map((v) => (
                      <SelectItem key={v.visit_id} value={String(v.visit_id)}>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Calendar size={10} className="shrink-0 text-muted-foreground" />
                          {/* One cell per date, each sized to its own content and
                              kept on a single line, so the columns after them line
                              up down the list. The separating dash is redundant
                              once the two dates sit in distinct columns. */}
                          <span className="w-[5.5rem] shrink-0 whitespace-nowrap tabular-nums">
                            {formatDate(v.start_date)}
                          </span>
                          <span className="w-[5.5rem] shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                            {v.end_date ? formatDate(v.end_date) : ''}
                          </span>
                          <span className="w-[3.75rem] shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                            {formatStayDuration(v.start_date, v.end_date, t) ?? ''}
                          </span>
                          {v.visit_type && (
                            <span className="truncate pr-1">{v.visit_type}</span>
                          )}
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
                <div className="flex items-center justify-between gap-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('patient_data.stay')}
                  </label>
                  {visitDetails.length > 0 && (
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="h-5 w-5"
                        disabled={detailIndex <= 0}
                        onClick={goPrevVisitDetail}
                      >
                        <ChevronLeft size={12} />
                      </Button>
                      <span className="min-w-8 text-center text-[10px] tabular-nums text-muted-foreground">
                        {detailIndex >= 0 ? `${detailIndex + 1} / ${visitDetails.length}` : `· / ${visitDetails.length}`}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="h-5 w-5"
                        disabled={detailIndex < 0 || detailIndex >= visitDetails.length - 1}
                        onClick={goNextVisitDetail}
                      >
                        <ChevronRight size={12} />
                      </Button>
                    </div>
                  )}
                </div>
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
                    <SelectTrigger className="mt-1 h-8 w-full min-w-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="w-auto max-w-[min(30rem,90vw)] pr-2">
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
                            <span className="w-[5.5rem] shrink-0 whitespace-nowrap tabular-nums">
                              {formatDate(vd.start_date)}
                            </span>
                            <span className="w-[5.5rem] shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                              {vd.end_date ? formatDate(vd.end_date) : ''}
                            </span>
                            <span className="w-[3.75rem] shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
                              {formatStayDuration(vd.start_date, vd.end_date, t) ?? ''}
                            </span>
                            {vd.unit && <span className="truncate pr-1">{vd.unit}</span>}
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
                {/* Death status */}
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <HeartPulse size={10} />
                    <span>{t('patient_data.death_status')}</span>
                  </div>
                  <span
                    className={cn(
                      'font-medium',
                      isDeceased ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
                    )}
                  >
                    {isDeceased
                      ? t('patient_data.deceased_on', {
                          date: formatDate(String(demographics.death_date)),
                        })
                      : t('patient_data.alive')}
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
