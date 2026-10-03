import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Code, Table2, Trash2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { parseDdl, indexTables, resolveTableRef } from '@/lib/ddl-parse'
import { cn } from '@/lib/utils'
import type { ClassName } from '@/lib/schema-classes/contracts'
import { classRelations } from '@/lib/schema-classes/relations'
import { specAt, withSpec } from '@/lib/schema-classes/spec'
import type {
  DrugSpec,
  EventSpec,
  PatientSpec,
  RelationSpec,
  RelationTable,
  SchemaMapping,
} from '@/types/schema-mapping'
import { RelationEditor } from './RelationEditor'
import { DraftInput } from './draft-input'
import { CLASS_TONES } from './class-tones'
import { RelationSqlDialog, type PreviewSource } from './RelationSqlDialog'
import { indexSourceSchema, type SourceSchemaTable } from './source-schema'

type TabId = 'all' | 'patient' | 'stays' | 'notes' | 'concepts' | 'events' | 'drugs'

export interface MappingEditorProps {
  mapping: SchemaMapping
  onChange?: (mapping: SchemaMapping) => void
  readOnly?: boolean
  /** Columns of a source table; defaults to the mapping's DDL. */
  columnsOf?: (table: RelationTable) => string[] | undefined
  /** The tables a database actually has, when the mapping is a database's: they
   *  replace the DDL's in the suggestions, which then fill only the columns of
   *  a table the database lacks. Null or absent: the DDL alone. */
  sourceSchema?: readonly SourceSchemaTable[] | null
  previewSources?: PreviewSource[]
  /** Per relation (by spec key): a badge or actions in its header — the
   *  database override layer uses it for "Overridden" / "Revert". */
  relationExtra?: (specKey: string) => ReactNode
  /** Saves a relation's SQL at once, outside edit mode: the SQL dialog stays
   *  editable whenever the user may write, rather than showing a locked editor. */
  persist?: (mapping: SchemaMapping) => void
  /** Actions on the right of the section tabs (a database's Edit / Save). */
  toolbar?: ReactNode
}

/** Blocks two by two from xl up; side by side they share a height. */
const BLOCK_GRID = 'grid grid-cols-1 gap-4 xl:grid-cols-2'

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
export function MappingEditor({ mapping, onChange, readOnly, columnsOf, sourceSchema, previewSources = [], relationExtra, persist, toolbar }: MappingEditorProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<TabId>('all')
  const [sqlFor, setSqlFor] = useState<string | null>(null)

  const ddlColumns = useMemo(() => {
    const index = mapping.ddl ? indexTables(parseDdl(mapping.ddl)) : null
    return (ref: RelationTable) =>
      index ? resolveTableRef(index.byQualified, index.byBare, ref)?.columns.map((c) => c.name) : undefined
  }, [mapping.ddl])
  const live = useMemo(() => (sourceSchema?.length ? indexSourceSchema(sourceSchema) : null), [sourceSchema])
  const colsOf = useMemo(
    () => columnsOf ?? (live ? (ref: RelationTable) => live.columnsOf(ref) ?? ddlColumns(ref) : ddlColumns),
    [columnsOf, live, ddlColumns],
  )
  // The source's tables with their schema, from the DDL and the tables the
  // preset lists — what the table and schema fields suggest.
  const ddlTables = useMemo(() => {
    const out = new Map<string, RelationTable>()
    const add = (schema: string | undefined, table: string) => out.set(`${schema ?? ''}.${table}`.toLowerCase(), { schema, table, alias: '' })
    if (mapping.ddl) for (const t of parseDdl(mapping.ddl)) add(t.schema, t.bareName)
    for (const name of mapping.knownTables ?? []) {
      const dot = name.lastIndexOf('.')
      add(dot > 0 ? name.slice(0, dot) : undefined, dot > 0 ? name.slice(dot + 1) : name)
    }
    return [...out.values()]
  }, [mapping.ddl, mapping.knownTables])
  const sourceTables = live?.tables ?? ddlTables
  const relationNames = useMemo(() => new Map(classRelations(mapping).map((r) => [r.specKey, r.name])), [mapping])

  const setSpec = (specKey: string, spec: RelationSpec | undefined) => onChange?.(withSpec(mapping, specKey, spec))

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
      sourceTables={sourceTables}
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
      !readOnly && key !== 'patient' ? (
        <RemoveRelationButton name={title} className="ml-auto" onConfirm={() => setSpec(key, undefined)} />
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
      {!readOnly && (
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
      {!readOnly && (
        <RemoveRelationButton name={spec.label} onConfirm={() => setSpec(`${list}.${spec.label}`, undefined)} />
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
    <>
      {(mapping[key] ?? []).length === 0 && <p className="col-span-full text-xs text-muted-foreground">{t('schema_mapping.none_yet')}</p>}
      {(mapping[key] ?? []).map((spec) =>
        editorFor(`${key}.${spec.label}`, key === 'events' ? 'event' : 'drug', spec, spec.label, eventHeader(key, spec), eventOptions(key, spec)),
      )}
    </>
  )

  const patientBlocks = () => (
    <>
      {singleton('patient', t('schema_mapping.class_patient'), (spec) => (
        <GenderValues
          spec={spec as PatientSpec}
          readOnly={readOnly}
          onChange={(genderValues) => setSpec('patient', { ...spec, genderValues } as PatientSpec)}
        />
      ))}
    </>
  )
  const stayBlocks = () => (
    <>
      {singleton('visit', t('schema_mapping.class_visit'))}
      {singleton('visitDetail', t('schema_mapping.class_visit_detail'))}
    </>
  )
  const noteBlocks = () => (
    <>
      {singleton('note', t('schema_mapping.class_note'))}
    </>
  )
  const conceptBlocks = () => (
    <>
      {concepts.length === 0 && <p className="col-span-full text-xs text-muted-foreground">{t('schema_mapping.none_yet')}</p>}
      {concepts.map((spec, i) =>
        editorFor(
          `concepts.${spec.key}`,
          'concept',
          spec,
          <span>
            {spec.key}
            {i === 0 && <span className="ml-1 text-[10px] text-muted-foreground">({t('schema_mapping.default_dictionary')})</span>}
          </span>,
          !readOnly ? (
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
              <RemoveRelationButton name={spec.key} onConfirm={() => setSpec(`concepts.${spec.key}`, undefined)} />
            </div>
          ) : undefined,
        ),
      )}
    </>
  )

  const addConcept = () => {
    const taken = new Set(concepts.map((c) => c.key))
    let key = `dict_${concepts.length + 1}`
    for (let n = concepts.length + 2; taken.has(key); n++) key = `dict_${n}`
    onChange?.({ ...mapping, concepts: [...concepts, { key, from: { table: '', alias: 'd' }, fields: {} }] })
  }
  const addToList = (key: 'events' | 'drugs') => {
    const n = (mapping[key]?.length ?? 0) + 1
    const base: EventSpec = { label: listLabel(key, n), from: { table: '', alias: 'e' }, fields: {} }
    const item = key === 'drugs' ? ({ ...base, drugKind: 'administration' } as DrugSpec) : base
    onChange?.({ ...mapping, [key]: [...(mapping[key] ?? []), item] })
  }

  type Section = {
    id: Exclude<TabId, 'all'>
    label: string
    tone: ClassName
    blocks: () => ReactNode
    add?: { label: string; run: () => void }
  }
  const SECTIONS: Section[] = [
    { id: 'patient', label: t('settings.schema_map_tab_patient'), tone: 'patient', blocks: patientBlocks },
    { id: 'stays', label: t('settings.schema_map_tab_stay'), tone: 'visit', blocks: stayBlocks },
    { id: 'notes', label: t('settings.schema_map_tab_notes'), tone: 'note', blocks: noteBlocks },
    { id: 'concepts', label: t('settings.schema_map_tab_concepts'), tone: 'concept', blocks: conceptBlocks, add: { label: t('schema_mapping.add_concept'), run: addConcept } },
    { id: 'events', label: t('settings.schema_map_tab_events'), tone: 'event', blocks: () => list('events'), add: { label: t('schema_mapping.add_event'), run: () => addToList('events') } },
    { id: 'drugs', label: t('schema_mapping.tab_drugs'), tone: 'drug', blocks: () => list('drugs'), add: { label: t('schema_mapping.add_drug'), run: () => addToList('drugs') } },
  ]
  const dot = (tone: ClassName) => <span className={cn('size-2 shrink-0 rounded-full', CLASS_TONES[tone].dot)} />
  const addButton = (sec: Section) =>
    sec.add && !readOnly ? (
      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={sec.add.run}>
        <Plus size={12} />
        {sec.add.label}
      </Button>
    ) : null

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
            <TabsTrigger value="all">{t('schema_mapping.tab_all')}</TabsTrigger>
            {SECTIONS.map((sec) => (
              <TabsTrigger key={sec.id} value={sec.id}>
                {dot(sec.tone)}
                {sec.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex flex-1 items-center justify-end gap-2">{toolbar}</div>
        </div>

        <TabsContent value="all" className="mt-4 space-y-6">
          {SECTIONS.map((sec) => (
            <section key={sec.id} className="space-y-2">
              <div className="flex min-h-7 items-center gap-1.5">
                {dot(sec.tone)}
                <SectionLabel>{sec.label}</SectionLabel>
                <div className="flex-1" />
                {/* Lifted, not spaced: more room between the button and the blocks
                    without pushing the blocks away from the title. */}
                <div className="-translate-y-1">{addButton(sec)}</div>
              </div>
              <div className={BLOCK_GRID}>{sec.blocks()}</div>
            </section>
          ))}
        </TabsContent>

        {SECTIONS.map((sec) => (
          <TabsContent key={sec.id} value={sec.id} className={cn('mt-4', BLOCK_GRID)}>
            {sec.add && !readOnly && <div className="col-span-full flex justify-end">{addButton(sec)}</div>}
            {sec.blocks()}
          </TabsContent>
        ))}

      </Tabs>

      {sqlFor && sqlSpec && sqlCls && (
        <RelationSqlDialog
          open
          onOpenChange={(open) => !open && setSqlFor(null)}
          cls={sqlCls}
          specKey={sqlFor}
          spec={sqlSpec}
          mapping={mapping}
          readOnly={readOnly && !persist}
          onChange={(s) => (readOnly ? persist?.(withSpec(mapping, sqlFor, s)) : setSpec(sqlFor, s))}
          previewSources={previewSources}
        />
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
              <DraftInput value={gv[k] ?? ''} onCommit={(v) => set(k, v)} className="h-7 font-mono text-xs" />
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
    <div className="flex h-full flex-col justify-center rounded-md border border-dashed px-3 py-4 text-center">
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

/** Removes a relation block, after a confirmation: the block may hold a whole
 *  hand-written query. */
function RemoveRelationButton({ name, onConfirm, className }: { name: string; onConfirm: () => void; className?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* size-6, like the header's SQL button and label input: taller and the
          trash would stretch the block header when edit mode adds it. */}
      <Button variant="ghost" size="icon-sm" className={cn('size-6', className)} onClick={() => setOpen(true)} aria-label={t('common.delete')}>
        <Trash2 size={12} />
      </Button>
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        title={t('schema_mapping.remove_title')}
        description={t('schema_mapping.remove_description', { name })}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => {
          onConfirm()
          setOpen(false)
        }}
      >
        {null}
      </DialogShell>
    </>
  )
}
