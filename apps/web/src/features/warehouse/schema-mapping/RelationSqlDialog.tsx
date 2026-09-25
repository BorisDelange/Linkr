import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Play, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'
import { GeneratedSqlEditor } from '@/components/editor/GeneratedSqlEditor'
import { queryDataSource } from '@/lib/duckdb/engine'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { ClassName } from '@/lib/schema-classes/contracts'
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
  const bodySql = custom ? substituteParams(spec.customSql!.trim().replace(/;\s*$/, ''), mapping.params) : generatedRelationSql(mapping, specKey)

  const run = async (what: 'check' | 'preview') => {
    if (!sourceId || !relation) return
    setBusy(true)
    setError(null)
    try {
      await ensureMounted(sourceId)
      if (what === 'check') {
        if (!bodySql) throw new Error(t('schema_mapping.nothing_to_check'))
        const described = await queryDataSource(sourceId, `DESCRIBE ${bodySql}`)
        setReport(checkContract(cls, described as { column_name: string; column_type: string }[], bodySql))
      } else {
        // The draft's relation, injected here: the database's own mapping would
        // otherwise answer for `linkr_…`.
        setRows(await queryDataSource(sourceId, withClassRelations(`SELECT * FROM ${relation.name} LIMIT 100`, mapping)))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
        <TabsList>
          <TabsTrigger value="sql">SQL</TabsTrigger>
          <TabsTrigger value="check">{t('schema_mapping.tab_check')}</TabsTrigger>
          <TabsTrigger value="preview">{t('schema_mapping.tab_preview')}</TabsTrigger>
        </TabsList>

        <TabsContent value="sql" className="min-h-0 flex-1 rounded-md border">
          <GeneratedSqlEditor
            generatedSql={generated}
            customSql={spec.customSql}
            readOnly={readOnly}
            onCustomSqlChange={(sql) => onChange?.({ ...spec, customSql: sql, sqlColumns: sql ? spec.sqlColumns : undefined })}
          />
        </TabsContent>

        <TabsContent value="check" className="min-h-0 flex-1 space-y-3 overflow-auto">
          {previewSources.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('schema_mapping.no_database')}</p>
          ) : (
            sourcePicker
          )}
          {error && tab === 'check' && <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>}
          {report && (
            <ContractReportView
              report={report}
              canRecord={custom && !readOnly}
              onRecord={() => onChange?.({ ...spec, sqlColumns: report.filled })}
            />
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

function ContractReportView({ report, canRecord, onRecord }: { report: ContractReport; canRecord: boolean; onRecord: () => void }) {
  const { t } = useTranslation()
  const ok = report.missingRequired.length === 0 && report.typeMismatches.length === 0
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle2 size={14} className="text-green-600" /> : <XCircle size={14} className="text-destructive" />}
        <span className="font-medium">{ok ? t('schema_mapping.check_ok') : t('schema_mapping.check_failed')}</span>
      </div>
      <Line label={t('schema_mapping.check_filled')} items={report.filled} />
      {report.missingRequired.length > 0 && <Line label={t('schema_mapping.check_missing')} items={report.missingRequired} tone="error" />}
      {report.typeMismatches.length > 0 && (
        <Line
          label={t('schema_mapping.check_types')}
          items={report.typeMismatches.map((m) => `${m.column}: ${m.type} (${t(`schema_mapping.kind_${m.expected}`)})`)}
          tone="error"
        />
      )}
      {report.unknown.length > 0 && <Line label={t('schema_mapping.check_unknown')} items={report.unknown} tone="warn" />}
      {report.globalWindow && (
        <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t('schema_mapping.check_global_window')}
        </p>
      )}
      {canRecord && (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRecord}>
          {t('schema_mapping.check_record')}
        </Button>
      )}
    </div>
  )
}

function Line({ label, items, tone }: { label: string; items: string[]; tone?: 'error' | 'warn' }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-muted-foreground">{label}</span>
      {items.map((i) => (
        <Badge
          key={i}
          variant="outline"
          className={tone === 'error' ? 'border-destructive/50 text-destructive font-mono' : tone === 'warn' ? 'border-amber-400/50 text-amber-600 dark:text-amber-400 font-mono' : 'font-mono'}
        >
          {i}
        </Badge>
      ))}
    </div>
  )
}
