import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Play, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { queryDataSource } from '@/lib/duckdb/engine'
import { queryErrorMessage } from '@/lib/duckdb/query-error'
import { useDataSourceStore } from '@/stores/data-source-store'
import { CLASS_CONTRACTS, type ClassName } from '@/lib/schema-classes/contracts'
import { SectionLabel } from '@/components/ui/section-label'
import { RequiredMark } from '@/components/ui/required-mark'
import { cn } from '@/lib/utils'
import { classRelations, generatedRelationSql, readableRelationSql, substituteParams } from '@/lib/schema-classes/relations'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { checkContract, type ContractReport } from '@/lib/schema-classes/contract-check'
import type { RelationSpec, SchemaMapping } from '@/types/schema-mapping'

export interface PreviewSource {
  id: string
  label: string
}

interface RelationSqlDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cls: ClassName
  specKey: string
  spec: RelationSpec
  /** The mapping as being edited, with this relation in it. */
  mapping: SchemaMapping
  readOnly?: boolean
  onChange?: (spec: RelationSpec) => void
  /** Databases the relation can be checked and previewed on. A preset has no
   *  data of its own; a database's Mapping tab passes itself. */
  previewSources: PreviewSource[]
}

type Row = Record<string, unknown>

/**
 * A relation's SQL (generated, or edited — the Cohort "Modified" pattern), and,
 * on a database, what it actually returns: the contract check (`DESCRIBE`) and
 * a 100-row preview (plan §6).
 */
export function RelationSqlDialog({ open, onOpenChange, cls, specKey, spec, mapping, readOnly, onChange, previewSources }: RelationSqlDialogProps) {
  const { t } = useTranslation()
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const [tab, setTab] = useState('sql')
  const [sourceId, setSourceId] = useState(previewSources[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ContractReport | null>(null)
  const [rows, setRows] = useState<Row[] | null>(null)

  const generated = useMemo(() => readableRelationSql(mapping, specKey), [mapping, specKey])
  const relation = useMemo(() => classRelations(mapping).find((r) => r.specKey === specKey), [mapping, specKey])
  const custom = !!spec.customSql?.trim()

  /** What the relation's own SQL returns, before the contract projection pads it. */
  const bodyOf = (s: RelationSpec) =>
    s.customSql?.trim() ? substituteParams(s.customSql.trim().replace(/;\s*$/, ''), mapping.params) : generatedRelationSql(mapping, specKey)

  /**
   * `current` is the spec as just saved: a check run right after a save must
   * not write back the spec from before it.
   */
  const run = async (what: 'check' | 'preview', current: RelationSpec = spec) => {
    if (!sourceId || !relation) return
    setBusy(true)
    setError(null)
    try {
      await ensureMounted(sourceId)
      if (what === 'check') {
        const bodySql = bodyOf(current)
        if (!bodySql) throw new Error(t('schema_mapping.nothing_to_check'))
        const described = await queryDataSource(sourceId, `DESCRIBE ${bodySql}`)
        const next = checkContract(cls, described as { column_name: string; column_type: string }[], bodySql)
        setReport(next)
        // Hand-written SQL: what it returns is what the rest of the app reads
        // as filled (age criterion, timeline values…). Recorded here rather
        // than by a button nobody knew to press.
        if (current.customSql?.trim() && !readOnly && JSON.stringify(current.sqlColumns ?? []) !== JSON.stringify(next.filled)) {
          onChange?.({ ...current, sqlColumns: next.filled })
        }
      } else {
        // The draft's relation, injected here: the database's own mapping would
        // otherwise answer for `linkr_…`.
        setRows(await queryDataSource(sourceId, withClassRelations(`SELECT * FROM ${relation.name} LIMIT 100`, mapping)))
      }
    } catch (e) {
      setError(queryErrorMessage(e, t, previewSources.find((p) => p.id === sourceId)?.label ?? sourceId))
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<ConceptColumn<Row>[]>(
    () =>
      Object.keys(rows?.[0] ?? {}).map((key) => ({
        id: key,
        header: key,
        accessor: (r: Row) => {
          const v = r[key]
          return v === null || v === undefined ? null : typeof v === 'number' ? v : String(v)
        },
      })),
    [rows],
  )

  const sourcePicker = previewSources.length > 0 && (
    <div className="flex items-center gap-2">
      <Select value={sourceId} onValueChange={setSourceId}>
        <SelectTrigger className="h-7 w-56 text-xs">
          <SelectValue placeholder={t('schema_mapping.pick_database')} />
        </SelectTrigger>
        <SelectContent>
          {previewSources.map((s) => (
            <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" className="h-7 gap-1 text-xs" disabled={busy || !sourceId} onClick={() => void run(tab === 'check' ? 'check' : 'preview')}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
        {tab === 'check' ? t('schema_mapping.run_check') : t('schema_mapping.run_preview')}
      </Button>
    </div>
  )

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      title={t('schema_mapping.sql_title', { name: relation?.name ?? specKey })}
      description={t('schema_mapping.sql_description', { example: '{{name}}' })}
    >
      <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
        <TabsList className="self-center">
          <TabsTrigger value="sql">SQL</TabsTrigger>
          <TabsTrigger value="check">{t('schema_mapping.tab_check')}</TabsTrigger>
          <TabsTrigger value="preview">{t('schema_mapping.tab_preview')}</TabsTrigger>
        </TabsList>

        <TabsContent value="sql" className="flex min-h-0 flex-1 overflow-hidden rounded-md border">
          <div className="min-w-0 flex-1">
            <GeneratedSqlEditor
              generatedSql={generated}
              customSql={spec.customSql}
              readOnly={readOnly}
              onCustomSqlChange={(sql) => {
                const next = { ...spec, customSql: sql, sqlColumns: sql ? spec.sqlColumns : undefined }
                onChange?.(next)
                if (sql && sourceId) void run('check', next)
              }}
            />
          </div>
          <ContractPanel cls={cls} report={report} />
        </TabsContent>

        <TabsContent value="check" className="min-h-0 flex-1 space-y-3 overflow-auto">
          {previewSources.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('schema_mapping.no_database')}</p>
          ) : (
            sourcePicker
          )}
          {error && tab === 'check' && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
          {report && (
            <ContractReportView cls={cls} report={report} recorded={custom && !readOnly} />
          )}
        </TabsContent>

        <TabsContent value="preview" className="min-h-0 flex-1 space-y-3 overflow-auto">
          {previewSources.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('schema_mapping.no_database')}</p>
          ) : (
            sourcePicker
          )}
          {error && tab === 'preview' && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
          {rows && (
            <ConceptDataTable
              data={rows}
              columns={columns}
              rowKey={(r) => rows.indexOf(r)}
              density="compact"
              emptyMessage={t('common.no_results')}
            />
          )}
        </TabsContent>
      </Tabs>
    </DialogShell>
  )
}

/**
 * The columns the relation must return: what to name each `AS …` and what type
 * it should have. After a check, each says whether the SQL fills it. Shown
 * beside the editor and, wider, as the check's own report.
 */
function ContractList({ cls, report, wide }: { cls: ClassName; report: ContractReport | null; wide?: boolean }) {
  const { t } = useTranslation()
  const mismatch = new Map(report?.typeMismatches.map((m) => [m.column, m.type]) ?? [])
  return (
    <ul className={cn('space-y-0.5', wide && 'max-w-xl')}>
      {CLASS_CONTRACTS[cls].map((col) => {
        const status = !report
          ? null
          : mismatch.has(col.name)
            ? 'mismatch'
            : report.filled.includes(col.name)
              ? 'filled'
              : report.missingRequired.includes(col.name)
                ? 'missing'
                : 'empty'
        return (
          <li key={col.name} className="flex items-center gap-1.5 text-xs">
            {status === 'filled' ? (
              <CheckCircle2 size={11} className="shrink-0 text-green-600" />
            ) : status === 'missing' ? (
              <XCircle size={11} className="shrink-0 text-destructive" />
            ) : status === 'mismatch' ? (
              <AlertTriangle size={11} className="shrink-0 text-amber-600" />
            ) : (
              <span className="size-[11px] shrink-0" />
            )}
            <code className={cn('truncate', col.required && 'font-semibold', status === 'empty' && 'text-muted-foreground')}>{col.name}</code>
            {col.required && <RequiredMark />}
            {wide && status && (
              <span className={cn('text-[10px]', status === 'missing' ? 'text-destructive' : status === 'mismatch' ? 'text-amber-600' : 'text-muted-foreground')}>
                {t(`schema_mapping.contract_status_${status}`)}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {mismatch.has(col.name) ? `${mismatch.get(col.name)} ≠ ` : ''}
              {t(`schema_mapping.contract_type_${col.kind}`)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function ContractPanel({ cls, report }: { cls: ClassName; report: ContractReport | null }) {
  const { t } = useTranslation()
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l">
      <div className="border-b px-3 py-1.5">
        <SectionLabel>{t('schema_mapping.contract_title')}</SectionLabel>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{t('schema_mapping.contract_help')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <ContractList cls={cls} report={report} />
      </div>
    </aside>
  )
}

function ContractReportView({ cls, report, recorded }: { cls: ClassName; report: ContractReport; recorded: boolean }) {
  const { t } = useTranslation()
  const ok = report.missingRequired.length === 0 && report.typeMismatches.length === 0
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle2 size={14} className="text-green-600" /> : <XCircle size={14} className="text-destructive" />}
        <span className="font-medium">{ok ? t('schema_mapping.check_ok') : t('schema_mapping.check_failed')}</span>
      </div>
      <ContractList cls={cls} report={report} wide />
      {report.unknown.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground">{t('schema_mapping.check_unknown')}</p>
          <ul className="space-y-0.5">
            {report.unknown.map((c) => (
              <li key={c} className="flex items-center gap-1.5">
                <AlertTriangle size={11} className="shrink-0 text-amber-600" />
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.globalWindow && (
        <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t('schema_mapping.check_global_window')}
        </p>
      )}
      {recorded && <p className="text-muted-foreground">{t('schema_mapping.check_recorded')}</p>}
    </div>
  )
}
