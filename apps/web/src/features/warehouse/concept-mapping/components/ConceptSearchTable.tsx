import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Info } from 'lucide-react'
import { DataTable, type DataTableColumn, type DataTableQuery } from '@/components/ui/data-table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildStandardConceptFilterOptionsQueries,
  buildStandardConceptSearchCountQuery,
  buildStandardConceptSearchQuery,
  NULL_FILTER_VALUE,
} from '@/lib/concept-mapping/mapping-queries'
import { StandardConceptBadge } from '@/lib/concept-mapping/standard-concept-badge'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { SchemaMapping } from '@/types/schema-mapping'
import { ValidityBadge } from '@/lib/concept-mapping/validity-badge'

export interface ConceptSearchRow {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  invalid_reason?: string | null
}

/** Filters that narrow a name search enough to run it without a warning. */
const NARROWING_FILTERS = ['vocabulary_id', 'domain_id', 'concept_class_id', 'standard_concept', 'concept_id', 'concept_code']

interface ConceptSearchTableProps {
  /** The vocabulary database, and how its concept table is laid out. */
  dataSourceId: string
  mapping: SchemaMapping
  onInfo: (row: ConceptSearchRow) => void
  onRowClick?: (row: ConceptSearchRow) => void
  selectedConceptId?: number | null
  /** Concepts already mapped from the current source: dimmed and ticked. */
  mappedConceptIds?: ReadonlySet<number>
}

/**
 * One page at a time of an OHDSI vocabulary's concepts, every column filter,
 * the sort and the paging applied in SQL over the whole vocabulary — ten million
 * concepts never reach the browser. The name filter is the ranked fuzzy search,
 * run on Enter, with a warning when nothing else narrows it. Shared by the
 * Mapping Editor's target panel and the Target concepts tab.
 */
export function ConceptSearchTable({ dataSourceId, mapping, onInfo, onRowClick, selectedConceptId, mappedConceptIds }: ConceptSearchTableProps) {
  const { t } = useTranslation()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [rows, setRows] = useState<ConceptSearchRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [warning, setWarning] = useState<((proceed: boolean) => void) | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await ensureMounted(dataSourceId)
        const queries = Object.entries(buildStandardConceptFilterOptionsQueries(mapping))
        const results = await Promise.all(queries.map(([, sql]) => queryDataSource(dataSourceId, sql, { origin: 'Concept search · filter options' })))
        if (cancelled) return
        setFilterOptions(Object.fromEntries(queries.map(([id], i) => [id, results[i].map((r) => String(r.v)).filter(Boolean)])))
      } catch {
        // No options: the select filters stay hidden.
      }
    })()
    return () => { cancelled = true }
  }, [dataSourceId, mapping, ensureMounted])

  const latest = useRef(0)
  const fetchPage = useCallback(async (q: DataTableQuery) => {
    // Only the latest query may land: a slow page must not overwrite the one
    // asked for after it.
    const ticket = ++latest.current
    setLoading(true)
    try {
      await ensureMounted(dataSourceId)
      const list = (id: string) => (Array.isArray(q.filters[id]) ? q.filters[id] as string[] : undefined)
      const text = (id: string) => (typeof q.filters[id] === 'string' ? q.filters[id] as string : undefined)
      const filters = {
        vocabularyIds: list('vocabulary_id'),
        domainIds: list('domain_id'),
        conceptClassIds: list('concept_class_id'),
        standardConcepts: list('standard_concept'),
        conceptIdPrefix: text('concept_id'),
        conceptCode: text('concept_code'),
      }
      const term = text('concept_name') ?? ''
      const [page, count] = await Promise.all([
        queryDataSource(dataSourceId, buildStandardConceptSearchQuery(mapping, term, filters, q.pageSize, { offset: q.page * q.pageSize, sort: q.sorting }), { origin: 'Concept search · results page' }),
        queryDataSource(dataSourceId, buildStandardConceptSearchCountQuery(mapping, term, filters), { origin: 'Concept search · count results' }),
      ])
      if (ticket !== latest.current) return
      setRows(page as unknown as ConceptSearchRow[])
      setTotal(Number(count[0]?.total ?? 0))
    } catch (err) {
      if (ticket !== latest.current) return
      console.error('Concept search failed:', err)
      setRows([])
      setTotal(0)
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [dataSourceId, mapping, ensureMounted])

  const confirmSearch = useCallback((_value: string, others: Record<string, string | string[]>) => {
    if (NARROWING_FILTERS.some((id) => id in others)) return true
    return new Promise<boolean>((resolve) => setWarning(() => resolve))
  }, [])

  const answerWarning = (proceed: boolean) => {
    warning?.(proceed)
    setWarning(null)
  }

  const columns = useMemo<DataTableColumn<ConceptSearchRow>[]>(() => [
    { id: 'vocabulary_id', header: t('concept_mapping.col_vocabulary'), accessor: (r) => r.vocabulary_id, filter: 'select', size: 80, minSize: 50 },
    { id: 'concept_id', header: t('concept_mapping.col_concept_id'), accessor: (r) => r.concept_id, filter: 'number', filterOnEnter: true, size: 70, minSize: 50, hidden: true, cellClassName: 'font-mono' },
    {
      id: 'concept_name',
      header: t('concept_mapping.col_name'),
      accessor: (r) => r.concept_name,
      filter: 'text',
      filterOnEnter: true,
      confirmFilter: confirmSearch,
      size: 200,
      minSize: 100,
    },
    { id: 'concept_code', header: t('concept_mapping.col_concept_code'), accessor: (r) => r.concept_code, filter: 'text', filterOnEnter: true, size: 80, minSize: 50, hidden: true, cellClassName: 'font-mono' },
    { id: 'domain_id', header: t('concept_mapping.col_domain'), accessor: (r) => r.domain_id ?? '', filter: 'select', size: 80, minSize: 50 },
    { id: 'concept_class_id', header: t('concept_mapping.col_concept_class'), accessor: (r) => r.concept_class_id ?? '', filter: 'select', size: 90, minSize: 50 },
    {
      id: 'standard_concept',
      header: t('concept_mapping.col_std'),
      accessor: (r) => r.standard_concept ?? '',
      filter: 'select',
      selectOptionLabel: (v) => t(v === 'S' ? 'concepts.standard_s' : v === 'C' ? 'concepts.standard_c' : 'concepts.standard_non'),
      selectOptionRender: (o) => (
        <span className="flex items-center gap-1.5">
          <StandardConceptBadge value={o.value === NULL_FILTER_VALUE ? null : o.value} align="start" />
          {o.label}
        </span>
      ),
      size: 40,
      minSize: 30,
      cell: (r) => <StandardConceptBadge value={r.standard_concept} />,
    },
    {
      id: 'valid',
      header: t('concept_mapping.col_valid'),
      accessor: (r) => r.invalid_reason ?? '',
      size: 40,
      minSize: 30,
      hidden: true,
      cell: (r) => <ValidityBadge value={r.invalid_reason} />,
    },
    {
      id: '_actions',
      header: '',
      sortable: false,
      resizable: false,
      accessor: () => '',
      size: 48,
      minSize: 48,
      cell: (r) => (
        <div className="flex items-center justify-end gap-0.5">
          {mappedConceptIds?.has(r.concept_id) && <Check size={11} className="shrink-0 text-green-600" />}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onInfo(r) }}
              >
                <Info size={11} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="text-xs">{t('concept_mapping.concept_info_btn')}</TooltipContent>
          </Tooltip>
        </div>
      ),
    },
  ], [t, confirmSearch, mappedConceptIds, onInfo])

  return (
    <>
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => r.concept_id}
        pageSize={50}
        emptyMessage={t('common.no_results')}
        server={{ total, onQueryChange: fetchPage, filterOptions, loading }}
        selectedRowKey={selectedConceptId ?? null}
        rowClassName={(r) => (
          r.concept_id !== selectedConceptId && mappedConceptIds?.has(r.concept_id) ? 'opacity-50' : undefined
        )}
        onRowClick={onRowClick}
      />
      <AlertDialog open={warning !== null} onOpenChange={(open) => { if (!open) answerWarning(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.unfiltered_search_warning_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('concept_mapping.unfiltered_search_warning_desc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => answerWarning(true)}>{t('concept_mapping.unfiltered_search_warning_proceed')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
