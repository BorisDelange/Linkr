import { useState, useEffect, useCallback, Suspense, lazy, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import {
  Database,
  Copy,
  Plus,
  X,
  Check,
  Upload,
  Code,
  ArrowLeft,
  RotateCcw,
  Pencil,
  Search,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Filter,
  Palette,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
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
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ImportConflictDialog } from '@/components/ui/import-conflict-dialog'
import { EntityIdField, isEntityIdValid } from '@/components/ui/entity-id-field'
import { BUILTIN_PRESET_IDS, SCHEMA_PRESETS } from '@/lib/schema-presets'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useAppStore } from '@/stores/app-store'
import { useSchemaPresetStore, buildSchemaPreset } from '@/stores/schema-preset-store'
import { localized, setLocalized } from '@/lib/localized'
import { EntityActionsMenu } from '@/components/ui/entity-actions-menu'
import { ListPageToolbar, type SortState } from '@/components/ui/list-page-toolbar'
import { CardMetaFooter } from '@/components/ui/card-meta-footer'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { useSchemaPresetActions, toSchemaPresetItem } from './use-schema-preset-actions'
import { useSaveForm } from '@/hooks/use-save-form'
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
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

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
  const { t, i18n } = useTranslation()
  const description = mapping.description ? localized(mapping.description, i18n.language) : ''

  const hasAnyContent =
    mapping.patientTable ||
    mapping.visitTable ||
    (mapping.conceptTables && mapping.conceptTables.length > 0) ||
    (mapping.eventTables && Object.keys(mapping.eventTables).length > 0)

  if (!hasAnyContent) {
    return (
      <div className="space-y-3 py-2">
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        <p className="text-xs text-muted-foreground italic">
          {t('settings.schema_preset_no_mapping')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
    {description && <p className="text-sm text-muted-foreground">{description}</p>}
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

  const updateKey = (_oldKey: string, newKey: string, index: number) => {
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
      <EditableField label="ID column" value={dict.idColumn ?? ''} onChange={(v) => update('idColumn', v)} placeholder="concept_id" />
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
  const language = useAppStore((s) => s.language)

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
      {/* Name + description (bilingual, active language only) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 rounded-md border bg-muted/30 px-3 py-2.5">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t('schemas.field_name')}<RequiredMark /></Label>
          <Input
            value={localized(mapping.presetLabel, language)}
            onChange={(e) => onChange({ ...mapping, presetLabel: setLocalized(mapping.presetLabel, language, e.target.value) })}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t('schemas.field_description')}</Label>
          <Input
            value={mapping.description ? localized(mapping.description, language) : ''}
            onChange={(e) => onChange({ ...mapping, description: setLocalized(mapping.description ?? {}, language, e.target.value) })}
            className="h-8 text-sm"
            placeholder={t('schemas.field_description_placeholder')}
          />
        </div>
      </div>
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
  createdAt,
  updatedAt,
  onNavigate,
  actionsMenu,
}: {
  mapping: SchemaMapping
  createdAt?: string
  updatedAt?: string
  onNavigate: () => void
  actionsMenu: React.ReactNode
}) {
  const { t, i18n } = useTranslation()

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
  const description = mapping.description ? localized(mapping.description, i18n.language) : ''

  return (
    <Card
      className="flex min-h-44 min-w-0 cursor-pointer flex-col gap-0 py-0 transition-colors hover:bg-accent/50"
      onClick={onNavigate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onNavigate() }}
    >
      <div className="flex flex-1 flex-col px-4 pt-5">
        <div className="flex flex-1 items-center gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
            <Database size={20} className="text-teal-500" />
          </div>

          <div className="min-w-0 flex-1">
            <span className="truncate text-sm font-medium">{localized(mapping.presetLabel, i18n.language)}</span>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {description || (totalCount > 0 || mappedCount > 0
                ? [
                    totalCount > 0 ? `${totalCount} ${t('settings.schema_preset_tables').toLowerCase()}` : null,
                    mappedCount > 0 ? `${mappedCount} ${t('settings.schema_preset_mapped_tables').toLowerCase()}` : null,
                  ].filter(Boolean).join(', ')
                : t('settings.schema_preset_no_mapping'))}
            </p>
          </div>

          {/* Actions */}
          <div className="-mt-1 self-start" onClick={(e) => e.stopPropagation()}>
            {actionsMenu}
          </div>
        </div>
        <CardMetaFooter className="mt-auto" createdAt={createdAt} updatedAt={updatedAt} />
      </div>
    </Card>
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
}: {
  schemaId: string
  customPresets: CustomSchemaPreset[]
  onSave: (presetId: string, mapping: SchemaMapping) => Promise<void>
  onDelete: (presetId: string) => Promise<void>
  onBack: () => void
}) {
  const { t } = useTranslation()
  const { can } = useMyWorkspaceRole()
  const canWrite = can('schemas:write')
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
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [activeTab, setActiveTab] = useState('erd-ddl')
  // ERD (Schema DDL tab) controls, lifted out of DdlERD so they sit on the tabs row.
  const [layoutEditing, setLayoutEditing] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [groupsPanelOpen, setGroupsPanelOpen] = useState(false)
  const ddlEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  // Cmd/Ctrl+S saves while editing the DDL / mapping tabs. Enabled only in edit
  // mode on those tabs so it doesn't fire on the read-only diagram views.
  useSaveForm({
    current: editMapping,
    baseline: null,
    onSave: () => {
      if (editMapping) {
        void onSave(schemaId, editMapping)
        setIsEditing(false)
        setEditMapping(null)
      }
    },
    canSave: isEditing && !!editMapping,
    enabled: isEditing && (activeTab === 'ddl' || activeTab === 'mapping'),
  })

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

  const handleReset = async () => {
    // Delete the stored override → falls back to the built-in mapping.
    await onDelete(schemaId)
    setShowResetConfirm(false)
    setIsEditing(false)
    setEditMapping(null)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tabs — the Edit/Save controls sit on this row, top-right. The schema's
          name, export and delete now live in the global header badge menu. */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center px-6 pt-2 shrink-0">
          <div className="flex-1" />
          <TabsList>
            <TabsTrigger value="erd-ddl">{t('schemas.tab_schema_ddl')}</TabsTrigger>
            <TabsTrigger value="ddl" className="gap-1.5">
              <Code size={12} />
              DDL
            </TabsTrigger>
            <TabsTrigger value="mapping">{t('schemas.tab_mapping')}</TabsTrigger>
            <TabsTrigger value="erd-mapping">{t('schemas.tab_schema_mapping')}</TabsTrigger>
          </TabsList>
          <div className="flex flex-1 items-center justify-end gap-1">
            {activeTab === 'erd-ddl' ? (
              // Schema (DDL) diagram: Filter + Edit(=layout editing). In edit mode,
              // Reset layout / Groups / Done. The mapping/DDL editor isn't used here.
              layoutEditing ? (
                <>
                  {baseMapping.erdLayout && Object.keys(baseMapping.erdLayout).length > 0 && (
                    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => onSave(schemaId, { ...baseMapping, erdLayout: undefined })}>
                      <RotateCcw size={12} />
                      {t('schemas.erd_reset_layout')}
                    </Button>
                  )}
                  <Button variant={groupsPanelOpen ? 'default' : 'outline'} size="sm" className="h-7 gap-1 text-xs" onClick={() => setGroupsPanelOpen((v) => !v)}>
                    <Palette size={12} />
                    {t('schemas.erd_groups')}
                  </Button>
                  <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => { setLayoutEditing(false); setGroupsPanelOpen(false) }}>
                    <Check size={12} />
                    {t('schemas.erd_done')}
                  </Button>
                </>
              ) : (
                <>
                  {(baseMapping.erdGroups ?? []).length > 0 && (
                    <Button variant={filterOpen ? 'default' : 'outline'} size="sm" className="h-7 gap-1 text-xs" onClick={() => setFilterOpen((v) => !v)}>
                      <Filter size={12} />
                      {t('schemas.erd_filter')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" disabled={!canWrite} className="h-7 gap-1 text-xs" onClick={() => { setLayoutEditing(true); setFilterOpen(false) }}>
                    <Pencil size={12} />
                    {t('common.edit')}
                  </Button>
                </>
              )
            ) : activeTab === 'erd-mapping' ? (
              // Schema (mapping) view: read-only, nothing to edit here.
              null
            ) : isEditing ? (
              <>
                <Button variant="ghost" size="sm" onClick={cancelEdit} className="h-7 gap-1 text-xs">
                  <X size={12} />
                  {t('common.cancel')}
                </Button>
                <Button size="sm" onClick={handleSave} className="h-7 gap-1 text-xs">
                  <Check size={12} />
                  {t('common.save')}
                </Button>
              </>
            ) : (
              <>
                {isBuiltin && hasCustomOverride && (
                  <Button variant="ghost" size="sm" disabled={!canWrite} onClick={() => setShowResetConfirm(true)} className="h-7 gap-1 text-xs">
                    <RotateCcw size={12} />
                    {t('schemas.reset_to_default')}
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={!canWrite} onClick={startEdit} className="h-7 gap-1 text-xs">
                  <Pencil size={12} />
                  {t('common.edit')}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Tab 1: ERD from DDL */}
        <TabsContent value="erd-ddl" className="flex-1 min-h-0 m-0 p-0">
          {displayMapping.ddl ? (
            <DdlERD
              ddl={displayMapping.ddl}
              erdGroups={baseMapping.erdGroups}
              erdLayout={baseMapping.erdLayout}
              editable={canWrite}
              layoutEditing={layoutEditing}
              filterOpen={filterOpen}
              groupsPanelOpen={groupsPanelOpen}
              onGroupsPanelOpenChange={setGroupsPanelOpen}
              onFilterOpenChange={setFilterOpen}
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
  const { wsUid, raw } = useResolvedParams()
  const navigate = useNavigate()
  const language = useAppStore((s) => s.language)
  const canWrite = useMyWorkspaceRole().can('schemas:write')
  const canDelete = useMyWorkspaceRole().can('schemas:delete')
  const customPresets = useSchemaPresetStore((s) => s.presets)
  const loadPresets = useSchemaPresetStore((s) => s.loadPresets)
  const storeSave = useSchemaPresetStore((s) => s.savePreset)
  const storeDelete = useSchemaPresetStore((s) => s.deletePreset)
  const schemaActions = useSchemaPresetActions()
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [newPresetDescription, setNewPresetDescription] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importConflict, setImportConflict] = useState<{ name: string; mapping: SchemaMapping } | null>(null)

  const loadCustomPresets = useCallback(() => loadPresets(wsUid), [loadPresets, wsUid])

  useEffect(() => {
    loadCustomPresets()
  }, [loadCustomPresets])

  // Only show schemas that exist in storage (user-added or added from templates).
  const allSchemas = useMemo(() => {
    return customPresets.map(cp => ({ id: cp.presetId, mapping: cp.mapping, preset: cp }))
  }, [customPresets])

  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const filteredSchemas = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const filtered = q
      ? allSchemas.filter(({ mapping }) =>
          `${localized(mapping.presetLabel, language)} ${mapping.description ? localized(mapping.description, language) : ''}`.toLowerCase().includes(q))
      : allSchemas
    return applySort(filtered, sort, {
      name: (s) => localized(s.mapping.presetLabel, language),
      createdAt: (s) => s.preset.createdAt,
      updatedAt: (s) => s.preset.updatedAt,
    })
  }, [allSchemas, searchQuery, sort, language])

  const duplicatePreset = async (sourceMapping: SchemaMapping) => {
    const presetId = `custom-${crypto.randomUUID().slice(0, 8)}`
    const newMapping: SchemaMapping = {
      ...structuredClone(sourceMapping),
      presetId,
      presetLabel: setLocalized({}, language, t('settings.schema_preset_duplicate_name', { name: localized(sourceMapping.presetLabel, language) })),
    }
    delete (newMapping as { knownTables?: string[] }).knownTables
    await storeSave(buildSchemaPreset(presetId, newMapping, undefined, wsUid))
  }

  const deletePreset = async (presetId: string) => {
    await storeDelete(presetId)
  }

  const savePreset = async (presetId: string, mapping: SchemaMapping) => {
    const existing = customPresets.find((p) => p.presetId === presetId)
    await storeSave(buildSchemaPreset(presetId, mapping, existing, wsUid))
  }

  const doPresetImport = useCallback(async (mapping: SchemaMapping, duplicate: boolean) => {
    const presetId = duplicate ? `custom-${crypto.randomUUID().slice(0, 8)}` : mapping.presetId!
    // Legacy export ZIPs may carry a plain-string label; coerce so it stays bilingual.
    const label = typeof mapping.presetLabel === 'string' ? { en: mapping.presetLabel, fr: mapping.presetLabel } : mapping.presetLabel
    const importedMapping: SchemaMapping = {
      ...mapping,
      presetId,
      presetLabel: duplicate ? setLocalized(label, language, `${localized(label, language)} (copy)`) : label,
    }
    if (!duplicate) {
      await storeDelete(mapping.presetId!).catch(() => {})
    }
    await storeSave(buildSchemaPreset(presetId, importedMapping, undefined, wsUid))
  }, [wsUid, language, storeDelete, storeSave])

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
        setImportConflict({ name: localized(existing.mapping.presetLabel, language), mapping })
      } else {
        await doPresetImport(mapping, false)
      }
    } catch { /* invalid JSON */ }
  }, [customPresets, language, doPresetImport])

  const [createTemplate, setCreateTemplate] = useState<string>('blank')
  const [newPresetId, setNewPresetId] = useState('')

  const openCreateDialog = () => {
    setNewPresetName(t('settings.schema_preset_new_name'))
    setNewPresetDescription('')
    setNewPresetId('')
    setCreateTemplate('blank')
    setShowCreateDialog(true)
  }

  // A blank schema's identifier is optional (empty → random fallback); if the
  // user typed one it must be valid and not collide with an existing preset id
  // (the store upserts by presetId, so a dup would silently overwrite it).
  const presetIdOk =
    createTemplate !== 'blank' ||
    newPresetId.trim() === '' ||
    isEntityIdValid(newPresetId.trim(), [...BUILTIN_PRESET_IDS, ...customPresets.map((p) => p.presetId)])
  const nameDuplicate = customPresets.some(
    (p) => localized(p.mapping.presetLabel, language).toLowerCase() === newPresetName.trim().toLowerCase(),
  )
  const canCreatePreset = !!newPresetName.trim() && !nameDuplicate && presetIdOk

  const confirmCreatePreset = async () => {
    const name = newPresetName.trim()
    if (!canCreatePreset) return

    const label = setLocalized({}, language, name)
    const description = newPresetDescription.trim() ? setLocalized({}, language, newPresetDescription.trim()) : undefined
    // If using a built-in template, copy its mapping
    const templateMapping = createTemplate !== 'blank' && SCHEMA_PRESETS[createTemplate]
      ? { ...SCHEMA_PRESETS[createTemplate], presetLabel: label, description }
      : undefined

    // Built-in template keeps its own id (so a deleted default can be restored);
    // a blank schema uses the user-provided identifier, or a random fallback.
    const presetId = createTemplate !== 'blank'
      ? createTemplate
      : (newPresetId.trim() || `custom-${crypto.randomUUID().slice(0, 8)}`)
    const newMapping: SchemaMapping = templateMapping ?? {
      presetId,
      presetLabel: label,
      description,
    }
    newMapping.presetId = presetId
    await storeSave(buildSchemaPreset(presetId, newMapping, undefined, wsUid))
    setShowCreateDialog(false)
    navigate(presetId)
  }

  const navigateToSchema = (presetId: string) => {
    navigate(presetId)
  }

  const navigateToList = () => {
    navigate(paths.warehouseSchemas(wsUid ?? ''))
  }

  // ── If schemaId is in URL, show detail page ──
  const schemaId = resolveByIdPrefix(customPresets, raw.schemaId, (p) => p.presetId)?.presetId ?? raw.schemaId
  if (schemaId) {
    return (
      <SchemaDetailView
        schemaId={schemaId}
        customPresets={customPresets}
        onSave={savePreset}
        onDelete={deletePreset}
        onBack={navigateToList}
      />
    )
  }

  // ── Otherwise, show list ──
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
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
                disabled={!canWrite}
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
              <Button size="sm" disabled={!canWrite} onClick={openCreateDialog} className="gap-1 text-xs">
                <Plus size={14} />
                {t('schemas.new_schema')}
              </Button>
            </div>
          </div>

          {allSchemas.length > 0 && (
            <ListPageToolbar
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              searchPlaceholder={t('schemas.search_placeholder')}
              sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
            />
          )}

          {allSchemas.length === 0 ? (
            <Card className="mt-6">
              <div className="flex flex-col items-center py-12">
                <FileSpreadsheet size={40} className="text-muted-foreground" />
                <p className="mt-4 text-sm font-medium text-foreground">{t('schemas.empty_title')}</p>
                <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                  {t('schemas.empty_description')}
                </p>
              </div>
            </Card>
          ) : filteredSchemas.length === 0 ? (
            <div className="mt-6 flex flex-col items-center py-8">
              <FileSpreadsheet size={24} className="text-muted-foreground/50" />
              <p className="mt-2 text-sm text-muted-foreground">{t('common.no_results')}</p>
            </div>
          ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {filteredSchemas.map(({ id, mapping, preset }) => {
              const item = toSchemaPresetItem(preset)
              return (
                <SchemaCard
                  key={id}
                  mapping={mapping}
                  createdAt={preset.createdAt}
                  updatedAt={preset.updatedAt}
                  onNavigate={() => navigateToSchema(id)}
                  actionsMenu={
                    <EntityActionsMenu
                      item={item}
                      {...schemaActions}
                      syncScope="schema-presets"
                      canEdit={canWrite}
                      canDelete={canDelete}
                      open={menuOpenId === id}
                      onOpenChange={(o) => setMenuOpenId(o ? id : null)}
                      extraItems={
                        <DropdownMenuItem onSelect={() => duplicatePreset(mapping)} disabled={!canWrite}>
                          <Copy size={14} />
                          {t('settings.schema_preset_duplicate')}
                        </DropdownMenuItem>
                      }
                    />
                  }
                />
              )
            })}
          </div>
          )}

          {/* Create schema dialog */}
          <Dialog open={showCreateDialog} onOpenChange={(open) => { if (!open) setShowCreateDialog(false) }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('schemas.new_schema')}</DialogTitle>
                <DialogDescription>{t('settings.schema_preset_new_description')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {/* Template picker */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('schemas.template')}</Label>
                  <p className="text-[11px] text-muted-foreground">{t('schemas.template_hint')}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { id: 'blank', label: t('schemas.template_blank') },
                      ...BUILTIN_PRESET_IDS
                        .filter(pid => !customPresets.some(cp => cp.presetId === pid))
                        .map(pid => ({ id: pid, label: SCHEMA_PRESETS[pid]?.presetLabel ? localized(SCHEMA_PRESETS[pid]!.presetLabel, language) : pid })),
                    ].map(tpl => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => {
                          setCreateTemplate(tpl.id)
                          if (tpl.id !== 'blank') setNewPresetName(tpl.label)
                        }}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                          createTemplate === tpl.id
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border hover:bg-accent'
                        }`}
                      >
                        <Database size={14} className="shrink-0 text-muted-foreground" />
                        <span className="truncate">{tpl.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {/* Name */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('common.name')}<RequiredMark /></Label>
                  <Input
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && canCreatePreset) {
                        e.preventDefault()
                        confirmCreatePreset()
                      }
                    }}
                    autoFocus
                  />
                  {newPresetName.trim() && nameDuplicate && (
                    <p className="text-xs text-destructive">{t('common.name_already_exists')}</p>
                  )}
                </div>
                {/* Description */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('schemas.field_description')}</Label>
                  <Input
                    value={newPresetDescription}
                    onChange={(e) => setNewPresetDescription(e.target.value)}
                    className="h-8 text-sm"
                    placeholder={t('schemas.field_description_placeholder')}
                  />
                </div>
                {/* Identifier — only for blank schemas; a template reuses its own preset id. */}
                {createTemplate === 'blank' && (
                  <EntityIdField
                    name={newPresetName}
                    value={newPresetId}
                    onChange={setNewPresetId}
                    existingIds={[...BUILTIN_PRESET_IDS, ...customPresets.map(p => p.presetId)]}
                    htmlId="schema-preset-id"
                    placeholder="my-schema"
                  />
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowCreateDialog(false)}>{t('common.cancel')}</Button>
                <Button onClick={confirmCreatePreset} disabled={!canCreatePreset}>{t('common.create')}</Button>
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
        </div>
      </div>
    </div>
  )
}
