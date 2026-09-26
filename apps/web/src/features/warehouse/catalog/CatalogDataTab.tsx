import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, BedDouble, BookOpen, Search, SlidersHorizontal, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/ui/empty-state'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { fuzzyTextMatch } from '@/lib/fuzzy-search'
import { cn } from '@/lib/utils'
import type { DataCatalog, CatalogResultCache, CatalogConceptRow, CatalogPeriodRow } from '@/types'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

const HUE = `${ENTITY_COLORS['data-catalog'].bg} ${ENTITY_COLORS['data-catalog'].icon}`

/** A count, or the threshold it hides under. Suppressed cells read in amber so they stand apart from real small numbers. */
function Masked({ value, threshold }: { value: number | null | undefined; threshold: number }) {
  if (value == null || value < threshold) {
    return <span className="text-amber-600 dark:text-amber-400">{`< ${threshold}`}</span>
  }
  return <>{value.toLocaleString()}</>
}

function countColumn<T>(
  id: string,
  header: string,
  get: (row: T) => number | null | undefined,
  threshold: number,
): DataTableColumn<T> {
  return {
    id,
    header,
    accessor: (r) => get(r) ?? null,
    cell: (r) => <Masked value={get(r)} threshold={threshold} />,
    align: 'right',
    cellClassName: 'tabular-nums',
    size: 110,
    minSize: 70,
  }
}

// ── Period views ─────────────────────────────────────────────────

type PeriodView = 'demographics' | 'services' | 'categories'

function PeriodTable({ catalog, cache, view }: Props & { view: PeriodView }) {
  const { t } = useTranslation()
  const threshold = catalog.anonymization.threshold
  const periods = cache.periods ?? []
  const allRow = periods.find((r) => r.period_granularity === 'all')
  const rows = useMemo(() => periods.filter((r) => r.period_granularity !== 'all'), [periods])
  const [metric, setMetric] = useState<'patients' | 'second'>('patients')

  const columns = useMemo<DataTableColumn<CatalogPeriodRow>[]>(() => {
    const period: DataTableColumn<CatalogPeriodRow> = {
      id: 'period',
      header: t('data_catalog.period_col_period'),
      accessor: (r) => r.period_start || r.period_label,
      display: (r) => r.period_label,
      filter: 'text',
      pinned: true,
      size: 110,
    }
    if (view === 'demographics') {
      const ageLabels = allRow ? Object.keys(allRow.age_buckets) : []
      const hasSex = !!allRow && [allRow.sex_m, allRow.sex_f, allRow.sex_other].some((v) => v !== undefined)
        && catalog.dimensions.some((d) => d.type === 'sex' && d.enabled)
      return [
        period,
        countColumn('n_patients', t('data_catalog.period_col_n_patients'), (r) => r.n_patients, threshold),
        countColumn('n_sejours', t('data_catalog.period_col_n_sejours'), (r) => r.n_sejours, threshold),
        ...(hasSex
          ? [
              countColumn<CatalogPeriodRow>('sex_m', t('data_catalog.period_col_sex_m'), (r) => r.sex_m, threshold),
              countColumn<CatalogPeriodRow>('sex_f', t('data_catalog.period_col_sex_f'), (r) => r.sex_f, threshold),
              countColumn<CatalogPeriodRow>('sex_other', t('data_catalog.period_col_sex_other'), (r) => r.sex_other, threshold),
            ]
          : []),
        ...ageLabels.map((label) =>
          countColumn<CatalogPeriodRow>(`age_${label}`, label.replace('+inf', '+∞'), (r) => r.age_buckets[label], threshold),
        ),
      ]
    }
    if (view === 'services') {
      const labels = allRow ? Object.keys(allRow.services) : []
      return [
        period,
        ...labels.map((svc) =>
          countColumn<CatalogPeriodRow>(
            `svc_${svc}`,
            svc,
            (r) => (metric === 'patients' ? r.services[svc]?.n_patients : r.services[svc]?.n_sejours),
            threshold,
          ),
        ),
      ]
    }
    const labels = allRow ? Object.keys(allRow.concept_categories) : []
    return [
      period,
      ...labels.map((cat) =>
        countColumn<CatalogPeriodRow>(
          `cat_${cat}`,
          cat,
          (r) => (metric === 'patients' ? r.concept_categories[cat]?.n_patients : r.concept_categories[cat]?.n_rows),
          threshold,
        ),
      ),
    ]
  }, [view, allRow, metric, threshold, catalog.dimensions, t])

  const secondLabel = view === 'services' ? t('data_catalog.period_col_n_sejours') : t('data_catalog.col_records')

  return (
    <div className="flex flex-col gap-2">
      {view !== 'demographics' && (
        <div className="flex justify-end">
          <Tabs value={metric} onValueChange={(v) => setMetric(v as 'patients' | 'second')}>
            <TabsList className="h-8">
              <TabsTrigger value="patients" className="text-xs">{t('data_catalog.period_col_n_patients')}</TabsTrigger>
              <TabsTrigger value="second" className="text-xs">{secondLabel}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border bg-card">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(r) => r.period_start || r.period_label}
          pinnedRows={allRow ? [allRow] : undefined}
          pageSize={100}
          stickyHeader
          initialSorting={{ columnId: 'period', desc: false }}
          emptyMessage={t('data_catalog.no_results')}
        />
      </div>
    </div>
  )
}

/** Share of masked period cells, shown once above the period tables. */
function ReliabilityBanner({ score }: { score: number }) {
  const { t } = useTranslation()
  const pct = Math.round(score * 100)
  const warn = pct > 20
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
        warn ? 'border-amber-400/50 bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400' : 'text-muted-foreground',
      )}
    >
      {warn && <AlertTriangle size={14} className="shrink-0" />}
      <span className={warn ? 'font-medium' : undefined}>{t('data_catalog.period_reliability_score', { pct })}</span>
      {warn && <span>— {t('data_catalog.period_reliability_warning')}</span>}
    </div>
  )
}

// ── Concepts view ────────────────────────────────────────────────

function ConceptsView({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const threshold = catalog.anonymization.threshold
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Record<'dictionaryKey' | 'category' | 'subcategory', string[]>>({
    dictionaryKey: [],
    category: [],
    subcategory: [],
  })

  const hasDictionary = useMemo(
    () => new Set(cache.concepts.map((r) => r.dictionaryKey).filter(Boolean)).size > 1,
    [cache.concepts],
  )
  const hasCategory = !!catalog.categoryColumn
  const hasSubcategory = !!catalog.subcategoryColumn

  const facets = useMemo(() => {
    const collect = (get: (r: CatalogConceptRow) => string | null | undefined, rows = cache.concepts) =>
      [...new Set(rows.map(get).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b))
    // Subcategories follow the picked categories, so the list only offers what can still match.
    const underCategory = picked.category.length
      ? cache.concepts.filter((r) => r.category != null && picked.category.includes(r.category))
      : cache.concepts
    return [
      ...(hasDictionary ? [{ key: 'dictionaryKey' as const, label: t('data_catalog.col_vocabulary'), options: collect((r) => r.dictionaryKey) }] : []),
      ...(hasCategory ? [{ key: 'category' as const, label: t('data_catalog.col_category'), options: collect((r) => r.category) }] : []),
      ...(hasSubcategory ? [{ key: 'subcategory' as const, label: t('data_catalog.col_subcategory'), options: collect((r) => r.subcategory, underCategory) }] : []),
    ]
  }, [cache.concepts, hasDictionary, hasCategory, hasSubcategory, picked.category, t])

  const activeFilterCount = facets.reduce((n, f) => n + picked[f.key].length, 0)

  const rows = useMemo(() => {
    const q = search.trim()
    return cache.concepts.filter((r) => {
      if (q && !fuzzyTextMatch(r.conceptName, q) && !String(r.conceptId).includes(q)) return false
      for (const f of facets) {
        const sel = picked[f.key]
        if (sel.length && !sel.includes((r[f.key] ?? '') as string)) return false
      }
      return true
    })
  }, [cache.concepts, search, facets, picked])

  const columns = useMemo<DataTableColumn<CatalogConceptRow>[]>(() => [
    { id: 'conceptId', header: t('data_catalog.col_concept_id'), accessor: (r) => r.conceptId, filter: 'text', size: 100, cellClassName: 'font-mono' },
    { id: 'conceptName', header: t('data_catalog.col_concept_name'), accessor: (r) => r.conceptName, filter: 'text', size: 320 },
    ...(hasDictionary ? [{ id: 'dictionaryKey', header: t('data_catalog.col_vocabulary'), accessor: (r: CatalogConceptRow) => r.dictionaryKey ?? null, filter: 'select' as const, size: 140 }] : []),
    ...(hasCategory ? [{ id: 'category', header: t('data_catalog.col_category'), accessor: (r: CatalogConceptRow) => r.category ?? null, filter: 'select' as const, size: 150 }] : []),
    ...(hasSubcategory ? [{ id: 'subcategory', header: t('data_catalog.col_subcategory'), accessor: (r: CatalogConceptRow) => r.subcategory ?? null, filter: 'select' as const, size: 150 }] : []),
    countColumn('patientCount', t('data_catalog.col_patients'), (r) => r.patientCount, threshold),
    // Visits and records are masked on the row's patient count, as the export does:
    // a row's small cohort is what identifies, whatever it is counted in.
    { ...countColumn<CatalogConceptRow>('visitCount', t('data_catalog.col_visits'), (r) => r.visitCount, threshold), cell: (r) => <Masked value={r.patientCount < threshold ? null : r.visitCount} threshold={threshold} /> },
    { ...countColumn<CatalogConceptRow>('recordCount', t('data_catalog.col_records'), (r) => r.recordCount, threshold), cell: (r) => <Masked value={r.patientCount < threshold ? null : r.recordCount} threshold={threshold} /> },
  ], [hasDictionary, hasCategory, hasSubcategory, threshold, t])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {facets.length > 0 && (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className={cn('h-8 w-8 shrink-0', activeFilterCount > 0 && 'text-primary')}>
                    <SlidersHorizontal size={14} />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('common.filters')}</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-[260px] space-y-3 p-3" onCloseAutoFocus={(e) => e.preventDefault()}>
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">{t('common.filters')}</p>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => setPicked({ dictionaryKey: [], category: [], subcategory: [] })}
                  >
                    {t('common.clear')}
                  </button>
                )}
              </div>
              {facets.map((f) => (
                <div key={f.key} className="space-y-1">
                  <label className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{f.label}</label>
                  <MultiSelectFilter
                    value={picked[f.key]}
                    options={f.options}
                    placeholder={f.label}
                    onChange={(v) => setPicked((p) => ({
                      ...p,
                      [f.key]: v,
                      // A subcategory picked under a category no longer selected would match nothing.
                      ...(f.key === 'category' ? { subcategory: [] } : {}),
                    }))}
                    triggerClass="h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none focus:border-primary"
                    popoverWidthClass="w-[300px]"
                  />
                </div>
              ))}
            </PopoverContent>
          </Popover>
        )}
        <div className="relative max-w-md min-w-0 flex-1">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pr-7 pl-8 text-xs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearch('') }}
            placeholder={t('data_catalog.search_concepts')}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={t('common.clear')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <DataTable
          data={rows}
          columns={columns}
          rowKey={(r) => `${r.dictionaryKey ?? ''}:${r.conceptId}`}
          pageSize={100}
          stickyHeader
          cellTooltips="all"
          initialSorting={{ columnId: 'patientCount', desc: true }}
          emptyMessage={t('data_catalog.no_results')}
        />
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────

type SubTab = PeriodView | 'concepts'

export function CatalogDataTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const allRow = cache.periods?.find((r) => r.period_granularity === 'all')
  const hasPeriods = !!cache.periods?.length
  const hasServices = !!allRow && Object.keys(allRow.services).length > 0
  const hasCategories = !!allRow && Object.keys(allRow.concept_categories).length > 0

  const subTabs: { id: SubTab; label: string }[] = [
    ...(hasPeriods ? [{ id: 'demographics' as const, label: t('data_catalog.subtab_demographics') }] : []),
    ...(hasServices ? [{ id: 'services' as const, label: t('data_catalog.subtab_services') }] : []),
    ...(hasCategories ? [{ id: 'categories' as const, label: t('data_catalog.subtab_categories') }] : []),
    { id: 'concepts', label: t('data_catalog.subtab_concepts') },
  ]
  const [tab, setTab] = useState<SubTab>(subTabs[0].id)
  const current = subTabs.some((s) => s.id === tab) ? tab : subTabs[0].id

  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={<BookOpen size={18} />} iconBg={HUE} value={cache.totalConcepts.toLocaleString()} label={t('data_catalog.total_concepts')} />
        <StatCard icon={<Users size={18} />} iconBg={HUE} value={cache.totalPatients.toLocaleString()} label={t('data_catalog.total_patients')} />
        <StatCard icon={<BedDouble size={18} />} iconBg={HUE} value={cache.totalVisits.toLocaleString()} label={t('data_catalog.total_visits')} />
      </div>

      <Tabs value={current} onValueChange={(v) => setTab(v as SubTab)} className="gap-3">
        <div className="flex justify-center">
          <TabsList>
            {subTabs.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>{s.label}</TabsTrigger>
            ))}
          </TabsList>
        </div>
        {hasPeriods && current !== 'concepts' && <ReliabilityBanner score={cache.periodReliabilityScore ?? 0} />}
        {(['demographics', 'services', 'categories'] as const).map((view) => (
          <TabsContent key={view} value={view} className="m-0">
            <PeriodTable catalog={catalog} cache={cache} view={view} />
          </TabsContent>
        ))}
        <TabsContent value="concepts" className="m-0">
          {cache.concepts.length ? (
            <ConceptsView catalog={catalog} cache={cache} />
          ) : (
            <EmptyState icon={BookOpen} title={t('data_catalog.no_data')} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
