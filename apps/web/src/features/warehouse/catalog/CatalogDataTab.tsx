import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BedDouble, BookOpen, Search, SlidersHorizontal, Users, X } from 'lucide-react'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { OTHER_MODALITY, periodLabel } from '@/lib/data-catalog/config'
import { publishedVariables } from '@/lib/data-catalog/publish'
import { computeCrossingMasks, PRIMARY, PUBLISHED, SECONDARY, type CellStatus } from '@/lib/data-catalog/suppression'
import { CATALOG_VARIABLE_ORDER, type CatalogCrossingResult, type CatalogVariableId } from '@/types/catalog'
import type { DataCatalog, CatalogResultCache, CatalogConceptRow } from '@/types'

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

// ── Crossings ────────────────────────────────────────────────────

interface Cell { v: number; st: CellStatus }
interface PivotRow { key: string; name: string; cells: (Cell | null)[]; total: Cell | null; second?: Cell | null }

const SEP = '\u0001'

/** A crossing's cells by their modalities, with the status the publication gives each. */
function indexCrossing(crossing: CatalogCrossingResult | undefined, status: Uint8Array | undefined, metric: 'patients' | 'second') {
  const map = new Map<string, Cell>()
  crossing?.rows.forEach((r, i) => {
    const v = metric === 'patients' ? r.patients : (r.records ?? r.stays ?? 0)
    map.set(r.values.join(SEP), { v, st: (status?.[i] ?? PUBLISHED) as CellStatus })
  })
  return map
}

function CountCell({ cell, threshold }: { cell: Cell | null | undefined; threshold: number }) {
  const { t } = useTranslation()
  if (!cell) return <span className="text-muted-foreground/50">{`< ${threshold}`}</span>
  if (cell.st === PRIMARY) {
    return (
      <span className="text-amber-600 dark:text-amber-400" title={t('data_catalog.masked_primary', { threshold })}>{`< ${threshold}`}</span>
    )
  }
  if (cell.st === SECONDARY) {
    return (
      <span className="text-amber-600 line-through decoration-dotted dark:text-amber-400" title={t('data_catalog.masked_secondary')}>
        {cell.v.toLocaleString()}
      </span>
    )
  }
  return <>{cell.v.toLocaleString()}</>
}

function CrossingsView({ catalog, cache }: Props) {
  const { t, i18n } = useTranslation()
  const threshold = catalog.anonymization.threshold
  const crossings = useMemo(
    () => [...(cache.crossings ?? [])].sort((x, y) => x.variables.length - y.variables.length
      || CATALOG_VARIABLE_ORDER.indexOf(x.variables[0]) - CATALOG_VARIABLE_ORDER.indexOf(y.variables[0])),
    [cache.crossings],
  )
  const variables = useMemo(() => publishedVariables(catalog, cache), [catalog, cache])
  const masks = useMemo(() => computeCrossingMasks(cache.crossings ?? [], threshold), [cache.crossings, threshold])
  const [picked, setPicked] = useState<string | null>(null)
  const [metric, setMetric] = useState<'patients' | 'second'>('patients')
  const [third, setThird] = useState<string>('')

  const crossing = crossings.find((c) => c.id === picked) ?? crossings.find((c) => c.variables.length === 2) ?? crossings[0]
  const varLabel = useCallback((v: CatalogVariableId) => t(`data_catalog.var_${v}`), [t])
  const modName = useCallback((v: CatalogVariableId, code: string, fallback: string) => {
    if (code === OTHER_MODALITY) return t('data_catalog.other_services')
    if (v === 'sex') return t(`data_catalog.sex_${code}`)
    if (v === 'period') return periodLabel(code, i18n.language)
    return fallback
  }, [t, i18n.language])

  const view = useMemo(() => {
    if (!crossing) return null
    const [a, b, c] = crossing.variables
    const withConcept = crossing.variables.includes('concept')
    const sameFact = (vars: CatalogVariableId[]) => vars.includes('concept') === withConcept
    const byId = (vars: CatalogVariableId[]) => cache.crossings.find((x) => x.id === vars.join('-'))
    const fixed = c ? (third || variables[c]?.mods[0] || '') : ''
    // "All" of the third variable reads the 2-way crossing without it.
    const source = c && third === '__all__' ? byId([a, b]) : crossing
    const useThird = !!c && third !== '__all__'
    const cells = indexCrossing(source, source && masks.get(source.id)?.status, metric)
    const keyOf = (values: Record<string, string>, vars: CatalogVariableId[]) => vars.map((v) => values[v]).join(SEP)
    const margin = (vars: CatalogVariableId[]) => {
      const withSlice = useThird ? [...vars, c!] : vars
      const canon = CATALOG_VARIABLE_ORDER.filter((v) => withSlice.includes(v))
      const m = sameFact(canon) ? byId(canon) : undefined
      return m ? { vars: canon, cells: indexCrossing(m, masks.get(m.id)?.status, metric) } : null
    }
    const rowMargin = b ? margin([a]) : null
    const colMargin = b ? margin([b]) : null
    const rowVar = variables[a]!
    const colVar = b ? variables[b]! : null
    const rows: PivotRow[] = rowVar.mods.map((code, i) => {
      const at = (colCode?: string): Record<string, string> => ({ [a]: code, ...(b && colCode != null ? { [b]: colCode } : {}), ...(useThird ? { [c!]: fixed } : {}) })
      const srcVars = source?.variables ?? []
      return {
        key: code,
        name: modName(a, code, rowVar.names[i]),
        cells: colVar ? colVar.mods.map((cc) => cells.get(keyOf(at(cc), srcVars)) ?? null) : [cells.get(keyOf(at(), srcVars)) ?? null],
        total: rowMargin ? rowMargin.cells.get(keyOf(at(), rowMargin.vars)) ?? null : null,
      }
    }).filter((r) => r.cells.some(Boolean) || r.total)
    const allRow: PivotRow | null = colVar && colMargin
      ? {
        key: '__all__',
        name: t('data_catalog.row_all', { label: varLabel(a) }),
        cells: colVar.mods.map((cc) => colMargin.cells.get(keyOf({ [b!]: cc, ...(useThird ? { [c!]: fixed } : {}) }, colMargin.vars)) ?? null),
        total: null,
      }
      : null
    const mask = source ? masks.get(source.id) : undefined
    return { a, b, c, colVar, rows, allRow, mask, hasTotal: !!rowMargin, second: withConcept ? 'records' as const : 'stays' as const }
  }, [crossing, cache.crossings, variables, masks, metric, third, modName, varLabel, t])

  const columns = useMemo<DataTableColumn<PivotRow>[]>(() => {
    if (!view) return []
    const first: DataTableColumn<PivotRow> = {
      id: 'name', header: varLabel(view.a), accessor: (r) => r.name, filter: 'text', pinned: true, size: view.a === 'concept' ? 280 : 160,
    }
    const count = (id: string, header: string, get: (r: PivotRow) => Cell | null | undefined): DataTableColumn<PivotRow> => ({
      id, header, accessor: (r) => get(r)?.v ?? null, cell: (r) => <CountCell cell={get(r)} threshold={threshold} />,
      align: 'right', cellClassName: 'tabular-nums', size: 96, minSize: 64,
    })
    if (!view.colVar) return [first, count('value', metric === 'patients' ? t('data_catalog.col_patients') : t(`data_catalog.col_${view.second}`), (r) => r.cells[0])]
    return [
      first,
      ...view.colVar.mods.map((code, j) => count(`c_${j}`, modName(view.b!, code, view.colVar!.names[j]), (r) => r.cells[j])),
      ...(view.hasTotal ? [count('total', t('data_catalog.col_total'), (r) => r.total)] : []),
    ]
  }, [view, metric, threshold, modName, varLabel, t])

  if (!crossing || !view) return <EmptyState icon={BookOpen} title={t('data_catalog.no_data')} />
  const thirdVar = view.c ? variables[view.c] : null
  const allOfThirdComputed = !!view.c && cache.crossings.some((x) => x.id === [view.a, view.b].join('-'))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={crossing.id} onValueChange={(v) => { setPicked(v); setThird('') }}>
          <SelectTrigger className="h-8 w-64 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {crossings.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">{c.variables.map(varLabel).join(' × ')}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {thirdVar && (
          <Select value={third || thirdVar.mods[0]} onValueChange={setThird}>
            <SelectTrigger className="h-8 w-56 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {allOfThirdComputed && (
                <SelectItem value="__all__" className="text-xs">{t('data_catalog.row_all', { label: varLabel(view.c!) })}</SelectItem>
              )}
              {thirdVar.mods.map((code, i) => (
                <SelectItem key={code} value={code} className="text-xs">{`${varLabel(view.c!)} : ${modName(view.c!, code, thirdVar.names[i])}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {view.mask && (
          <span className="text-xs text-muted-foreground">
            {t('data_catalog.crossing_masked_summary', {
              cells: view.mask.cells.toLocaleString(i18n.language),
              primary: view.mask.primary.toLocaleString(i18n.language),
              secondary: view.mask.secondary.toLocaleString(i18n.language),
            })}
          </span>
        )}
        <div className="flex-1" />
        <Tabs value={metric} onValueChange={(v) => setMetric(v as 'patients' | 'second')}>
          <TabsList className="h-8">
            <TabsTrigger value="patients" className="text-xs">{t('data_catalog.col_patients')}</TabsTrigger>
            <TabsTrigger value="second" className="text-xs">{t(`data_catalog.col_${view.second}`)}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <DataTable
          key={`${crossing.id}|${third}`}
          data={view.rows}
          columns={columns}
          rowKey={(r) => r.key}
          pinnedRows={view.allRow ? [view.allRow] : undefined}
          pageSize={100}
          stickyHeader
          emptyMessage={t('data_catalog.no_results')}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">{t('data_catalog.crossing_legend', { threshold })}</p>
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
  const hasCategory = useMemo(() => cache.concepts.some((r) => r.category != null), [cache.concepts])
  const hasSubcategory = useMemo(() => cache.concepts.some((r) => r.subcategory != null), [cache.concepts])

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

export function CatalogDataTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'crossings' | 'concepts'>(cache.crossings?.length ? 'crossings' : 'concepts')

  return (
    <div className="flex flex-col gap-4 pb-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={<BookOpen size={18} />} iconBg={HUE} value={cache.totalConcepts.toLocaleString()} label={t('data_catalog.total_concepts')} />
        <StatCard icon={<Users size={18} />} iconBg={HUE} value={cache.totalPatients.toLocaleString()} label={t('data_catalog.total_patients')} />
        <StatCard icon={<BedDouble size={18} />} iconBg={HUE} value={cache.totalVisits.toLocaleString()} label={t('data_catalog.total_visits')} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'crossings' | 'concepts')} className="gap-3">
        <div className="flex justify-center">
          <TabsList>
            <TabsTrigger value="crossings">{t('data_catalog.subtab_crossings')}</TabsTrigger>
            <TabsTrigger value="concepts">{t('data_catalog.subtab_concepts')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="crossings" className="m-0">
          <CrossingsView catalog={catalog} cache={cache} />
        </TabsContent>
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
