import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, Code, Table2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { parseDdl, indexTables, resolveTableRef } from '@/lib/ddl-parse'
import { localized, setLocalized } from '@/lib/localized'
import type { ClassName } from '@/lib/schema-classes/contracts'
import { classRelations } from '@/lib/schema-classes/relations'
import { specAt, withSpec } from '@/lib/schema-classes/spec'
import type {
  DrugSpec,
  EventSpec,
  MappingParam,
  PatientSpec,
  RelationSpec,
  RelationTable,
  SchemaMapping,
} from '@/types/schema-mapping'
import { RelationEditor } from './RelationEditor'
import { RelationSqlDialog, type PreviewSource } from './RelationSqlDialog'

type TabId = 'patient' | 'stays' | 'notes' | 'concepts' | 'events' | 'drugs' | 'params'

export interface MappingEditorProps {
  mapping: SchemaMapping
  onChange?: (mapping: SchemaMapping) => void
  readOnly?: boolean
  /** Columns of a source table; defaults to the mapping's DDL. */
  columnsOf?: (table: RelationTable) => string[] | undefined
  previewSources?: PreviewSource[]
  /** Per relation (by spec key): a badge or actions in its header — the
   *  database override layer uses it for "Overridden" / "Revert". */
  relationExtra?: (specKey: string) => ReactNode
  /** Parameters are edited here unless the caller owns them (database overrides). */
  paramsSlot?: ReactNode
  /** Whether a relation may be removed; an override cannot drop a preset's one. */
  canRemove?: (specKey: string) => boolean
}

const SINGLETONS: Record<'patient' | 'visit' | 'visitDetail' | 'note', ClassName> = {
  patient: 'patient',
  visit: 'visit',
  visitDetail: 'visit_detail',
  note: 'note',
}

/**
 * The schema mapping as class relations (plan §3-8): one editor per relation,
 * grouped by clinical subject, plus the parameters relations read. Used by the
 * schema preset page and, in override mode, by a database's Mapping tab.
 */
export function MappingEditor({ mapping, onChange, readOnly, columnsOf, previewSources = [], relationExtra, paramsSlot, canRemove }: MappingEditorProps) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<TabId>('patient')
  const [sqlFor, setSqlFor] = useState<string | null>(null)

  const ddlColumns = useMemo(() => {
    const index = mapping.ddl ? indexTables(parseDdl(mapping.ddl)) : null
    return (ref: RelationTable) =>
      index ? resolveTableRef(index.byQualified, index.byBare, ref)?.columns.map((c) => c.name) : undefined
  }, [mapping.ddl])
  const colsOf = columnsOf ?? ddlColumns
  const tableNames = useMemo(() => mapping.knownTables ?? [], [mapping.knownTables])
  const relationNames = useMemo(() => new Map(classRelations(mapping).map((r) => [r.specKey, r.name])), [mapping])

  const setSpec = (specKey: string, spec: RelationSpec | undefined) => onChange?.(withSpec(mapping, specKey, spec))
  const removable = (specKey: string) => !readOnly && (canRemove?.(specKey) ?? true)

  const editorFor = (specKey: string, cls: ClassName, spec: RelationSpec, title: ReactNode, extra?: ReactNode, children?: ReactNode) => (
    <RelationEditor
      key={specKey}
      cls={cls}
      specKey={specKey}
      spec={spec}
      mapping={mapping}
      readOnly={readOnly}
      onChange={(s) => setSpec(specKey, s)}
      columnsOf={colsOf}
      tableNames={tableNames}
      onOpenSql={() => setSqlFor(specKey)}
      title={title}
      relationName={relationNames.get(specKey)}
      headerExtra={
        <>
          {extra}
          {relationExtra?.(specKey)}
        </>
      }
    >
      {children}
    </RelationEditor>
  )

  const singleton = (key: keyof typeof SINGLETONS, title: string, children?: (spec: RelationSpec) => ReactNode) => {
    const spec = mapping[key]
    if (!spec) {
      return (
        <EmptyRelation
          title={title}
          readOnly={readOnly}
          onTable={() => setSpec(key, { from: { table: '', alias: key.slice(0, 2) }, fields: {} })}
          onSql={() => {
            setSpec(key, { customSql: 'SELECT\n  \nFROM ' })
            setSqlFor(key)
          }}
        />
      )
    }
    return editorFor(
      key,
      SINGLETONS[key],
      spec,
      title,
      removable(key) && key !== 'patient' ? (
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setSpec(key, undefined)} aria-label={t('common.remove')}>
          <X size={12} />
        </Button>
      ) : undefined,
      children?.(spec),
    )
  }

  const concepts = mapping.concepts ?? []
  const listLabel = (list: 'events' | 'drugs', i: number) => {
    const taken = new Set([...(mapping.events ?? []), ...(mapping.drugs ?? [])].map((e) => e.label))
    let label = t(list === 'events' ? 'schema_mapping.new_event' : 'schema_mapping.new_drug', { n: i })
    for (let n = i; taken.has(label); n++) label = t(list === 'events' ? 'schema_mapping.new_event' : 'schema_mapping.new_drug', { n: n + 1 })
    return label
  }

  const eventHeader = (list: 'events' | 'drugs', spec: EventSpec) => (
    <div className="ml-auto flex items-center gap-1">
      {removable(`${list}.${spec.label}`) && (
        <CommitInput
          value={spec.label}
          onCommit={(label) => {
            if ([...(mapping.events ?? []), ...(mapping.drugs ?? [])].some((x) => x !== spec && x.label === label)) return
            onChange?.({ ...mapping, [list]: (mapping[list] ?? []).map((x) => (x === spec ? { ...spec, label } : x)) })
          }}
          className="h-6 w-40 text-xs"
          label={t('schema_mapping.label')}
        />
      )}
      {removable(`${list}.${spec.label}`) && (
        <Button variant="ghost" size="icon-sm" onClick={() => setSpec(`${list}.${spec.label}`, undefined)} aria-label={t('common.remove')}>
          <X size={12} />
        </Button>
      )}
    </div>
  )

  const eventOptions = (list: 'events' | 'drugs', spec: EventSpec) => (
    <div className="flex flex-wrap items-center gap-3 border-t pt-2">
      <div className="flex items-center gap-2">
        <SectionLabel>{t('schema_mapping.dictionary')}</SectionLabel>
        {readOnly ? (
          <code className="text-xs">{spec.conceptDictionaryKey ?? concepts[0]?.key ?? '—'}</code>
        ) : (
          <Select
            value={spec.conceptDictionaryKey ?? '__default'}
            onValueChange={(v) => setSpec(`${list}.${spec.label}`, { ...spec, conceptDictionaryKey: v === '__default' ? undefined : v } as EventSpec)}
          >
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">{t('schema_mapping.dictionary_default', { key: concepts[0]?.key ?? '—' })}</SelectItem>
              {concepts.map((c) => (
                <SelectItem key={c.key} value={c.key}>{c.key}</SelectItem>
              ))}
              <SelectItem value="none">{t('schema_mapping.dictionary_none')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      {list === 'drugs' && (
        <div className="flex items-center gap-2">
          <SectionLabel>{t('schema_mapping.drug_kind')}</SectionLabel>
          {readOnly ? (
            <code className="text-xs">{(spec as DrugSpec).drugKind}</code>
          ) : (
            <Select
              value={(spec as DrugSpec).drugKind}
              onValueChange={(v) => setSpec(`drugs.${spec.label}`, { ...spec, drugKind: v } as DrugSpec)}
            >
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="administration">{t('schema_mapping.drug_kind_administration')}</SelectItem>
                <SelectItem value="prescription">{t('schema_mapping.drug_kind_prescription')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  )

  const list = (key: 'events' | 'drugs') => (
    <div className="space-y-3">
      {!readOnly && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              const n = (mapping[key]?.length ?? 0) + 1
              const base: EventSpec = { label: listLabel(key, n), from: { table: '', alias: 'e' }, fields: {} }
              const item = key === 'drugs' ? ({ ...base, drugKind: 'administration' } as DrugSpec) : base
              onChange?.({ ...mapping, [key]: [...(mapping[key] ?? []), item] })
            }}
          >
            <Plus size={12} />
            {t(key === 'events' ? 'schema_mapping.add_event' : 'schema_mapping.add_drug')}
          </Button>
        </div>
      )}
      {(mapping[key] ?? []).length === 0 && <p className="text-xs text-muted-foreground">{t('schema_mapping.none_yet')}</p>}
      {(mapping[key] ?? []).map((spec) =>
        editorFor(`${key}.${spec.label}`, key === 'events' ? 'event' : 'drug', spec, spec.label, eventHeader(key, spec), eventOptions(key, spec)),
      )}
    </div>
  )

  const sqlSpec = sqlFor ? specAt(mapping, sqlFor) : undefined
  const sqlCls: ClassName | undefined = sqlFor
    ? sqlFor in SINGLETONS
      ? SINGLETONS[sqlFor as keyof typeof SINGLETONS]
      : sqlFor.startsWith('concepts.') ? 'concept' : sqlFor.startsWith('drugs.') ? 'drug' : 'event'
    : undefined

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <div className="flex items-center">
          <div className="flex-1" />
          <TabsList>
            <TabsTrigger value="patient">{t('settings.schema_map_tab_patient')}</TabsTrigger>
            <TabsTrigger value="stays">{t('settings.schema_map_tab_stay')}</TabsTrigger>
            <TabsTrigger value="notes">{t('settings.schema_map_tab_notes')}</TabsTrigger>
            <TabsTrigger value="concepts">{t('settings.schema_map_tab_concepts')}</TabsTrigger>
            <TabsTrigger value="events">{t('settings.schema_map_tab_events')}</TabsTrigger>
            <TabsTrigger value="drugs">{t('schema_mapping.tab_drugs')}</TabsTrigger>
            <TabsTrigger value="params">{t('schema_mapping.tab_params')}</TabsTrigger>
          </TabsList>
          <div className="flex-1" />
        </div>

        <TabsContent value="patient" className="mt-4">
          {singleton('patient', t('schema_mapping.class_patient'), (spec) => (
            <GenderValues
              spec={spec as PatientSpec}
              readOnly={readOnly}
              onChange={(genderValues) => setSpec('patient', { ...spec, genderValues } as PatientSpec)}
            />
          ))}
        </TabsContent>

        <TabsContent value="stays" className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          {singleton('visit', t('schema_mapping.class_visit'))}
          {singleton('visitDetail', t('schema_mapping.class_visit_detail'))}
        </TabsContent>

        <TabsContent value="notes" className="mt-4">
          {singleton('note', t('schema_mapping.class_note'))}
        </TabsContent>

        <TabsContent value="concepts" className="mt-4 space-y-3">
          {!readOnly && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => {
                  const taken = new Set(concepts.map((c) => c.key))
                  let key = `dict_${concepts.length + 1}`
                  for (let n = concepts.length + 2; taken.has(key); n++) key = `dict_${n}`
                  onChange?.({ ...mapping, concepts: [...concepts, { key, from: { table: '', alias: 'd' }, fields: {} }] })
                }}
              >
                <Plus size={12} />
                {t('schema_mapping.add_concept')}
              </Button>
            </div>
          )}
          {concepts.length === 0 && <p className="text-xs text-muted-foreground">{t('schema_mapping.none_yet')}</p>}
          {concepts.map((spec, i) =>
            editorFor(
              `concepts.${spec.key}`,
              'concept',
              spec,
              <span>
                {spec.key}
                {i === 0 && <span className="ml-1 text-[10px] text-muted-foreground">({t('schema_mapping.default_dictionary')})</span>}
              </span>,
              removable(`concepts.${spec.key}`) ? (
                <div className="ml-auto flex items-center gap-1">
                  <CommitInput
                    value={spec.key}
                    onCommit={(key) => {
                      if (concepts.some((c) => c !== spec && c.key === key)) return
                      onChange?.({ ...mapping, concepts: concepts.map((c) => (c === spec ? { ...spec, key } : c)) })
                    }}
                    className="h-6 w-32 font-mono text-xs"
                    label={t('schema_mapping.key')}
                  />
                  <Button variant="ghost" size="icon-sm" onClick={() => setSpec(`concepts.${spec.key}`, undefined)} aria-label={t('common.remove')}>
                    <X size={12} />
                  </Button>
                </div>
              ) : undefined,
            ),
          )}
        </TabsContent>

        <TabsContent value="events" className="mt-4">{list('events')}</TabsContent>
        <TabsContent value="drugs" className="mt-4">{list('drugs')}</TabsContent>

        <TabsContent value="params" className="mt-4">
          {paramsSlot ?? (
            <ParamsEditor
              params={mapping.params ?? {}}
              readOnly={readOnly}
              lang={i18n.language}
              onChange={(params) => onChange?.({ ...mapping, params: Object.keys(params).length ? params : undefined })}
            />
          )}
        </TabsContent>
      </Tabs>

      {sqlFor && sqlSpec && sqlCls && (
        <RelationSqlDialog
          open
          onOpenChange={(open) => !open && setSqlFor(null)}
          cls={sqlCls}
          specKey={sqlFor}
          spec={sqlSpec}
          mapping={mapping}
          readOnly={readOnly}
          onChange={(s) => setSpec(sqlFor, s)}
          previewSources={previewSources}
        />
      )}
    </div>
  )
}

/**
 * The values relations read as `{{name}}`. A preset declares them with a
 * default; a database overrides the values only (plan §7).
 */
export function ParamsEditor({
  params,
  readOnly,
  lang,
  onChange,
  overrides,
  onOverrideChange,
}: {
  params: Record<string, MappingParam>
  readOnly?: boolean
  lang: string
  onChange?: (params: Record<string, MappingParam>) => void
  /** Database override mode: values per name, edited instead of the defaults. */
  overrides?: Record<string, string>
  onOverrideChange?: (overrides: Record<string, string>) => void
}) {
  const { t } = useTranslation()
  const [newName, setNewName] = useState('')
  const names = Object.keys(params).sort()
  const overrideMode = !!onOverrideChange
  const validNew = /^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) && !(newName in params)

  const set = (name: string, patch: Partial<MappingParam>) => onChange?.({ ...params, [name]: { ...params[name], ...patch } })

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('schema_mapping.params_hint', { example: '{{name}}' })}</p>
      {names.length === 0 && <p className="text-xs text-muted-foreground">{t('schema_mapping.none_yet')}</p>}
      {names.map((name) => {
        const p = params[name]
        const overridden = overrides && name in overrides
        return (
          <div key={name} className="grid grid-cols-[180px_1fr_1fr_auto] items-center gap-2">
            <code className="text-xs">{`{{${name}}}`}</code>
            {overrideMode ? (
              <Input
                value={overrides?.[name] ?? p.default}
                onChange={(e) => {
                  const next = { ...(overrides ?? {}) }
                  if (e.target.value === p.default) delete next[name]
                  else next[name] = e.target.value
                  onOverrideChange?.(next)
                }}
                className={`h-7 font-mono text-xs ${overridden ? 'border-amber-400' : ''}`}
                disabled={readOnly}
              />
            ) : readOnly ? (
              <code className="text-xs">{p.default}</code>
            ) : (
              <Input value={p.default} onChange={(e) => set(name, { default: e.target.value })} className="h-7 font-mono text-xs" />
            )}
            {readOnly || overrideMode ? (
              <span className="truncate text-xs text-muted-foreground">
                {overrideMode && overridden ? t('schema_mapping.param_default', { value: p.default }) : localized(p.label, lang)}
              </span>
            ) : (
              <Input
                value={localized(p.label, lang)}
                onChange={(e) => set(name, { label: setLocalized(p.label, lang, e.target.value) })}
                placeholder={t('schema_mapping.param_label')}
                className="h-7 text-xs"
              />
            )}
            {!readOnly && !overrideMode ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  const next = { ...params }
                  delete next[name]
                  onChange?.(next)
                }}
                aria-label={t('common.remove')}
              >
                <X size={12} />
              </Button>
            ) : (
              <span className="w-6" />
            )}
          </div>
        )
      })}
      {!readOnly && !overrideMode && (
        <div className="flex items-center gap-1 pt-1">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('schema_mapping.param_name')} className="h-7 w-48 font-mono text-xs" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 text-xs"
            disabled={!validNew}
            onClick={() => {
              onChange?.({ ...params, [newName]: { default: '' } })
              setNewName('')
            }}
          >
            <Plus size={10} />
            {t('schema_mapping.add_param')}
          </Button>
        </div>
      )}
    </div>
  )
}

function GenderValues({ spec, readOnly, onChange }: { spec: PatientSpec; readOnly?: boolean; onChange: (g: PatientSpec['genderValues']) => void }) {
  const { t } = useTranslation()
  const gv = spec.genderValues ?? { male: '', female: '' }
  const set = (k: 'male' | 'female' | 'unknown', v: string) => {
    const next = { ...gv, [k]: v || undefined } as NonNullable<PatientSpec['genderValues']>
    onChange(next.male || next.female ? next : undefined)
  }
  return (
    <div className="space-y-1 border-t pt-2">
      <SectionLabel>{t('settings.schema_preset_gender_values')}</SectionLabel>
      <p className="text-[10px] text-muted-foreground">{t('schema_mapping.gender_values_hint')}</p>
      <div className="grid grid-cols-3 gap-2">
        {(['male', 'female', 'unknown'] as const).map((k) => (
          <div key={k} className="space-y-0.5">
            <span className="text-[10px] text-muted-foreground">{t(`schema_mapping.gender_${k}`)}</span>
            {readOnly ? (
              <code className="block text-xs">{gv[k] ?? '—'}</code>
            ) : (
              <Input value={gv[k] ?? ''} onChange={(e) => set(k, e.target.value)} className="h-7 font-mono text-xs" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyRelation({ title, readOnly, onTable, onSql }: { title: string; readOnly?: boolean; onTable: () => void; onSql: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border border-dashed px-3 py-4 text-center">
      <p className="text-xs font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('schema_mapping.not_mapped')}</p>
      {!readOnly && (
        <div className="mt-2 flex justify-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onTable}>
            <Table2 size={12} />
            {t('schema_mapping.map_from_table')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onSql}>
            <Code size={12} />
            {t('schema_mapping.write_sql')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** A text field committed on blur or Enter: renaming a key or a label re-keys
 *  the relation, which must not happen on every keystroke. */
function CommitInput({ value, onCommit, className, label }: { value: string; onCommit: (v: string) => void; className?: string; label: string }) {
  const [draft, setDraft] = useState(value)
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setDraft(value)
  }
  const commit = () => {
    if (draft.trim() && draft.trim() !== value) onCommit(draft.trim())
    else setDraft(value)
  }
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={className}
      aria-label={label}
    />
  )
}
