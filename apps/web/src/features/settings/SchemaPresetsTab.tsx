import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Database,
  Lock,
  Copy,
  Trash2,
  Pencil,
  Plus,
  X,
  Check,
  Eye,
  Download,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import { BUILTIN_PRESET_IDS, SCHEMA_PRESETS } from '@/lib/schema-presets'
import { getStorage } from '@/lib/storage'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { SchemaERD } from './SchemaERD'
import type {
  SchemaMapping,
  ConceptDictionary,
  EventTable,
  CustomSchemaPreset,
} from '@/types/schema-mapping'

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
      </div>
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
      {/* Preset label */}
      <div className="space-y-1.5">
        <Label className="text-xs">Preset name</Label>
        <Input
          value={mapping.presetLabel}
          onChange={(e) => onChange({ ...mapping, presetLabel: e.target.value })}
          className="h-8 text-sm"
        />
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
// Fullscreen preset dialog with ERD / Detail tabs
// ---------------------------------------------------------------------------

function PresetFullscreenDialog({
  open,
  onOpenChange,
  mapping,
  isBuiltin,
  isEditing,
  editMapping,
  onEditMappingChange,
  onEdit,
  onSave,
  onCancel,
  defaultTab,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mapping: SchemaMapping
  isBuiltin: boolean
  isEditing: boolean
  editMapping?: SchemaMapping
  onEditMappingChange?: (m: SchemaMapping) => void
  onEdit?: () => void
  onSave?: () => void
  onCancel?: () => void
  defaultTab?: 'erd' | 'detail'
}) {
  const { t } = useTranslation()
  const displayMapping = isEditing && editMapping ? editMapping : mapping

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[95vw] w-[95vw] h-[90vh] flex flex-col p-0 gap-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <Database size={14} className="text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">{displayMapping.presetLabel}</h3>
                {isBuiltin ? (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <Lock size={9} />
                    {t('settings.schema_preset_builtin')}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    {t('settings.schema_preset_custom')}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isEditing ? (
              <>
                <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1.5 text-xs">
                  <X size={13} />
                  Cancel
                </Button>
                <Button variant="default" size="sm" onClick={onSave} className="gap-1.5 text-xs">
                  <Check size={13} />
                  Save
                </Button>
              </>
            ) : (
              <>
                {!isBuiltin && onEdit && (
                  <Button variant="outline" size="sm" onClick={onEdit} className="gap-1.5 text-xs">
                    <Pencil size={12} />
                    Edit
                  </Button>
                )}
              </>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)}>
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* Tabbed content */}
        <Tabs defaultValue={defaultTab ?? 'erd'} className="flex-1 flex flex-col min-h-0">
          <div className="px-5 pt-2 shrink-0">
            <TabsList>
              <TabsTrigger value="erd">{t('settings.schema_preset_tab_erd')}</TabsTrigger>
              <TabsTrigger value="detail">{t('settings.schema_preset_tab_detail')}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="erd" className="flex-1 min-h-0 m-0 p-0">
            <SchemaERD mapping={displayMapping} fullscreen />
          </TabsContent>

          <TabsContent value="detail" className="flex-1 min-h-0 m-0 overflow-auto px-5 py-4">
            {isEditing && editMapping && onEditMappingChange ? (
              <PresetEditor mapping={editMapping} onChange={onEditMappingChange} />
            ) : (
              <PresetDetail mapping={displayMapping} />
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Preset card (compact — click to open fullscreen)
// ---------------------------------------------------------------------------

function PresetCard({
  mapping,
  isBuiltin,
  onOpen,
  onDuplicate,
  onExport,
  onDelete,
}: {
  mapping: SchemaMapping
  isBuiltin: boolean
  onOpen: () => void
  onDuplicate: () => void
  onExport: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()

  const tableCount = [mapping.patientTable, mapping.visitTable].filter(Boolean).length
  const dictCount = mapping.conceptTables?.length ?? 0
  const eventCount = mapping.eventTables ? Object.keys(mapping.eventTables).length : 0

  return (
    <div className="rounded-lg border bg-card hover:bg-accent/30 transition-colors">
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onOpen}
          className="flex flex-1 items-center gap-3 text-left hover:opacity-80 transition-opacity"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Database size={14} className="text-primary" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{mapping.presetLabel}</span>
              {isBuiltin ? (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Lock size={9} />
                  {t('settings.schema_preset_builtin')}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">
                  {t('settings.schema_preset_custom')}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tableCount > 0 || dictCount > 0 || eventCount > 0
                ? [
                    tableCount > 0 ? `${tableCount} ${t('settings.schema_preset_tables').toLowerCase()}` : null,
                    dictCount > 0 ? `${dictCount} ${t('settings.schema_preset_concept_dictionaries').toLowerCase()}` : null,
                    eventCount > 0 ? `${eventCount} ${t('settings.schema_preset_event_tables').toLowerCase()}` : null,
                  ].filter(Boolean).join(', ')
                : t('settings.schema_preset_no_mapping')}
            </p>
          </div>
        </button>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={onOpen} title="View">
            <Eye size={13} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onExport} title={t('settings.schema_preset_export')}>
            <Download size={13} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onDuplicate} title={t('settings.schema_preset_duplicate')}>
            <Copy size={13} />
          </Button>
          {!isBuiltin && onDelete && (
            <Button variant="ghost" size="icon-sm" onClick={onDelete} title={t('settings.schema_preset_delete')} className="text-destructive">
              <Trash2 size={13} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SchemaPresetsTab() {
  const { t } = useTranslation()
  const [customPresets, setCustomPresets] = useState<CustomSchemaPreset[]>([])
  const [openPresetId, setOpenPresetId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editMapping, setEditMapping] = useState<SchemaMapping | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')

  const loadCustomPresets = useCallback(async () => {
    try {
      const presets = await getStorage().schemaPresets.getAll()
      setCustomPresets(presets)
    } catch {
      // IDB not ready yet
    }
  }, [])

  useEffect(() => {
    loadCustomPresets()
  }, [loadCustomPresets])

  // Resolve the mapping for the currently open preset
  const getOpenMapping = (): SchemaMapping | null => {
    if (!openPresetId) return null
    const builtin = SCHEMA_PRESETS[openPresetId]
    if (builtin) return builtin
    const custom = customPresets.find((p) => p.presetId === openPresetId)
    return custom?.mapping ?? null
  }

  const openMapping = getOpenMapping()
  const isOpenBuiltin = openPresetId ? BUILTIN_PRESET_IDS.includes(openPresetId) : false

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
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
    }
    await getStorage().schemaPresets.save(preset)
    await loadCustomPresets()
    await autoCommitPreset(presetId, newMapping.presetLabel, 'create')
  }

  const autoCommitPreset = async (presetId: string, presetName: string, changeType: 'create' | 'update' | 'delete') => {
    const wsId = useWorkspaceStore.getState().activeWorkspaceId
    if (!wsId) return
    try {
      const { useWorkspaceVersioningStore } = await import('@/stores/workspace-versioning-store')
      const store = useWorkspaceVersioningStore.getState()
      await store.ensureRepo(wsId)
      await store.commitSchemaPresetChange(wsId, presetId, presetName, changeType)
    } catch (err) {
      console.warn('[schema-presets] Git commit failed:', err)
    }
  }

  const deletePreset = async (presetId: string) => {
    const preset = customPresets.find((p) => p.presetId === presetId)
    const presetName = preset?.mapping?.presetLabel ?? presetId
    await getStorage().schemaPresets.delete(presetId)
    await loadCustomPresets()
    await autoCommitPreset(presetId, presetName, 'delete')
    if (openPresetId === presetId) setOpenPresetId(null)
    if (editingId === presetId) {
      setEditingId(null)
      setEditMapping(null)
    }
  }

  const startEdit = () => {
    if (!openPresetId || !openMapping) return
    setEditingId(openPresetId)
    setEditMapping(structuredClone(openMapping))
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditMapping(null)
  }

  const saveEdit = async () => {
    if (!editingId || !editMapping) return
    const existing = customPresets.find((p) => p.presetId === editingId)
    if (!existing) return
    const updated: CustomSchemaPreset = {
      ...existing,
      mapping: { ...editMapping, presetId: editingId },
      updatedAt: new Date().toISOString(),
    }
    await getStorage().schemaPresets.save(updated)
    await loadCustomPresets()
    await autoCommitPreset(editingId, editMapping.presetLabel, 'update')
    setEditingId(null)
    setEditMapping(null)
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  const exportPreset = (mapping: SchemaMapping) => {
    // Export only the mapping (no internal IDs)
    const exportData = structuredClone(mapping)
    delete (exportData as { knownTables?: string[] }).knownTables
    const json = JSON.stringify(exportData, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `linkr-schema-${mapping.presetLabel.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importPreset = async (file: File) => {
    try {
      const text = await file.text()
      const imported = JSON.parse(text) as SchemaMapping
      if (!imported.presetLabel) {
        imported.presetLabel = file.name.replace(/\.json$/, '')
      }
      const presetId = `custom-${crypto.randomUUID().slice(0, 8)}`
      const now = new Date().toISOString()
      imported.presetId = presetId
      const preset: CustomSchemaPreset = {
        presetId,
        mapping: imported,
        createdAt: now,
        updatedAt: now,
        workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
      }
      await getStorage().schemaPresets.save(preset)
      await loadCustomPresets()
      await autoCommitPreset(presetId, imported.presetLabel, 'create')
      setOpenPresetId(presetId)
    } catch {
      // Invalid JSON — silently ignore
    }
  }

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
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId ?? undefined,
    }
    await getStorage().schemaPresets.save(preset)
    await loadCustomPresets()
    await autoCommitPreset(presetId, name, 'create')
    setShowCreateDialog(false)
    setOpenPresetId(presetId)
    setEditingId(presetId)
    setEditMapping(newMapping)
  }

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      if (editingId) {
        cancelEdit()
      }
      setOpenPresetId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('settings.schema_presets_title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.schema_presets_description')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) importPreset(file)
              e.target.value = ''
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload size={14} />
            {t('settings.schema_preset_import')}
          </Button>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus size={14} />
            {t('settings.schema_preset_new')}
          </Button>
        </div>
      </div>

      {/* Built-in presets */}
      <div className="space-y-2">
        {BUILTIN_PRESET_IDS.map((presetId) => {
          const preset = SCHEMA_PRESETS[presetId]
          if (!preset) return null
          return (
            <PresetCard
              key={presetId}
              mapping={preset}
              isBuiltin={true}
              onOpen={() => setOpenPresetId(presetId)}
              onDuplicate={() => duplicatePreset(preset)}
              onExport={() => exportPreset(preset)}
            />
          )
        })}
      </div>

      {/* Custom presets */}
      {customPresets.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('settings.schema_preset_custom')}
          </h4>
          {customPresets.map((cp) => (
            <PresetCard
              key={cp.presetId}
              mapping={cp.mapping}
              isBuiltin={false}
              onOpen={() => setOpenPresetId(cp.presetId)}
              onDuplicate={() => duplicatePreset(cp.mapping)}
              onExport={() => exportPreset(cp.mapping)}
              onDelete={() => setDeleteConfirmId(cp.presetId)}
            />
          ))}
        </div>
      )}

      {/* Create preset dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => { if (!open) setShowCreateDialog(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.schema_preset_new')}</DialogTitle>
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
              {t('settings.schema_preset_delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Fullscreen dialog */}
      {openMapping && openPresetId && (
        <PresetFullscreenDialog
          open={true}
          onOpenChange={handleDialogClose}
          mapping={openMapping}
          isBuiltin={isOpenBuiltin}
          isEditing={editingId === openPresetId}
          editMapping={editingId === openPresetId ? editMapping ?? undefined : undefined}
          onEditMappingChange={editingId === openPresetId ? setEditMapping : undefined}
          onEdit={!isOpenBuiltin ? startEdit : undefined}
          onSave={saveEdit}
          onCancel={cancelEdit}
          defaultTab={editingId === openPresetId ? 'detail' : 'erd'}
        />
      )}
    </div>
  )
}
