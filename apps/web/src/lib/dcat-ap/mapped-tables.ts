import type { SchemaMapping } from '@/types/schema-mapping'
import { CLASS_CONTRACTS, type ClassName, type ColumnKind } from '@/lib/schema-classes/contracts'
import { fieldRef, specEntries, specTables } from '@/lib/schema-classes/spec'

/** One source column a mapping reads directly, described for a data dictionary. */
export interface MappedColumnDoc {
  name: string
  title: string
  description: string
  /** CSVW datatype. */
  datatype: string
  key?: 'pk' | 'fk'
}

/** A source table a relation is built on, with the columns it reads as is. */
export interface MappedTableDoc {
  table: string
  role: string
  columns: MappedColumnDoc[]
}

const ROLES: Partial<Record<ClassName, string>> = {
  patient: 'Patient demographics',
  visit: 'Visit / encounter records',
  visit_detail: 'Visit detail / unit stays',
  note: 'Clinical notes',
  concept: 'Concept dictionary',
}

const DATATYPES: Record<ColumnKind, string> = {
  id: 'integer',
  datetime: 'datetime',
  date: 'date',
  number: 'decimal',
  text: 'string',
  boolean: 'boolean',
}

const TEXT: Record<string, [string, string]> = {
  patient_id: ['Patient ID', 'Patient identifier'],
  visit_id: ['Visit ID', 'Visit identifier'],
  visit_detail_id: ['Visit detail ID', 'Unit stay identifier'],
  note_id: ['Note ID', 'Note identifier'],
  birth_date: ['Birth date', 'Date of birth'],
  birth_year: ['Birth year', 'Year of birth'],
  gender_source_value: ['Gender', 'Gender concept ID or value'],
  death_datetime: ['Death date', 'Date of death'],
  start_datetime: ['Start date', 'Start date/time'],
  end_datetime: ['End date', 'End date/time'],
  visit_type: ['Visit type', 'Type or source of visit'],
  care_site_id: ['Care site', 'Care site identifier'],
  unit_id: ['Care site / unit', 'Care site or unit identifier'],
  note_datetime: ['Date', 'Note date'],
  title: ['Title', 'Note title'],
  text: ['Text', 'Clinical note text'],
  note_type: ['Type', 'Note type or category'],
  concept_id: ['Concept ID', 'Concept identifier'],
  concept_name: ['Concept name', 'Human-readable concept label'],
  concept_code: ['Concept code', 'Code within the vocabulary'],
  terminology_id: ['Vocabulary', 'Vocabulary/terminology identifier'],
  source_concept_id: ['Source concept ID', 'Source concept identifier'],
  value_number: ['Numeric value', 'Measurement numeric value'],
  value_string: ['String value', 'Measurement string value'],
  unit: ['Unit', 'Unit of the value'],
}

/** The identifying column of each class, and the ones pointing at another class. */
const PK: Partial<Record<ClassName, string>> = {
  patient: 'patient_id', visit: 'visit_id', visit_detail: 'visit_detail_id', note: 'note_id', concept: 'concept_id',
}
const FK = new Set(['patient_id', 'visit_id', 'concept_id'])

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * The source tables behind a mapping's visual relations, with the columns their
 * fields read directly from the grain table. A relation in SQL, and a field that
 * is an expression, have no one source column to describe.
 */
export function mappedTableDocs(mapping: SchemaMapping | null | undefined): MappedTableDoc[] {
  if (!mapping) return []
  const out: MappedTableDoc[] = []
  for (const { cls, spec, key } of specEntries(mapping)) {
    const grain = specTables(spec)[0]
    if (!grain) continue
    const kinds = new Map(CLASS_CONTRACTS[cls].map((c) => [c.name, c.kind]))
    const columns: MappedColumnDoc[] = []
    for (const [field, f] of Object.entries(spec.fields ?? {})) {
      const ref = fieldRef(f)
      if (!ref || ref.alias.toLowerCase() !== grain.alias.toLowerCase()) continue
      const extra = field.startsWith('extra_') ? field.slice('extra_'.length) : null
      const [title, description] = extra ? [titleCase(extra), `Concept ${extra}`] : (TEXT[field] ?? [titleCase(field), titleCase(field)])
      const pk = PK[cls] === field
      columns.push({
        name: ref.column,
        title,
        description: pk ? `Primary key — ${description.toLowerCase()}` : description,
        datatype: DATATYPES[kinds.get(field) ?? 'text'],
        ...(pk ? { key: 'pk' as const } : FK.has(field) ? { key: 'fk' as const } : {}),
      })
    }
    out.push({ table: grain.table, role: ROLES[cls] ?? key ?? cls, columns })
  }
  return out
}
