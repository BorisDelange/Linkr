import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, Plus, X, FunctionSquare, Columns3, Quote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { RequiredMark } from '@/components/ui/required-mark'
import { SectionLabel } from '@/components/ui/section-label'
import { CustomSqlDot } from '@/components/ui/custom-sql-dot'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { cn } from '@/lib/utils'
import { CLASS_CONTRACTS, type ClassName } from '@/lib/schema-classes/contracts'
import { generatedRelationSql } from '@/lib/schema-classes/relations'
import { fieldRef, withSpec } from '@/lib/schema-classes/spec'
import type { FieldSpec, RelationSpec, RelationTable, SchemaMapping } from '@/types/schema-mapping'
import { CLASS_TONES } from './class-tones'
import { formEditable, FORM_ALIAS } from './form-editable'
import { DraftInput, DraftTextarea } from './draft-input'

/** Columns derived by the generator when left unmapped — worth a hint. */
const DERIVED_HINTS: Record<string, string> = {
  birth_year: 'schema_mapping.hint_birth_year',
  gender: 'schema_mapping.hint_gender',
  concept_name: 'schema_mapping.hint_concept_name',
  drug_kind: 'schema_mapping.hint_drug_kind',
}

export interface RelationEditorProps {
  cls: ClassName
  specKey: string
  spec: RelationSpec
  /** The whole mapping: parameters, dictionaries, and the generated SQL to
   *  compare before and after an edit. */
  mapping: SchemaMapping
  readOnly?: boolean
  onChange?: (spec: RelationSpec) => void
  /** Columns of a source table (from the DDL, or the bound database). */
  columnsOf: (table: RelationTable) => string[] | undefined
  tableNames: string[]
  onOpenSql: () => void
  /** Rendered in the header, after the title: label input, badges… */
  headerExtra?: ReactNode
  /** Rendered under the fields: gender values, dictionary… */
  children?: ReactNode
  title: ReactNode
  relationName?: string
}

/**
 * One class relation, from the form or from SQL (plan §3-4). The form maps one
 * table: its columns onto the contract, constants, a filter. The SQL button
 * opens the relation's SQL, where everything else is written. With custom SQL
 * set, a form edit that changes the generated SQL asks before discarding it.
 */
export function RelationEditor({
  cls,
  specKey,
  spec,
  mapping,
  readOnly,
  onChange,
  columnsOf,
  tableNames,
  onOpenSql,
  headerExtra,
  children,
  title,
  relationName,
}: RelationEditorProps) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<RelationSpec | null>(null)
  const custom = !!spec.customSql?.trim()
  // A join or an expression (a v1 conversion, say) stays as it is and is shown
  // read-only; the table, the filter and the plain columns remain editable.
  const advanced = !custom && !formEditable(spec)
  const editable = !readOnly && !custom

  const change = (next: RelationSpec) => {
    if (!onChange) return
    if (custom) {
      const before = generatedRelationSql(withSpec(mapping, specKey, spec), specKey)
      const after = generatedRelationSql(withSpec(mapping, specKey, next), specKey)
      if (before !== after) {
        setPending(next)
        return
      }
    }
    onChange(next)
  }

  const from = spec.from ?? { table: '', alias: FORM_ALIAS }
  const alias = from.alias || FORM_ALIAS
  // One datalist per block, referenced by every field: a copy per field put
  // thousands of <option>s in the DOM once all blocks show.
  const columns = from.table ? (columnsOf(from) ?? []) : []
  const columnListId = useId()
  const tableListId = useId()
  const contract = CLASS_CONTRACTS[cls]
  const extras = cls === 'concept' ? Object.keys(spec.fields ?? {}).filter((k) => k.startsWith('extra_')) : []

  const setField = (name: string, value: FieldSpec | undefined) => {
    const fields = { ...(spec.fields ?? {}) }
    if (value === undefined) delete fields[name]
    else fields[name] = value
    change({ ...spec, from: spec.from ?? from, fields })
  }

  const fieldRows = (rowReadOnly: boolean) => (
    <div className="space-y-1">
      {contract.map((col) => (
        <FieldRow
          key={col.name}
          name={col.name}
          required={col.required}
          hint={DERIVED_HINTS[col.name] ? t(DERIVED_HINTS[col.name]) : undefined}
          value={spec.fields?.[col.name]}
          alias={alias}
          columnList={columns.length ? columnListId : undefined}
          readOnly={rowReadOnly}
          onChange={(v) => setField(col.name, v)}
        />
      ))}
      {extras.map((name) => (
        <FieldRow
          key={name}
          name={name}
          value={spec.fields?.[name]}
          alias={alias}
          columnList={columns.length ? columnListId : undefined}
          readOnly={rowReadOnly}
          onChange={(v) => setField(name, v)}
          onRemove={rowReadOnly ? undefined : () => setField(name, undefined)}
        />
      ))}
      {cls === 'concept' && !rowReadOnly && <AddExtraField onAdd={(name) => setField(`extra_${name}`, '')} taken={extras} />}
    </div>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border bg-card">
      <div className={cn('flex items-center gap-2 border-b px-3 py-2', CLASS_TONES[cls].header)}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Baseline, not centre: the title and the smaller relation name share a line. */}
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-xs font-medium">{title}</span>
            {relationName && <code className="truncate text-[10px] text-muted-foreground">{relationName}</code>}
          </span>
          {custom && <CustomSqlDot />}
          {headerExtra}
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs" onClick={onOpenSql}>
          <Code size={12} />
          SQL
        </Button>
      </div>

      <div className="space-y-3 px-3 py-2">
        {editable && (
          <>
            <datalist id={columnListId}>
              {columns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <datalist id={tableListId}>
              {tableNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}

        {custom && (
          <>
            <p className="text-xs text-muted-foreground">{t('schema_mapping.defined_in_sql')}</p>
            <div className="flex flex-wrap gap-1">
              {(spec.sqlColumns ?? []).map((c) => (
                <Badge key={c} variant="secondary" className="font-mono">{c}</Badge>
              ))}
            </div>
          </>
        )}

        {!custom && (
          <>
            <TableRow
              label={t('schema_mapping.table')}
              table={from}
              tableList={tableNames.length ? tableListId : undefined}
              readOnly={!editable}
              onChange={(next) => change({ ...spec, from: { ...next, alias } })}
            />

            {advanced && (spec.joins?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <AdvancedSummary spec={spec} />
                {!readOnly && <p className="text-[10px] text-muted-foreground">{t('schema_mapping.advanced_relation')}</p>}
              </div>
            )}

            {(spec.where || editable) && (
              <div className="space-y-1">
                <SectionLabel>{t('schema_mapping.where')}</SectionLabel>
                {editable ? (
                  <DraftTextarea
                    value={spec.where ?? ''}
                    onCommit={(v) => change({ ...spec, where: v || undefined })}
                    placeholder={t('schema_mapping.where_placeholder', { example: '{{category}}' })}
                    className="min-h-8 font-mono text-xs"
                    rows={1}
                  />
                ) : (
                  <code className="block whitespace-pre-wrap text-xs">{spec.where}</code>
                )}
              </div>
            )}

            <div className="space-y-1">
              <SectionLabel>{t('schema_mapping.fields')}</SectionLabel>
              {fieldRows(!editable)}
            </div>
          </>
        )}

        {children}
      </div>

      <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('schema_mapping.overwrite_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('schema_mapping.overwrite_description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending && onChange) onChange({ ...pending, customSql: null, sqlColumns: undefined })
                setPending(null)
              }}
            >
              {t('schema_mapping.overwrite_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The joins of a relation the form cannot edit: kept as they are, changed in SQL. */
function AdvancedSummary({ spec }: { spec: RelationSpec }) {
  const table = (x: RelationTable) => `${x.schema ? `${x.schema}.` : ''}${x.table} ${x.alias}`
  return (
    <div className="space-y-0.5 rounded bg-muted/50 px-2 py-1.5">
      {(spec.joins ?? []).map((j, i) => (
        <code key={i} className="block text-xs">
          {j.type.toUpperCase()} JOIN {table(j)} ON {(j.on ?? []).map(([l, r]) => `${l} = ${r}`).join(' AND ')}
        </code>
      ))}
    </div>
  )
}

function TableRow({
  label,
  table,
  tableList,
  readOnly,
  onChange,
}: {
  label: string
  table: RelationTable
  tableList?: string
  readOnly?: boolean
  onChange: (t: RelationTable) => void
}) {
  const { t } = useTranslation()
  if (readOnly) {
    return (
      <div className="grid grid-cols-[100px_1fr] items-center gap-2">
        <SectionLabel>{label}</SectionLabel>
        <code className="text-xs">
          {table.schema ? `${table.schema}.` : ''}
          {table.table}
        </code>
      </div>
    )
  }
  const set = (patch: Partial<RelationTable>) => {
    const next = { ...table, ...patch }
    if (!next.schema) delete next.schema
    onChange(next)
  }
  return (
    <div className="grid grid-cols-[100px_1fr] items-center gap-2">
      <SectionLabel>{label}</SectionLabel>
      <div className="grid grid-cols-[1fr_2fr] gap-1">
        <DraftInput value={table.schema ?? ''} onCommit={(v) => set({ schema: v })} placeholder={t('schema_mapping.schema')} className="h-7 font-mono text-xs" />
        <DraftInput value={table.table ?? ''} onCommit={(v) => set({ table: v })} list={tableList} placeholder={t('schema_mapping.table')} className="h-7 font-mono text-xs" />
      </div>
    </div>
  )
}

type FieldMode = 'column' | 'value'

const MODE_ICONS = { column: Columns3, expr: FunctionSquare, value: Quote } as const

function FieldRow({
  name,
  required,
  hint,
  value,
  alias,
  columnList,
  readOnly,
  onChange,
  onRemove,
}: {
  name: string
  required?: boolean
  hint?: string
  value: FieldSpec | undefined
  /** The form's table alias: a column is stored as `alias.column`, shown bare. */
  alias: string
  columnList?: string
  readOnly?: boolean
  onChange: (v: FieldSpec | undefined) => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const kind: keyof typeof MODE_ICONS = value && typeof value === 'object' ? ('expr' in value ? 'expr' : 'value') : 'column'
  const ref = fieldRef(value)
  const text =
    value === undefined
      ? ''
      : typeof value === 'string'
        ? ref && ref.alias.toLowerCase() === alias.toLowerCase() ? ref.column : value
        : 'expr' in value
          ? value.expr
          : value.value == null ? '' : String(value.value)
  const Icon = MODE_ICONS[kind]

  const label = (
    <div className="flex min-w-0 items-center gap-1">
      <code className="truncate text-xs">{name}</code>
      {required && <RequiredMark />}
      {hint && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-[10px] text-muted-foreground">ⓘ</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )

  // An expression, or a column of a joined table: the form keeps it as it is.
  const locked = kind === 'expr' || (kind === 'column' && !!ref && ref.alias.toLowerCase() !== alias.toLowerCase())
  const shown = kind === 'value' ? `'${text}'` : text

  if (readOnly) {
    if (value === undefined) return null
    return (
      <div className="grid grid-cols-[150px_1fr] items-center gap-2">
        {label}
        <code className="flex items-center gap-1 truncate text-xs">
          <Icon size={11} className="shrink-0 text-muted-foreground" />
          {shown}
        </code>
      </div>
    )
  }

  if (locked) {
    return (
      <div className="grid grid-cols-[150px_1fr_auto] items-center gap-1">
        {label}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <code className="flex h-7 items-center gap-1 truncate rounded-md bg-muted/50 px-2 text-xs">
                <Icon size={11} className="shrink-0 text-muted-foreground" />
                {shown}
              </code>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{t('schema_mapping.locked_field')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Button variant="ghost" size="icon-sm" onClick={() => onChange(undefined)} aria-label={t('common.remove')}>
          <X size={10} />
        </Button>
      </div>
    )
  }

  const mode: FieldMode = kind === 'value' ? 'value' : 'column'
  const emit = (m: FieldMode, s: string) => {
    if (!s.trim() && m === 'column') return onChange(undefined)
    if (m === 'column') return onChange(`${alias}.${s.trim()}`)
    const n = Number(s)
    return onChange({ value: s.trim() !== '' && Number.isFinite(n) && String(n) === s.trim() ? n : s })
  }

  return (
    <div className="grid grid-cols-[150px_112px_1fr_auto] items-center gap-1">
      {label}
      <Select value={mode} onValueChange={(m) => emit(m as FieldMode, text)}>
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="column">{t('schema_mapping.mode_column')}</SelectItem>
          <SelectItem value="value">{t('schema_mapping.mode_value')}</SelectItem>
        </SelectContent>
      </Select>
      <DraftInput
        value={text}
        onCommit={(s) => emit(mode, s)}
        list={mode === 'column' ? columnList : undefined}
        placeholder={mode === 'column' ? t('schema_mapping.column_placeholder') : ''}
        className="h-7 font-mono text-xs"
      />
      {onRemove ? (
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={t('common.remove')}>
          <X size={10} />
        </Button>
      ) : (
        <span className="w-6" />
      )}
    </div>
  )
}

function AddExtraField({ onAdd, taken }: { onAdd: (name: string) => void; taken: string[] }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  const valid = !!slug && !taken.includes(`extra_${slug}`)
  return (
    <div className="flex items-center gap-1 pt-1">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('schema_mapping.extra_placeholder')}
        className="h-7 w-48 font-mono text-xs"
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 text-xs"
        disabled={!valid}
        onClick={() => {
          onAdd(slug)
          setName('')
        }}
      >
        <Plus size={10} />
        {t('schema_mapping.add_extra')}
      </Button>
    </div>
  )
}
