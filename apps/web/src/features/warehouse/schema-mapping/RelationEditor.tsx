import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, Plus, X, FunctionSquare, Columns3, Quote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { withSpec } from '@/lib/schema-classes/spec'
import type { FieldSpec, RelationJoin, RelationSpec, RelationTable, SchemaMapping } from '@/types/schema-mapping'

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
 * One class relation, read either from the visual form or from SQL (plan §3-4).
 * The form edits `from`, `joins`, `where` and `fields`; the Code button opens
 * the SQL. With custom SQL set, a form edit that changes the generated SQL asks
 * before discarding it — a cosmetic edit never does.
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
  const sqlOnly = custom && !spec.from

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

  const aliases = [spec.from, ...(spec.joins ?? [])].filter((x): x is RelationTable => !!x?.alias)
  const suggestions = aliases.flatMap((a) => (columnsOf(a) ?? []).map((c) => `${a.alias}.${c}`))
  const contract = CLASS_CONTRACTS[cls]
  const extras = cls === 'concept' ? Object.keys(spec.fields ?? {}).filter((k) => k.startsWith('extra_')) : []

  const setField = (name: string, value: FieldSpec | undefined) => {
    const fields = { ...(spec.fields ?? {}) }
    if (value === undefined) delete fields[name]
    else fields[name] = value
    change({ ...spec, fields })
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-xs font-medium">{title}</span>
          {relationName && <code className="truncate text-[10px] text-muted-foreground">{relationName}</code>}
          {custom && <CustomSqlDot />}
          {headerExtra}
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs" onClick={onOpenSql}>
          <Code size={12} />
          SQL
        </Button>
      </div>

      <div className="space-y-3 px-3 py-2">
        {custom && (
          <p className="text-xs text-muted-foreground">
            {sqlOnly ? t('schema_mapping.defined_in_sql') : t('schema_mapping.sql_overrides_form')}
          </p>
        )}

        {!sqlOnly && (
          <>
            <TableRow
              label={t('schema_mapping.from')}
              table={spec.from ?? { table: '', alias: '' }}
              tableNames={tableNames}
              readOnly={readOnly}
              onChange={(from) => change({ ...spec, from })}
            />

            {(spec.joins?.length || !readOnly) && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <SectionLabel>{t('schema_mapping.joins')}</SectionLabel>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 gap-0.5 px-1.5 text-[10px]"
                      onClick={() => change({ ...spec, joins: [...(spec.joins ?? []), { type: 'left', table: '', alias: '', on: [['', '']] }] })}
                    >
                      <Plus size={9} />
                      {t('common.add')}
                    </Button>
                  )}
                </div>
                {(spec.joins ?? []).map((join, i) => (
                  <JoinRow
                    key={i}
                    join={join}
                    tableNames={tableNames}
                    suggestions={suggestions}
                    readOnly={readOnly}
                    onChange={(j) => change({ ...spec, joins: (spec.joins ?? []).map((x, k) => (k === i ? j : x)) })}
                    onRemove={() => change({ ...spec, joins: (spec.joins ?? []).filter((_, k) => k !== i) })}
                  />
                ))}
              </div>
            )}

            {(spec.where || !readOnly) && (
              <div className="space-y-1">
                <SectionLabel>{t('schema_mapping.where')}</SectionLabel>
                {readOnly ? (
                  <code className="block whitespace-pre-wrap text-xs">{spec.where}</code>
                ) : (
                  <Textarea
                    value={spec.where ?? ''}
                    onChange={(e) => change({ ...spec, where: e.target.value || undefined })}
                    placeholder={t('schema_mapping.where_placeholder', { example: '{{attr_route}}' })}
                    className="min-h-8 font-mono text-xs"
                    rows={1}
                  />
                )}
              </div>
            )}

            <div className="space-y-1">
              <SectionLabel>{t('schema_mapping.fields')}</SectionLabel>
              <div className="space-y-1">
                {contract.map((col) => (
                  <FieldRow
                    key={col.name}
                    name={col.name}
                    required={col.required}
                    hint={DERIVED_HINTS[col.name] ? t(DERIVED_HINTS[col.name]) : undefined}
                    value={spec.fields?.[col.name]}
                    suggestions={suggestions}
                    readOnly={readOnly}
                    onChange={(v) => setField(col.name, v)}
                  />
                ))}
                {extras.map((name) => (
                  <FieldRow
                    key={name}
                    name={name}
                    value={spec.fields?.[name]}
                    suggestions={suggestions}
                    readOnly={readOnly}
                    onChange={(v) => setField(name, v)}
                    onRemove={readOnly ? undefined : () => setField(name, undefined)}
                  />
                ))}
                {cls === 'concept' && !readOnly && <AddExtraField onAdd={(name) => setField(`extra_${name}`, '')} taken={extras} />}
              </div>
            </div>
          </>
        )}

        {custom && (
          <div className="flex flex-wrap gap-1">
            {(spec.sqlColumns ?? []).map((c) => (
              <Badge key={c} variant="secondary" className="font-mono">{c}</Badge>
            ))}
          </div>
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

function SuggestInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  suggestions?: string[]
  placeholder?: string
  className?: string
}) {
  // A datalist, not a combobox: a mapping may name a column the DDL never
  // listed, and the browser filters the completions as the user types.
  const listId = useId()
  return (
    <>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn('h-7 font-mono text-xs', className)}
        list={suggestions?.length ? listId : undefined}
      />
      {suggestions?.length ? (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </>
  )
}

function TableRow({
  label,
  table,
  tableNames,
  readOnly,
  onChange,
}: {
  label: string
  table: RelationTable
  tableNames: string[]
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
          {table.table} <span className="text-muted-foreground">{table.alias}</span>
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
      <div className="grid grid-cols-[1fr_2fr_70px] gap-1">
        <Input value={table.schema ?? ''} onChange={(e) => set({ schema: e.target.value })} placeholder={t('schema_mapping.schema')} className="h-7 font-mono text-xs" />
        <SuggestInput value={table.table} onChange={(v) => set({ table: v })} suggestions={tableNames} placeholder={t('schema_mapping.table')} />
        <Input value={table.alias} onChange={(e) => set({ alias: e.target.value })} placeholder={t('schema_mapping.alias')} className="h-7 font-mono text-xs" />
      </div>
    </div>
  )
}

function JoinRow({
  join,
  tableNames,
  suggestions,
  readOnly,
  onChange,
  onRemove,
}: {
  join: RelationJoin
  tableNames: string[]
  suggestions: string[]
  readOnly?: boolean
  onChange: (j: RelationJoin) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const on = join.on?.length ? join.on : [['', ''] as [string, string]]
  if (readOnly) {
    return (
      <code className="block text-xs">
        {join.type.toUpperCase()} JOIN {join.schema ? `${join.schema}.` : ''}{join.table} {join.alias} ON{' '}
        {on.map(([l, r]) => `${l} = ${r}`).join(' AND ')}
      </code>
    )
  }
  const setOn = (i: number, side: 0 | 1, v: string) =>
    onChange({ ...join, on: on.map((pair, k) => (k === i ? (side === 0 ? [v, pair[1]] : [pair[0], v]) : pair)) as [string, string][] })
  return (
    <div className="space-y-1 rounded border border-dashed px-2 py-1.5">
      <div className="flex items-center gap-1">
        <Select value={join.type} onValueChange={(v) => onChange({ ...join, type: v as RelationJoin['type'] })}>
          <SelectTrigger className="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">LEFT</SelectItem>
            <SelectItem value="inner">INNER</SelectItem>
          </SelectContent>
        </Select>
        <div className="grid flex-1 grid-cols-[1fr_2fr_70px] gap-1">
          <Input value={join.schema ?? ''} onChange={(e) => onChange({ ...join, schema: e.target.value || undefined })} placeholder={t('schema_mapping.schema')} className="h-7 font-mono text-xs" />
          <SuggestInput value={join.table} onChange={(v) => onChange({ ...join, table: v })} suggestions={tableNames} placeholder={t('schema_mapping.table')} />
          <Input value={join.alias} onChange={(e) => onChange({ ...join, alias: e.target.value })} placeholder={t('schema_mapping.alias')} className="h-7 font-mono text-xs" />
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={t('common.remove')}>
          <X size={12} />
        </Button>
      </div>
      {on.map(([l, r], i) => (
        <div key={i} className="flex items-center gap-1 pl-[100px]">
          <span className="text-[10px] text-muted-foreground">{i === 0 ? 'ON' : 'AND'}</span>
          <SuggestInput value={l} onChange={(v) => setOn(i, 0, v)} suggestions={suggestions} placeholder="a.column" />
          <span className="text-xs text-muted-foreground">=</span>
          <SuggestInput value={r} onChange={(v) => setOn(i, 1, v)} suggestions={suggestions} placeholder="b.column" />
          {on.length > 1 ? (
            <Button variant="ghost" size="icon-sm" onClick={() => onChange({ ...join, on: on.filter((_, k) => k !== i) })} aria-label={t('common.remove')}>
              <X size={10} />
            </Button>
          ) : (
            <Button variant="ghost" size="icon-sm" onClick={() => onChange({ ...join, on: [...on, ['', '']] })} aria-label={t('common.add')}>
              <Plus size={10} />
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

type FieldMode = 'column' | 'expr' | 'value'

const modeOf = (f: FieldSpec | undefined): FieldMode =>
  f && typeof f === 'object' ? ('expr' in f ? 'expr' : 'value') : 'column'

const textOf = (f: FieldSpec | undefined): string =>
  f === undefined ? '' : typeof f === 'string' ? f : 'expr' in f ? f.expr : f.value === null ? '' : String(f.value)

const MODE_ICONS: Record<FieldMode, typeof Columns3> = { column: Columns3, expr: FunctionSquare, value: Quote }

function FieldRow({
  name,
  required,
  hint,
  value,
  suggestions,
  readOnly,
  onChange,
  onRemove,
}: {
  name: string
  required?: boolean
  hint?: string
  value: FieldSpec | undefined
  suggestions: string[]
  readOnly?: boolean
  onChange: (v: FieldSpec | undefined) => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const mode = modeOf(value)
  const text = textOf(value)
  const Icon = MODE_ICONS[mode]

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

  if (readOnly) {
    if (value === undefined) return null
    return (
      <div className="grid grid-cols-[160px_1fr] items-center gap-2">
        {label}
        <code className="flex items-center gap-1 truncate text-xs">
          <Icon size={11} className="shrink-0 text-muted-foreground" />
          {text}
        </code>
      </div>
    )
  }

  const emit = (m: FieldMode, s: string) => {
    if (!s.trim() && m !== 'value') return onChange(undefined)
    if (m === 'column') return onChange(s)
    if (m === 'expr') return onChange({ expr: s })
    const n = Number(s)
    return onChange({ value: s.trim() !== '' && Number.isFinite(n) && String(n) === s.trim() ? n : s })
  }

  return (
    <div className="grid grid-cols-[160px_80px_1fr_auto] items-center gap-1">
      {label}
      <Select value={mode} onValueChange={(m) => emit(m as FieldMode, text)}>
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="column">{t('schema_mapping.mode_column')}</SelectItem>
          <SelectItem value="expr">{t('schema_mapping.mode_expr')}</SelectItem>
          <SelectItem value="value">{t('schema_mapping.mode_value')}</SelectItem>
        </SelectContent>
      </Select>
      <SuggestInput
        value={text}
        onChange={(s) => emit(mode, s)}
        suggestions={mode === 'column' ? suggestions : undefined}
        placeholder={mode === 'column' ? 'alias.column' : mode === 'expr' ? t('schema_mapping.expr_placeholder') : ''}
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
