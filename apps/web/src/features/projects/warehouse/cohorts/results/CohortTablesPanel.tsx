import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import { Loader2, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { discoverFullSchema, queryDataSource } from '@/lib/duckdb/engine'
import { queryErrorMessage } from '@/lib/duckdb/query-error'
import {
  buildTableRowsSql,
  buildTableStatsSql,
  classifyTable,
  nativeIdColumns,
  tableIdColumns,
  type TableFilter,
} from '@/lib/cohort-tables'
import type { Cohort, SchemaMapping } from '@/types'

interface CohortTablesPanelProps {
  dataSourceId: string
  cohort: Cohort
  schemaMapping: SchemaMapping
}

type IdKind = 'patient' | 'visit' | 'visit_detail'
type Stats = { rows: [number, number] } & Partial<Record<IdKind, [number, number]>>
type StatsState = Stats | 'loading' | { error: string }

interface TableRow {
  name: string
  columns: string[]
  filter: TableFilter | null
  idKinds: IdKind[]
}

const PREVIEW_ROWS = 200
const ID_KINDS: IdKind[] = ['patient', 'visit', 'visit_detail']

/**
 * The cohort through every table of its database: how many rows of each belong
 * to it — filtered as a derivation filters them, on the finest id the table
 * carries — and how many patients, stays and unit stays those rows cover. A
 * table's rows can be browsed below. Counts run on demand: a table of hundreds
 * of millions of events is a full scan.
 */
export function CohortTablesPanel({ dataSourceId, cohort, schemaMapping }: CohortTablesPanelProps) {
  const { t } = useTranslation()
  const [tables, setTables] = useState<TableRow[] | null>(null)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [stats, setStats] = useState<Map<string, StatsState>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [countingAll, setCountingAll] = useState(false)
  const stopRef = useRef(false)

  // Counts are for one definition: a changed cohort starts them over.
  const definitionKey = JSON.stringify([cohort.level, cohort.criteriaTree, cohort.customSql ?? null])
  const [countedFor, setCountedFor] = useState(definitionKey)
  if (countedFor !== definitionKey) {
    setCountedFor(definitionKey)
    setStats(new Map())
  }

  useEffect(() => {
    if (cohort.level === 'event') return
    const level = cohort.level
    let cancelled = false
    const ids = nativeIdColumns(schemaMapping)
    discoverFullSchema(dataSourceId)
      .then((schema) => {
        if (cancelled) return
        setTables(
          schema
            .map((s) => {
              const columns = s.columns.map((c) => c.name)
              return {
                name: s.name,
                columns,
                filter: classifyTable(columns, level, ids),
                idKinds: tableIdColumns(columns, ids).map((c) => c.kind),
              }
            })
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      })
      .catch((err) => { if (!cancelled) setSchemaError(queryErrorMessage(err, t, '')) })
    return () => { cancelled = true }
  }, [dataSourceId, schemaMapping, cohort.level, t])

  const count = useCallback(async (table: TableRow) => {
    const sql = buildTableStatsSql(cohort, schemaMapping, table.name, table.columns)
    if (!sql) return
    setStats((m) => new Map(m).set(table.name, 'loading'))
    try {
      const [row] = await queryDataSource(dataSourceId, sql)
      const pair = (a: string, b: string): [number, number] => [Number(row?.[a] ?? 0), Number(row?.[b] ?? 0)]
      const next: Stats = { rows: pair('selected_rows', 'all_rows') }
      for (const kind of table.idKinds) next[kind] = pair(`selected_${kind}`, `all_${kind}`)
      setStats((m) => new Map(m).set(table.name, next))
    } catch (err) {
      setStats((m) => new Map(m).set(table.name, { error: queryErrorMessage(err, t, '') }))
    }
  }, [cohort, schemaMapping, dataSourceId, t])

  const countAll = async () => {
    if (!tables) return
    stopRef.current = false
    setCountingAll(true)
    for (const table of tables) {
      if (stopRef.current) break
      if (table.filter && !stats.has(table.name)) await count(table)
    }
    setCountingAll(false)
  }
  useEffect(() => () => { stopRef.current = true }, [])

  const selectTable = (table: TableRow) => {
    setSelected(table.name)
    if (table.filter && !stats.has(table.name)) void count(table)
  }

  const fraction = (pair: [number, number] | undefined) => {
    if (!pair) return '—'
    const [part, all] = pair
    const pct = all > 0 ? ` (${((part / all) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })} %)` : ''
    return `${part.toLocaleString()} / ${all.toLocaleString()}${pct}`
  }

  const columns = useMemo<DataTableColumn<TableRow>[]>(() => {
    const statOf = (r: TableRow) => {
      const s = stats.get(r.name)
      return s && s !== 'loading' && !('error' in s) ? s : undefined
    }
    const statusCell = (r: TableRow, render: (s: Stats) => string) => {
      const s = stats.get(r.name)
      if (s === 'loading') return <Loader2 size={12} className="animate-spin text-muted-foreground" />
      if (s && 'error' in s) return <span className="text-destructive" title={s.error}>{t('cohorts.tables_error')}</span>
      const ok = statOf(r)
      return <span className="tabular-nums">{ok ? render(ok) : '—'}</span>
    }
    return [
      // Upper case, as SQL documentation writes table names (OMOP's PERSON); the
      // queries keep the real name, which SQL matches whatever its case.
      { id: 'name', header: t('cohorts.tables_col_table'), accessor: (r) => r.name, display: (r) => r.name.toUpperCase(), filter: 'text', size: 180 },
      {
        id: 'filter',
        header: t('cohorts.tables_col_filter'),
        accessor: (r) => (r.filter ? `${r.filter.column} — ${t(`cohorts.tables_filter_${r.filter.kind}`)}` : t('cohorts.tables_filter_none')),
        filter: 'select',
        size: 200,
      },
      {
        id: 'rows',
        header: t('cohorts.tables_col_rows'),
        accessor: (r) => statOf(r)?.rows[0] ?? null,
        cell: (r) => (r.filter ? statusCell(r, (s) => fraction(s.rows)) : <span className="text-muted-foreground">—</span>),
        align: 'right',
        size: 190,
      },
      ...ID_KINDS.map((kind): DataTableColumn<TableRow> => ({
        id: kind,
        header: t(`cohorts.tables_col_${kind}`),
        accessor: (r) => statOf(r)?.[kind]?.[0] ?? null,
        cell: (r) => (r.filter && r.idKinds.includes(kind)
          ? statusCell(r, (s) => fraction(s[kind]))
          : <span className="text-muted-foreground">—</span>),
        align: 'right',
        size: 170,
      })),
    ]
  }, [stats, t])

  if (cohort.level === 'event') {
    return <p className="p-4 text-xs text-muted-foreground">{t('cohorts.tables_event_level')}</p>
  }
  if (schemaError) return <p className="p-4 text-xs text-destructive">{schemaError}</p>
  if (!tables) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  const selectedTable = tables.find((tb) => tb.name === selected) ?? null

  return (
    // Its own stacking context: the tables' sticky header and cells carry a
    // z-index, which painted them over the pane separator beside the panel.
    <div className="isolate h-full">
      <Allotment vertical>
        <Allotment.Pane minSize={120}>
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
              <p className="flex-1 text-[10px] text-muted-foreground">{t('cohorts.tables_hint')}</p>
              {countingAll ? (
                <Button variant="destructive" size="sm" className="h-6 gap-1 text-xs" onClick={() => { stopRef.current = true }}>
                  <Square size={12} />
                  {t('cohorts.tables_stop')}
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs" onClick={() => void countAll()}>
                  <Play size={12} />
                  {t('cohorts.tables_count_all')}
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DataTable
                data={tables}
                columns={columns}
                rowKey={(r) => r.name}
                onRowClick={selectTable}
                selectedRowKey={selected}
                density="compact"
                stickyHeader
                emptyMessage={t('cohorts.tables_none')}
              />
            </div>
          </div>
        </Allotment.Pane>
        <Allotment.Pane minSize={120} visible={!!selectedTable}>
          {selectedTable && (
            <TableRowsPreview
              key={`${selectedTable.name}:${definitionKey}`}
              dataSourceId={dataSourceId}
              cohort={cohort}
              schemaMapping={schemaMapping}
              table={selectedTable}
            />
          )}
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}

function TableRowsPreview({ dataSourceId, cohort, schemaMapping, table }: CohortTablesPanelProps & { table: TableRow }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const sql = buildTableRowsSql(cohort, schemaMapping, table.name, table.columns, PREVIEW_ROWS)
    if (!sql) return
    let cancelled = false
    queryDataSource(dataSourceId, sql)
      .then((r) => { if (!cancelled) setRows(r) })
      .catch((err) => { if (!cancelled) setError(queryErrorMessage(err, t, '')) })
    return () => { cancelled = true }
  }, [dataSourceId, cohort, schemaMapping, table, t])

  const columns = useMemo<DataTableColumn<{ i: number; row: Record<string, unknown> }>[]>(
    () => table.columns.map((name) => ({
      id: name,
      header: name,
      accessor: (r) => {
        const v = r.row[name]
        return v == null ? null : typeof v === 'number' ? v : String(v)
      },
      filter: 'text',
      size: 140,
    })),
    [table.columns],
  )

  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>
  if (!rows) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <p className="shrink-0 border-b bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">
        {t(table.filter ? 'cohorts.tables_preview' : 'cohorts.tables_preview_unfiltered', {
          table: table.name.toUpperCase(),
          count: rows.length,
          max: PREVIEW_ROWS,
        })}
      </p>
      <div className="min-h-0 flex-1 overflow-hidden">
        <DataTable
          data={rows.map((row, i) => ({ i, row }))}
          columns={columns}
          rowKey={(r) => r.i}
          density="compact"
          stickyHeader
          pageSize={100}
          emptyMessage={t('cohorts.tables_preview_empty')}
        />
      </div>
    </div>
  )
}
