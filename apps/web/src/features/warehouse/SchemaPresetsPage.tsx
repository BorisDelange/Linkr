import { useState, useEffect, useCallback, Suspense, lazy, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router'
import {
  Database,
  Copy,
  Trash2,
  Plus,
  X,
  Check,
  Download,
  Upload,
  Code,
  ArrowLeft,
  RotateCcw,
  Pencil,
  MoreHorizontal,
  Search,
  ChevronDown,
  ChevronRight,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { timestamp } from '@/lib/entity-io'
import { BUILTIN_PRESET_IDS, SCHEMA_PRESETS } from '@/lib/schema-presets'
import { getStorage } from '@/lib/storage'
import { SchemaERD } from './SchemaERD'
import { DdlERD } from './DdlERD'

const LazyCodeEditor = lazy(() =>
  import('@/components/editor/CodeEditor').then((m) => ({ default: m.CodeEditor }))
)
import type {
  SchemaMapping,
  ConceptDictionary,
  EventTable,
  CustomSchemaPreset,
} from '@/types/schema-mapping'
import type * as Monaco from 'monaco-editor'

// ---------------------------------------------------------------------------
// DDL Table of Contents — sidebar with collapsible sections
// ---------------------------------------------------------------------------

interface DdlTocEntry { label: string; line: number }
interface DdlTocSection { key: string; title: string; entries: DdlTocEntry[] }

function parseDdlToc(ddl: string): DdlTocSection[] {
  const tables: DdlTocEntry[] = []
  const pks: DdlTocEntry[] = []
  const fks: DdlTocEntry[] = []
  const indexes: DdlTocEntry[] = []

  const lines = ddl.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // CREATE TABLE
    const tblMatch = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?(?:"?(\w+)"?)/i.exec(line)
    if (tblMatch?.[1]) { tables.push({ label: tblMatch[1], line: i + 1 }); continue }
    // ALTER TABLE ... PRIMARY KEY
    const pkMatch = /ALTER\s+TABLE\s+(?:"?\w+"?\.)?(?:"?(\w+)"?)\s+ADD\s+CONSTRAINT\s+\w+\s+PRIMARY\s+KEY/i.exec(line)
    if (pkMatch?.[1]) { pks.push({ label: pkMatch[1], line: i + 1 }); continue }
    // ALTER TABLE ... FOREIGN KEY
    const fkMatch = /ALTER\s+TABLE\s+(?:"?\w+"?\.)?(?:"?(\w+)"?)\s+ADD\s+CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY/i.exec(line)
    if (fkMatch) { fks.push({ label: `${fkMatch[1]}.${fkMatch[2]}`, line: i + 1 }); continue }
    // CREATE INDEX
    const idxMatch = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?)/i.exec(line)
    if (idxMatch?.[1]) { indexes.push({ label: idxMatch[1], line: i + 1 }); continue }
  }

  const sections: DdlTocSection[] = []
  if (tables.length) sections.push({ key: 'tables', title: 'Tables', entries: tables })
  if (pks.length) sections.push({ key: 'pks', title: 'Primary Keys', entries: pks })
  if (fks.length) sections.push({ key: 'fks', title: 'Foreign Keys', entries: fks })
  if (indexes.length) sections.push({ key: 'indexes', title: 'Indexes', entries: indexes })
  return sections
}

function DdlTableOfContents({
  ddl,
  editorRef,
}: {
  ddl: string
  editorRef: React.RefObject<Monaco.editor.IStandaloneCodeEditor | null>
}) {
  const [filter, setFilter] = useState('')
  const sections = useMemo(() => parseDdlToc(ddl), [ddl])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const lower = filter.toLowerCase()

  const toggle = (key: string) =>
    setCollapsed((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  const scrollTo = (line: number) => {
    const editor = editorRef.current
    if (!editor) return
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  }

  return (
    <div className="w-[200px] shrink-0 border-r flex flex-col overflow-hidden bg-muted/30">
      <div className="px-2 py-2 border-b shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="h-7 text-xs pl-7"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sections.map((section) => {
          const filtered = lower
            ? section.entries.filter((e) => e.label.toLowerCase().includes(lower))
            : section.entries
          if (lower && filtered.length === 0) return null
          const isCollapsed = collapsed.has(section.key) && !lower

          return (
            <div key={section.key}>
              <button
                type="button"
                className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-muted/50 border-b"
                onClick={() => toggle(section.key)}
              >
                {isCollapsed
                  ? <ChevronRight size={11} className="shrink-0 text-muted-foreground" />
                  : <ChevronDown size={11} className="shrink-0 text-muted-foreground" />}
                <span className="text-[10px] font-semibold text-muted-foreground uppercase flex-1">{section.title}</span>
                <span className="text-[10px] text-muted-foreground">{filtered.length}</span>
              </button>
              {!isCollapsed && (
                <div className="py-0.5">
                  {filtered.map((entry) => (
                    <button
                      key={entry.line}
                      type="button"
                      className="w-full text-left px-3 py-1 text-xs font-mono hover:bg-muted/60 transition-colors truncate"
                      onClick={() => scrollTo(entry.line)}
                      title={`Line ${entry.line}`}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {sections.every((s) => lower && s.entries.every((e) => !e.label.toLowerCase().includes(lower))) && (
          <p className="px-3 py-3 text-xs text-muted-foreground">No results</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail sub-components (read-only view)
// ---------------------------------------------------------------------------

function DetailRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-xs text-muted-foreground min-w-[120px] shrink-0">{label}</span>
      <code className="text-xs font-mono text-foreground">{value}</code>
    </div>
  )
}

function TableSection({
  title,
  mapping,
}: {
  title: string
  mapping: Record<string, string | undefined> | undefined
}) {
  if (!mapping) return null
  const entries = Object.entries(mapping).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return null

  return (
    <div>
      <h5 className="text-xs font-medium text-foreground mb-1">{title}</h5>
      <div className="rounded-md border bg-muted/30 px-3 py-2">
        {entries.map(([key, val]) => (
          <DetailRow key={key} label={formatColumnKey(key)} value={val} />
        ))}
      </div>
    </div>
  )
}

function formatColumnKey(key: string): string {
  return key
    .replace(/Column$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

function ConceptDictionarySection({ dict }: { dict: ConceptDictionary }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-xs font-medium text-foreground">{dict.key}</span>
      <div className="mt-1">
        <DetailRow label="Table" value={dict.table} />
        <DetailRow label="ID column" value={dict.idColumn} />
        <DetailRow label="Name column" value={dict.nameColumn} />
        {dict.codeColumn && <DetailRow label="Code column" value={dict.codeColumn} />}
        {(dict.terminologyIdColumn ?? dict.vocabularyColumn) && (
          <DetailRow label="Terminology ID" value={dict.terminologyIdColumn ?? dict.vocabularyColumn} />
        )}
        {dict.terminologyNameColumn && <DetailRow label="Terminology name" value={dict.terminologyNameColumn} />}
        {dict.categoryColumn && <DetailRow label="Category column" value={dict.categoryColumn} />}
        {dict.subcategoryColumn && <DetailRow label="Subcategory column" value={dict.subcategoryColumn} />}
        {dict.extraColumns && Object.entries(dict.extraColumns).map(([k, v]) => (
          <DetailRow key={k} label={`Extra: ${k}`} value={v} />
        ))}
      </div>
    </div>
  )
}

function EventTableSection({ label, et }: { label: string; et: EventTable }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <div className="mt-1">
        <DetailRow label="Table" value={et.table} />
        <DetailRow label="Concept ID" value={et.conceptIdColumn} />
        {et.sourceConceptIdColumn && (
          <DetailRow label="Source concept ID" value={et.sourceConceptIdColumn} />
        )}
        {et.conceptVocabularyColumn && (
          <DetailRow label="Vocabulary column" value={et.conceptVocabularyColumn} />
        )}
        {et.conceptCodeColumn && (
          <DetailRow label="Code column" value={et.conceptCodeColumn} />
        )}
        {et.valueColumn && <DetailRow label="Value (numeric)" value={et.valueColumn} />}
        {et.valueStringColumn && <DetailRow label="Value (string)" value={et.valueStringColumn} />}
        {et.patientIdColumn && <DetailRow label="Patient ID" value={et.patientIdColumn} />}
        {et.dateColumn && <DetailRow label="Date column" value={et.dateColumn} />}
        {et.conceptDictionaryKey && (
          <DetailRow label="Dictionary" value={et.conceptDictionaryKey} />
        )}
      </div>
    </div>
  )
}

function PresetDetail({ mapping }: { mapping: SchemaMapping }) {
  const { t } = useTranslation()

  const hasAnyContent =
    mapping.patientTable ||
    mapping.visitTable ||
    (mapping.conceptTables && mapping.conceptTables.length > 0) ||
    (mapping.eventTables && Object.keys(mapping.eventTables).length > 0)

  if (!hasAnyContent) {
    return (
      <p className="text-xs text-muted-foreground italic py-2">
        {t('settings.schema_preset_no_mapping')}
      </p>
    )
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left column: patient, gender, visit, concept dictionaries */}
      <div className="space-y-4">
        <TableSection
          title={t('settings.schema_preset_patient_table')}
          mapping={mapping.patientTable as unknown as Record<string, string | undefined>}
        />

        {mapping.genderValues && (
          <div>
            <h5 className="text-xs font-medium text-foreground mb-1">
              {t('settings.schema_preset_gender_values')}
            </h5>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <DetailRow label="Male" value={mapping.genderValues.male} />
              <DetailRow label="Female" value={mapping.genderValues.female} />
              {mapping.genderValues.unknown && (
                <DetailRow label="Unknown" value={mapping.genderValues.unknown} />
              )}
            </div>
          </div>
        )}

        <TableSection
          title={t('settings.schema_preset_visit_table')}
          mapping={mapping.visitTable as unknown as Record<string, string | undefined>}
        />

        <TableSection
          title={t('settings.schema_preset_visit_detail_table')}
          mapping={mapping.visitDetailTable as unknown as Record<string, string | undefined>}
        />

        <TableSection
          title={t('settings.schema_preset_death_table')}
          mapping={mapping.deathTable as unknown as Record<string, string | undefined>}
        />

        {mapping.conceptTables && mapping.conceptTables.length > 0 && (
          <div>
            <h5 className="text-xs font-medium text-foreground mb-1">
              {t('settings.schema_preset_concept_dictionaries')}
            </h5>
            <div className="space-y-2">
              {mapping.conceptTables.map((dict) => (
                <ConceptDictionarySection key={dict.key} dict={dict} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right column: event tables + known tables */}
      <div className="space-y-4">
        {mapping.eventTables && Object.keys(mapping.eventTables).length > 0 && (
          <div>
            <h5 className="text-xs font-medium text-foreground mb-1">
              {t('settings.schema_preset_event_tables')}
            </h5>
            <div className="space-y-2">
              {Object.entries(mapping.eventTables).map(([label, et]) => (
                <EventTableSection key={label} label={label} et={et} />
              ))}
            </div>
          </div>
        )}

        {mapping.knownTables && mapping.knownTables.length > 0 && (
          <div>
            <h5 className="text-xs font-medium text-foreground mb-1">
              {t('settings.schema_preset_known_tables')} ({mapping.knownTables.length})
            </h5>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <p className="text-xs font-mono text-muted-foreground leading-relaxed">
                {mapping.knownTables.join(', ')}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline editor for custom presets
// ---------------------------------------------------------------------------

function EditableField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-xs font-mono"
      />
    </div>
  )
}

function EditablePatientTable({
  table,
  onChange,
}: {
  table: SchemaMapping['patientTable']
  onChange: (t: SchemaMapping['patientTable']) => void
}) {
  const { t } = useTranslation()
  const val = table ?? { table: '', idColumn: '' }

  const update = (key: string, v: string) => {
    onChange({ ...val, [key]: v || undefined } as typeof val)
  }

  return (
    <div>
      <h5 className="text-xs font-medium text-foreground mb-2">{t('settings.schema_preset_patient_table')}</h5>
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
        <EditableField label="Table" value={val.table} onChange={(v) => update('table', v)} placeholder="person" />
        <EditableField label="ID column" value={val.idColumn} onChange={(v) => update('idColumn', v)} placeholder="person_id" />
        <EditableField label="Birth date" value={val.birthDateColumn ?? ''} onChange={(v) => update('birthDateColumn', v)} placeholder="birth_datetime" />
        <EditableField label="Birth year" value={val.birthYearColumn ?? ''} onChange={(v) => update('birthYearColumn', v)} placeholder="year_of_birth" />
        <EditableField label="Gender" value={val.genderColumn ?? ''} onChange={(v) => update('genderColumn', v)} placeholder="gender_concept_id" />
        <EditableField label="Death date" value={val.deathDateColumn ?? ''} onChange={(v) => update('deathDateColumn', v)} placeholder="dod" />
      </div>
    </div>
  )
}

function EditableDeathTable({
  table,
  onChange,
}: {
  table: SchemaMapping['deathTable']
  onChange: (t: SchemaMapping['deathTable']) => void
}) {
  const { t } = useTranslation()
  const val = table ?? { table: '', patientIdColumn: '', dateColumn: '' }

  const update = (key: string, v: string) => {
    onChange({ ...val, [key]: v || undefined } as typeof val)
  }

  return (
    <div>
      <h5 className="text-xs font-medium text-foreground mb-2">{t('settings.schema_preset_death_table')}</h5>
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
        <EditableField label="Table" value={val.table} onChange={(v) => update('table', v)} placeholder="death" />
        <EditableField label="Patient ID" value={val.patientIdColumn} onChange={(v) => update('patientIdColumn', v)} placeholder="person_id" />
        <EditableField label="Date column" value={val.dateColumn} onChange={(v) => update('dateColumn', v)} placeholder="death_datetime" />
      </div>
    </div>
  )
}

function EditableVisitTable({
  table,
  onChange,
}: {
  table: SchemaMapping['visitTable']
  onChange: (t: SchemaMapping['visitTable']) => void
}) {
  const { t } = useTranslation()
  const val = table ?? { table: '', idColumn: '', patientIdColumn: '', startDateColumn: '' }

  const update = (key: string, v: string) => {
    onChange({ ...val, [key]: v || undefined } as typeof val)
  }

  return (
    <div>
      <h5 className="text-xs font-medium text-foreground mb-2">{t('settings.schema_preset_visit_table')}</h5>
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
        <EditableField label="Table" value={val.table} onChange={(v) => update('table', v)} placeholder="visit_occurrence" />
        <EditableField label="ID column" value={val.idColumn} onChange={(v) => update('idColumn', v)} placeholder="visit_occurrence_id" />
        <EditableField label="Patient ID" value={val.patientIdColumn} onChange={(v) => update('patientIdColumn', v)} placeholder="person_id" />
        <EditableField label="Start date" value={val.startDateColumn} onChange={(v) => update('startDateColumn', v)} placeholder="visit_start_datetime" />
        <EditableField label="End date" value={val.endDateColumn ?? ''} onChange={(v) => update('endDateColumn', v)} placeholder="visit_end_datetime" />
        <EditableField label="Type column" value={val.typeColumn ?? ''} onChange={(v) => update('typeColumn', v)} placeholder="visit_source_value" />
      </div>
    </div>
  )
}

function EditableGenderValues({
  genderValues,
  onChange,
}: {
  genderValues: SchemaMapping['genderValues']
  onChange: (g: SchemaMapping['genderValues']) => void
}) {
  const { t } = useTranslation()
  const val = genderValues ?? { male: '', female: '' }

  const update = (key: string, v: string) => {
    onChange({ ...val, [key]: v || undefined } as typeof val)
  }

  return (
    <div>
      <h5 className="text-xs font-medium text-foreground mb-2">{t('settings.schema_preset_gender_values')}</h5>
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
        <EditableField label="Male" value={val.male} onChange={(v) => update('male', v)} placeholder="8507" />
        <EditableField label="Female" value={val.female} onChange={(v) => update('female', v)} placeholder="8532" />
        <EditableField label="Unknown" value={val.unknown ?? ''} onChange={(v) => update('unknown', v)} placeholder="0" />
      </div>
    </div>
  )
}

function EditableEventTable({
  label,
  et,
  onLabelChange,
  onTableChange,
  onRemove,
}: {
  label: string
  et: EventTable
  onLabelChange: (newLabel: string) => void
  onTableChange: (et: EventTable) => void
  onRemove: () => void
}) {
  const update = (key: string, v: string) => {
    onTableChange({ ...et, [key]: v || undefined } as EventTable)
  }

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          className="h-7 text-xs font-medium flex-1"
          placeholder="Event table label"
        />
        <Button variant="ghost" size="icon-sm" onClick={onRemove}>
          <X size={12} />
        </Button>
      </div>
      <EditableField label="Table" value={et.table} onChange={(v) => update('table', v)} placeholder="measurement" />
      <EditableField label="Concept ID" value={et.conceptIdColumn} onChange={(v) => update('conceptIdColumn', v)} placeholder="measurement_concept_id" />
      <EditableField label="Source ID" value={et.sourceConceptIdColumn ?? ''} onChange={(v) => update('sourceConceptIdColumn', v)} />
      <EditableField label="Value (num)" value={et.valueColumn ?? ''} onChange={(v) => update('valueColumn', v)} placeholder="value_as_number" />
      <EditableField label="Value (str)" value={et.valueStringColumn ?? ''} onChange={(v) => update('valueStringColumn', v)} placeholder="value_as_string" />
      <EditableField label="Patient ID" value={et.patientIdColumn ?? ''} onChange={(v) => update('patientIdColumn', v)} />
      <EditableField label="Date" value={et.dateColumn ?? ''} onChange={(v) => update('dateColumn', v)} />
      <EditableField label="Dictionary" value={et.conceptDictionaryKey ?? ''} onChange={(v) => update('conceptDictionaryKey', v)} />
    </div>
  )
}

function EditableVisitDetailTable({
  table,
  onChange,
}: {
  table: SchemaMapping['visitDetailTable']
  onChange: (t: SchemaMapping['visitDetailTable']) => void
}) {
  const { t } = useTranslation()
  const val = table ?? { table: '', idColumn: '', visitIdColumn: '', patientIdColumn: '', startDateColumn: '' }

  const update = (key: string, v: string) => {
    onChange({ ...val, [key]: v || undefined } as typeof val)
  }

  return (
    <div>
      <h5 className="text-xs font-medium text-foreground mb-2">{t('settings.schema_preset_visit_detail_table')}</h5>
      <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
        <EditableField label="Table" value={val.table} onChange={(v) => update('table', v)} placeholder="visit_detail" />
        <EditableField label="ID column" value={val.idColumn} onChange={(v) => update('idColumn', v)} placeholder="visit_detail_id" />
        <EditableField label="Hospitalization ID" value={val.visitIdColumn} onChange={(v) => update('visitIdColumn', v)} placeholder="visit_occurrence_id" />
        <EditableField label="Patient ID" value={val.patientIdColumn} onChange={(v) => update('patientIdColumn', v)} placeholder="person_id" />
        <EditableField label="Start date" value={val.startDateColumn} onChange={(v) => update('startDateColumn', v)} placeholder="visit_detail_start_datetime" />
        <EditableField label="End date" value={val.endDateColumn ?? ''} onChange={(v) => update('endDateColumn', v)} placeholder="visit_detail_end_datetime" />
        <EditableField label="Unit column" value={val.unitColumn ?? ''} onChange={(v) => update('unitColumn', v)} placeholder="care_site_id" />
        <EditableField label="Unit name table" value={val.unitNameTable ?? ''} onChange={(v) => update('unitNameTable', v)} placeholder="care_site" />
        <EditableField label="Unit name ID" value={val.unitNameIdColumn ?? ''} onChange={(v) => update('unitNameIdColumn', v)} placeholder="care_site_id" />
        <EditableField label="Unit name column" value={val.unitNameColumn ?? ''} onChange={(v) => update('unitNameColumn', v)} placeholder="care_site_name" />
      </div>
    </div>
  )
}

function EditableExtraColumns({
  extraColumns,
  onChange,
}: {
  extraColumns: Record<string, string> | undefined
  onChange: (ec: Record<string, string> | undefined) => void
}) {
  const entries = Object.entries(extraColumns ?? {})

  const addEntry = () => {
    onChange({ ...(extraColumns ?? {}), '': '' })
  }

  const updateKey = (oldKey: string, newKey: string, index: number) => {
    const newEc: Record<string, string> = {}
    let i = 0
    for (const [k, v] of Object.entries(extraColumns ?? {})) {
      if (i === index) {
        newEc[newKey] = v
      } else {
        newEc[k] = v
      }
      i++
    }
    onChange(Object.keys(newEc).length > 0 ? newEc : undefined)
  }

  const updateValue = (key: string, value: string) => {
    onChange({ ...(extraColumns ?? {}), [key]: value })
  }

  const removeEntry = (key: string) => {
    const newEc = { ...(extraColumns ?? {}) }
    delete newEc[key]
    onChange(Object.keys(newEc).length > 0 ? newEc : undefined)
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Extra columns</Label>
        <Button variant="ghost" size="sm" onClick={addEntry} className="h-5 text-[10px] gap-0.5 px-1.5">
          <Plus size={9} />
          Add
        </Button>
      </div>
      {entries.map(([key, val], i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            value={key}
            onChange={(e) => updateKey(key, e.target.value, i)}
            placeholder="alias"
            className="h-6 text-[11px] font-mono flex-1"
          />
          <Input
            value={val}
            onChange={(e) => updateValue(key, e.target.value)}
            placeholder="column_name"
            className="h-6 text-[11px] font-mono flex-1"
          />
          <Button variant="ghost" size="icon-sm" onClick={() => removeEntry(key)} className="h-5 w-5 shrink-0">
            <X size={10} />
          </Button>
        </div>
      ))}
    </div>
  )
}

function EditableConceptDict({
  dict,
  onChange,
  onRemove,
}: {
  dict: ConceptDictionary
  onChange: (d: ConceptDictionary) => void
  onRemove: () => void
}) {
  const update = (key: string, v: string) => {
    onChange({ ...dict, [key]: v || undefined } as ConceptDictionary)
  }

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={dict.key}
          onChange={(e) => onChange({ ...dict, key: e.target.value })}
          className="h-7 text-xs font-medium flex-1"
          placeholder="Dictionary key"
        />
        <Button variant="ghost" size="icon-sm" onClick={onRemove}>
          <X size={12} />
        </Button>
      </div>
      <EditableField label="Table" value={dict.table} onChange={(v) => update('table', v)} placeholder="concept" />
      <EditableField label="ID column" value={dict.idColumn} onChange={(v) => update('idColumn', v)} placeholder="concept_id" />
      <EditableField label="Name column" value={dict.nameColumn} onChange={(v) => update('nameColumn', v)} placeholder="concept_name" />
      <EditableField label="Code column" value={dict.codeColumn ?? ''} onChange={(v) => update('codeColumn', v)} />
      <EditableField label="Terminology ID" value={dict.terminologyIdColumn ?? dict.vocabularyColumn ?? ''} onChange={(v) => update('terminologyIdColumn', v)} placeholder="vocabulary_id" />
      <EditableField label="Terminology name" value={dict.terminologyNameColumn ?? ''} onChange={(v) => update('terminologyNameColumn', v)} placeholder="vocabulary_name" />
      <EditableField label="Category column" value={dict.categoryColumn ?? ''} onChange={(v) => update('categoryColumn', v)} placeholder="category" />
      <EditableField label="Subcategory column" value={dict.subcategoryColumn ?? ''} onChange={(v) => update('subcategoryColumn', v)} placeholder="subcategory" />
      <EditableExtraColumns
        extraColumns={dict.extraColumns}
        onChange={(ec) => onChange({ ...dict, extraColumns: ec })}
      />
    </div>
  )
}

function PresetEditor({
  mapping,
  onChange,
}: {
  mapping: SchemaMapping
  onChange: (m: SchemaMapping) => void
}) {
  const { t } = useTranslation()

  const addEventTable = () => {
    const eventTables = { ...(mapping.eventTables ?? {}) }
    const newLabel = `Event table ${Object.keys(eventTables).length + 1}`
    eventTables[newLabel] = { table: '', conceptIdColumn: '' }
    onChange({ ...mapping, eventTables })
  }

  const updateEventTable = (oldLabel: string, newLabel: string, et: EventTable) => {
    const eventTables = { ...(mapping.eventTables ?? {}) }
    if (newLabel !== oldLabel) {
      delete eventTables[oldLabel]
    }
    eventTables[newLabel] = et
    onChange({ ...mapping, eventTables })
  }

  const removeEventTable = (label: string) => {
    const eventTables = { ...(mapping.eventTables ?? {}) }
    delete eventTables[label]
    onChange({ ...mapping, eventTables })
  }

  const addConceptDict = () => {
    const conceptTables = [...(mapping.conceptTables ?? [])]
    conceptTables.push({ key: `dict_${conceptTables.length + 1}`, table: '', idColumn: '', nameColumn: '' })
    onChange({ ...mapping, conceptTables })
  }

  const updateConceptDict = (index: number, dict: ConceptDictionary) => {
    const conceptTables = [...(mapping.conceptTables ?? [])]
    conceptTables[index] = dict
    onChange({ ...mapping, conceptTables })
  }

  const removeConceptDict = (index: number) => {
    const conceptTables = [...(mapping.conceptTables ?? [])]
    conceptTables.splice(index, 1)
    onChange({ ...mapping, conceptTables })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: patient, gender, visit, concept dictionaries */}
        <div className="space-y-4">
          <EditablePatientTable
            table={mapping.patientTable}
            onChange={(patientTable) => onChange({ ...mapping, patientTable })}
          />

          <EditableGenderValues
            genderValues={mapping.genderValues}
            onChange={(genderValues) => onChange({ ...mapping, genderValues })}
          />

          <EditableVisitTable
            table={mapping.visitTable}
            onChange={(visitTable) => onChange({ ...mapping, visitTable })}
          />

          <EditableVisitDetailTable
            table={mapping.visitDetailTable}
            onChange={(visitDetailTable) => onChange({ ...mapping, visitDetailTable })}
          />

          <EditableDeathTable
            table={mapping.deathTable}
            onChange={(deathTable) => onChange({ ...mapping, deathTable })}
          />

          {/* Concept dictionaries */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h5 className="text-xs font-medium text-foreground">
                {t('settings.schema_preset_concept_dictionaries')}
              </h5>
              <Button variant="ghost" size="sm" onClick={addConceptDict} className="h-6 text-xs gap-1">
                <Plus size={10} />
                Add
              </Button>
            </div>
            <div className="space-y-2">
              {(mapping.conceptTables ?? []).map((dict, i) => (
                <EditableConceptDict
                  key={i}
                  dict={dict}
                  onChange={(d) => updateConceptDict(i, d)}
                  onRemove={() => removeConceptDict(i)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right column: event tables */}
        <div className="space-y-4">
          {/* Event tables */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h5 className="text-xs font-medium text-foreground">
                {t('settings.schema_preset_event_tables')}
              </h5>
              <Button variant="ghost" size="sm" onClick={addEventTable} className="h-6 text-xs gap-1">
                <Plus size={10} />
                Add
              </Button>
            </div>
            <div className="space-y-2">
              {Object.entries(mapping.eventTables ?? {}).map(([label, et]) => (
                <EditableEventTable
                  key={label}
                  label={label}
                  et={et}
                  onLabelChange={(newLabel) => updateEventTable(label, newLabel, et)}
                  onTableChange={(newEt) => updateEventTable(label, label, newEt)}
                  onRemove={() => removeEventTable(label)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schema card (compact — click to navigate)
// ---------------------------------------------------------------------------

function SchemaCard({
  mapping,
  onNavigate,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
}: {
  mapping: SchemaMapping
  onNavigate: () => void
  onEdit: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)

  // Count mapped tables (all distinct table names referenced in the mapping)
  const mappedTableNames = new Set<string>()
  if (mapping.patientTable) mappedTableNames.add(mapping.patientTable.table)
  if (mapping.visitTable) mappedTableNames.add(mapping.visitTable.table)
  if (mapping.visitDetailTable) mappedTableNames.add(mapping.visitDetailTable.table)
  if (mapping.noteTable) mappedTableNames.add(mapping.noteTable.table)
  if (mapping.visitDetailTable?.unitNameTable) mappedTableNames.add(mapping.visitDetailTable.unitNameTable)
  mapping.conceptTables?.forEach((d) => mappedTableNames.add(d.table))
  if (mapping.eventTables) Object.values(mapping.eventTables).forEach((e) => mappedTableNames.add(e.table))
  const mappedCount = mappedTableNames.size
  const totalCount = mapping.knownTables?.length ?? 0

  return (
    <div
      className="rounded-lg border bg-card hover:bg-accent/30 transition-colors cursor-pointer"
      onClick={() => { if (!menuOpen) onNavigate() }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (!menuOpen && (e.key === 'Enter' || e.key === ' ')) onNavigate() }}
    >
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <div className="flex flex-1 items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Database size={14} className="text-primary" />
          </div>

          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-foreground">{mapping.presetLabel}</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              {totalCount > 0 || mappedCount > 0
                ? [
                    totalCount > 0 ? `${totalCount} ${t('settings.schema_preset_tables').toLowerCase()}` : null,
                    mappedCount > 0 ? `${mappedCount} ${t('settings.schema_preset_mapped_tables').toLowerCase()}` : null,
                  ].filter(Boolean).join(', ')
                : t('settings.schema_preset_no_mapping')}
            </p>
          </div>
        </div>

        {/* Actions */}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil size={14} />
              {t('common.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExport}>
              <Download size={14} />
              {t('settings.schema_preset_export')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy size={14} />
              {t('settings.schema_preset_duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <History size={14} />
              {t('common.history')}
              <span className="ml-auto inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground leading-none">{t('common.server_only')}</span>
            </DropdownMenuItem>
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 size={14} className="text-destructive" />
                  {t('common.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schema detail page (full page with 4 tabs)
// ---------------------------------------------------------------------------

function SchemaDetailView({
  schemaId,
  customPresets,
  onSave,
  onDelete,
  onBack,
  onRefresh,
}: {
  schemaId: string
  customPresets: CustomSchemaPreset[]
  onSave: (presetId: string, mapping: SchemaMapping) => Promise<void>
  onDelete: (presetId: string) => Promise<void>
  onBack: () => void
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  const isBuiltin = BUILTIN_PRESET_IDS.includes(schemaId)

  // Resolve mapping: IDB override > built-in > custom
  const baseMapping = useMemo(() => {
    // Check custom/overrides first (IDB)
    const custom = customPresets.find((p) => p.presetId === schemaId)
    if (custom) return custom.mapping
    // Fallback to built-in
    const builtin = SCHEMA_PRESETS[schemaId]
    if (builtin) return builtin
    return null
  }, [schemaId, customPresets])

  const [isEditing, setIsEditing] = useState(false)
  const [editMapping, setEditMapping] = useState<SchemaMapping | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const ddlEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  // Check if built-in has been customized (override exists in IDB)
  const hasCustomOverride = isBuiltin && customPresets.some((p) => p.presetId === schemaId)

  if (!baseMapping) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <Database size={32} className="text-muted-foreground/50" />
        <p className="mt-3 text-sm text-muted-foreground">Schema not found</p>
        <Button variant="outline" size="sm" onClick={onBack} className="mt-4 gap-1.5">
          <ArrowLeft size={14} />
          {t('common.back')}
        </Button>
      </div>
    )
  }

  const displayMapping = isEditing && editMapping ? editMapping : baseMapping

  const startEdit = () => {
    setIsEditing(true)
    setEditMapping(structuredClone(baseMapping))
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditMapping(null)
  }

  const handleSave = async () => {
    if (!editMapping) return
    await onSave(schemaId, editMapping)
    setIsEditing(false)
    setEditMapping(null)
  }

  const handleDelete = async () => {
    await onDelete(schemaId)
    onBack()
  }

  const handleReset = async () => {
    // Delete the IDB override → falls back to built-in
    await getStorage().schemaPresets.delete(schemaId)
    await onRefresh()
    setShowResetConfirm(false)
    setIsEditing(false)
    setEditMapping(null)
  }

  const exportMapping = () => {
    const exportData = structuredClone(displayMapping)
    delete (exportData as { knownTables?: string[] }).knownTables
    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `linkr-schema-${displayMapping.presetLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeft size={16} />
          </Button>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Database size={14} className="text-primary" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">{displayMapping.presetLabel}</h2>
        </div>
        <div className="flex items-center gap-1">
          {isEditing ? (
            <>
              <Button variant="ghost" size="sm" onClick={cancelEdit} className="gap-1.5 text-xs">
                <X size={13} />
                {t('common.cancel')}
              </Button>
              <Button variant="default" size="sm" onClick={handleSave} className="gap-1.5 text-xs">
                <Check size={13} />
                {t('common.save')}
              </Button>
            </>
          ) : (
            <>
              {isBuiltin && hasCustomOverride && (
                <Button variant="ghost" size="sm" onClick={() => setShowResetConfirm(true)} className="gap-1.5 text-xs">
                  <RotateCcw size={12} />
                  {t('schemas.reset_to_default')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={startEdit} className="gap-1.5 text-xs">
                <Pencil size={12} />
                {t('common.edit')}
              </Button>
              <Button variant="ghost" size="sm" onClick={exportMapping} className="gap-1.5 text-xs">
                <Download size={12} />
                {t('settings.schema_preset_export')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)} className="gap-1.5 text-xs text-destructive">
                <Trash2 size={12} />
                {t('common.delete')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="erd-ddl" className="flex-1 flex flex-col min-h-0">
        <div className="px-6 pt-2 shrink-0">
          <TabsList>
            <TabsTrigger value="erd-ddl">{t('schemas.tab_schema_ddl')}</TabsTrigger>
            <TabsTrigger value="ddl" className="gap-1.5">
              <Code size={12} />
              DDL
            </TabsTrigger>
            <TabsTrigger value="mapping">{t('schemas.tab_mapping')}</TabsTrigger>
            <TabsTrigger value="erd-mapping">{t('schemas.tab_schema_mapping')}</TabsTrigger>
          </TabsList>
        </div>

        {/* Tab 1: ERD from DDL */}
        <TabsContent value="erd-ddl" className="flex-1 min-h-0 m-0 p-0">
          {displayMapping.ddl ? (
            <DdlERD
              ddl={displayMapping.ddl}
              erdGroups={baseMapping.erdGroups}
              erdLayout={baseMapping.erdLayout}
              editable
              onLayoutChange={(layout) => {
                const updated = { ...baseMapping, erdLayout: Object.keys(layout).length > 0 ? layout : undefined }
                onSave(schemaId, updated)
              }}
              onGroupsChange={(groups) => {
                const updated = { ...baseMapping, erdGroups: groups }
                onSave(schemaId, updated)
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('settings.schema_preset_no_ddl')}
            </div>
          )}
        </TabsContent>

        {/* Tab 2: DDL editor */}
        <TabsContent value="ddl" className="flex-1 min-h-0 m-0 p-0">
          {(() => {
            const ddlValue = isEditing && editMapping ? (editMapping.ddl ?? '') : (displayMapping.ddl ?? '')
            if (!ddlValue) {
              return (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t('settings.schema_preset_no_ddl')}
                </div>
              )
            }
            return (
              <div className="flex h-full">
                <DdlTableOfContents ddl={ddlValue} editorRef={ddlEditorRef} />
                <div className="flex-1 min-w-0">
                  <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading editor...</div>}>
                    <LazyCodeEditor
                      value={ddlValue}
                      language="sql"
                      editorRef={ddlEditorRef}
                      readOnly={!(isEditing && editMapping)}
                      onChange={isEditing && editMapping ? (v) => setEditMapping({ ...editMapping, ddl: v ?? '' }) : undefined}
                    />
                  </Suspense>
                </div>
              </div>
            )
          })()}
        </TabsContent>

        {/* Tab 3: Mapping config */}
        <TabsContent value="mapping" className="flex-1 min-h-0 m-0 overflow-auto px-6 py-4">
          {isEditing && editMapping ? (
            <PresetEditor mapping={editMapping} onChange={setEditMapping} />
          ) : (
            <PresetDetail mapping={displayMapping} />
          )}
        </TabsContent>

        {/* Tab 4: ERD from mapping */}
        <TabsContent value="erd-mapping" className="flex-1 min-h-0 m-0 p-0">
          <SchemaERD mapping={displayMapping} fullscreen />
        </TabsContent>
      </Tabs>

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.schema_preset_delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.schema_preset_delete_confirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleDelete}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset confirmation */}
      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('schemas.reset_to_default')}</AlertDialogTitle>
            <AlertDialogDescription>{t('schemas.reset_confirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleReset}>
              {t('schemas.reset_to_default')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component — router for list vs detail
// ---------------------------------------------------------------------------

export function SchemaPresetsPage() {
  const { t } = useTranslation()
  const { schemaId, wsUid } = useParams()
  const navigate = useNavigate()
  const [customPresets, setCustomPresets] = useState<CustomSchemaPreset[]>([])
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [editingSchema, setEditingSchema] = useState<{ id: string; name: string } | null>(null)
  const [editName, setEditName] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importConflict, setImportConflict] = useState<{ name: string; mapping: SchemaMapping } | null>(null)

  const loadCustomPresets = useCallback(async () => {
    try {
      const presets = wsUid
        ? await getStorage().schemaPresets.getByWorkspace(wsUid)
        : await getStorage().schemaPresets.getAll()
      setCustomPresets(presets)
    } catch {
      // IDB not ready yet
    }
  }, [wsUid])

  useEffect(() => {
    loadCustomPresets()
  }, [loadCustomPresets])

  // Collect all schemas: built-in (possibly overridden by IDB) + custom-only
  // Track hidden built-in schemas (user deleted them)
  const hiddenKey = `linkr-hidden-schemas-${wsUid}`
  const [hiddenBuiltins, setHiddenBuiltins] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(hiddenKey) || '[]')) } catch { return new Set() }
  })

  const allSchemas = useMemo(() => {
    const result: { id: string; mapping: SchemaMapping }[] = []
    // Built-in presets (use IDB override if available, skip hidden)
    for (const presetId of BUILTIN_PRESET_IDS) {
      if (hiddenBuiltins.has(presetId)) continue
      const override = customPresets.find((p) => p.presetId === presetId)
      const mapping = override ? override.mapping : SCHEMA_PRESETS[presetId]
      if (mapping) result.push({ id: presetId, mapping })
    }
    // Custom-only presets (not overrides of built-in)
    for (const cp of customPresets) {
      if (!BUILTIN_PRESET_IDS.includes(cp.presetId)) {
        result.push({ id: cp.presetId, mapping: cp.mapping })
      }
    }
    return result
  }, [customPresets, hiddenBuiltins])

  const duplicatePreset = async (sourceMapping: SchemaMapping) => {
    const presetId = `custom-${crypto.randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const newMapping: SchemaMapping = {
      ...structuredClone(sourceMapping),
      presetId,
      presetLabel: t('settings.schema_preset_duplicate_name', { name: sourceMapping.presetLabel }),
    }
    delete (newMapping as { knownTables?: string[] }).knownTables
    const preset: CustomSchemaPreset = {
      presetId,
      mapping: newMapping,
      createdAt: now,
      updatedAt: now,
      workspaceId: wsUid,
    }
    await getStorage().schemaPresets.save(preset)
    await loadCustomPresets()
  }

  const deletePreset = async (presetId: string) => {
    await getStorage().schemaPresets.delete(presetId)
    // If it's a built-in, mark it as hidden so it doesn't reappear
    if (BUILTIN_PRESET_IDS.includes(presetId)) {
      const next = new Set(hiddenBuiltins)
      next.add(presetId)
      setHiddenBuiltins(next)
      localStorage.setItem(hiddenKey, JSON.stringify([...next]))
    }
    await loadCustomPresets()
  }

  const savePreset = async (presetId: string, mapping: SchemaMapping) => {
    const now = new Date().toISOString()
    const existing = customPresets.find((p) => p.presetId === presetId)
    const preset: CustomSchemaPreset = {
      presetId,
      mapping: { ...mapping, presetId },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      workspaceId: wsUid ?? existing?.workspaceId,
    }
    await getStorage().schemaPresets.save(preset)
    await loadCustomPresets()
  }

  const exportPreset = (mapping: SchemaMapping) => {
    const exportData = structuredClone(mapping)
    delete (exportData as { knownTables?: string[] }).knownTables
    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `linkr-schema-${mapping.presetLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase()}-${timestamp()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const mapping = JSON.parse(text) as SchemaMapping
      if (!mapping.presetId || !mapping.presetLabel) return
      const existing = customPresets.find((p) => p.presetId === mapping.presetId)
      if (existing) {
        setImportConflict({ name: existing.mapping.presetLabel, mapping })
      } else {
        await doPresetImport(mapping, false)
      }
    } catch { /* invalid JSON */ }
  }, [customPresets]) // eslint-disable-line react-hooks/exhaustive-deps

  const doPresetImport = useCallback(async (mapping: SchemaMapping, duplicate: boolean) => {
    const now = new Date().toISOString()
    const presetId = duplicate ? `custom-${crypto.randomUUID().slice(0, 8)}` : mapping.presetId!
    const importedMapping: SchemaMapping = {
      ...mapping,
      presetId,
      presetLabel: duplicate ? `${mapping.presetLabel} (copy)` : mapping.presetLabel,
    }
    if (!duplicate) {
      await getStorage().schemaPresets.delete(mapping.presetId!).catch(() => {})
    }
    const preset: CustomSchemaPreset = {
      presetId,
      mapping: importedMapping,
      createdAt: now,
      updatedAt: now,
      workspaceId: wsUid,
    }
    await getStorage().schemaPresets.save(preset)
    await loadCustomPresets()
  }, [wsUid, loadCustomPresets])

  const openCreateDialog = () => {
    setNewPresetName(t('settings.schema_preset_new_name'))
    setShowCreateDialog(true)
  }

  const confirmCreatePreset = async () => {
    const name = newPresetName.trim()
    if (!name) return
    const presetId = `custom-${crypto.randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const newMapping: SchemaMapping = {
      presetId,
      presetLabel: name,
    }
    const preset: CustomSchemaPreset = {
      presetId,
      mapping: newMapping,
      createdAt: now,
      updatedAt: now,
      workspaceId: wsUid,
    }
    await getStorage().schemaPresets.save(preset)
    await loadCustomPresets()
    setShowCreateDialog(false)
    navigate(presetId)
  }

  const openEditDialog = (id: string, name: string) => {
    setEditingSchema({ id, name })
    setEditName(name)
  }

  const confirmRenameSchema = async () => {
    if (!editingSchema || !editName.trim()) return
    const schema = allSchemas.find((s) => s.id === editingSchema.id)
    if (!schema) return
    await savePreset(editingSchema.id, { ...schema.mapping, presetLabel: editName.trim() })
    setEditingSchema(null)
  }

  const navigateToSchema = (presetId: string) => {
    navigate(presetId)
  }

  const navigateToList = () => {
    navigate(`/workspaces/${wsUid}/warehouse/schemas`)
  }

  // ── If schemaId is in URL, show detail page ──
  if (schemaId) {
    return (
      <SchemaDetailView
        schemaId={schemaId}
        customPresets={customPresets}
        onSave={savePreset}
        onDelete={deletePreset}
        onBack={navigateToList}
        onRefresh={loadCustomPresets}
      />
    )
  }

  // ── Otherwise, show list ──
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">{t('schemas.title')}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t('schemas.description')}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => importInputRef.current?.click()}
              >
                <Upload size={14} />
                {t('common.import')}
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleImportFile}
              />
              <Button size="sm" onClick={openCreateDialog} className="gap-1 text-xs">
                <Plus size={14} />
                {t('schemas.new_schema')}
              </Button>
            </div>
          </div>

          {/* All schemas — no built-in/custom distinction */}
          <div className="space-y-2">
            {allSchemas.map(({ id, mapping }) => {
              return (
                <SchemaCard
                  key={id}
                  mapping={mapping}
                  onNavigate={() => navigateToSchema(id)}
                  onEdit={() => openEditDialog(id, mapping.presetLabel)}
                  onDuplicate={() => duplicatePreset(mapping)}
                  onExport={() => exportPreset(mapping)}
                  onDelete={() => setDeleteConfirmId(id)}
                />
              )
            })}
          </div>

          {/* Create schema dialog */}
          <Dialog open={showCreateDialog} onOpenChange={(open) => { if (!open) setShowCreateDialog(false) }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('schemas.new_schema')}</DialogTitle>
                <DialogDescription>{t('settings.schema_preset_new_description')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newPresetName.trim() && !customPresets.some(p => p.mapping.presetLabel?.toLowerCase() === newPresetName.trim().toLowerCase())) {
                      confirmCreatePreset()
                    }
                  }}
                  autoFocus
                />
                {newPresetName.trim() && customPresets.some(p => p.mapping.presetLabel?.toLowerCase() === newPresetName.trim().toLowerCase()) && (
                  <p className="text-xs text-destructive">{t('common.name_already_exists')}</p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowCreateDialog(false)}>{t('common.cancel')}</Button>
                <Button onClick={confirmCreatePreset} disabled={!newPresetName.trim() || customPresets.some(p => p.mapping.presetLabel?.toLowerCase() === newPresetName.trim().toLowerCase())}>{t('common.create')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Rename schema dialog */}
          <Dialog open={!!editingSchema} onOpenChange={(open) => { if (!open) setEditingSchema(null) }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('common.edit')}</DialogTitle>
                <DialogDescription>{t('schemas.edit_description')}</DialogDescription>
              </DialogHeader>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmRenameSchema() }}
                autoFocus
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditingSchema(null)}>{t('common.cancel')}</Button>
                <Button onClick={confirmRenameSchema} disabled={!editName.trim()}>{t('common.save')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Import conflict */}
          <ImportConflictDialog
            open={!!importConflict}
            onOpenChange={(open) => { if (!open) setImportConflict(null) }}
            existingName={importConflict?.name ?? ''}
            onDuplicate={() => { if (importConflict) doPresetImport(importConflict.mapping, true); setImportConflict(null) }}
            onOverwrite={() => { if (importConflict) doPresetImport(importConflict.mapping, false); setImportConflict(null) }}
          />

          {/* Delete confirmation dialog */}
          <AlertDialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null) }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('settings.schema_preset_delete')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.schema_preset_delete_confirm')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => { if (deleteConfirmId) deletePreset(deleteConfirmId); setDeleteConfirmId(null) }}>
                  {t('common.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  )
}
