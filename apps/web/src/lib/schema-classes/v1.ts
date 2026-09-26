import type {
  ConceptSpec,
  EventSpec,
  FieldSpec,
  PatientSpec,
  RelationJoin,
  RelationSpec,
  SchemaMapping,
} from '@/types/schema-mapping'
import type { LocalizedString } from '@/types'
import { isSafeIdentifier } from '@/lib/format-helpers'
import { parseDdl, indexTables, resolveTableRef } from '@/lib/ddl-parse'

// ---------------------------------------------------------------------------
// The v1 mapping (one block per table, one field per column), read only to be
// converted. Nothing else in the app knows this shape (plan §8, decision 6).
// ---------------------------------------------------------------------------

interface V1Ref {
  schema?: string
  table: string
}

interface V1ConceptDictionary extends V1Ref {
  key: string
  idColumn?: string
  nameColumn: string
  codeColumn?: string
  vocabularyColumn?: string
  terminologyIdColumn?: string
  terminologyNameColumn?: string
  categoryColumn?: string
  subcategoryColumn?: string
  extraColumns?: Record<string, string>
}

interface V1EventTable extends V1Ref {
  conceptIdColumn: string
  sourceConceptIdColumn?: string
  conceptVocabularyColumn?: string
  conceptCodeColumn?: string
  valueColumn?: string
  valueStringColumn?: string
  valueUnitColumn?: string
  /** Pre-rename spelling of `valueUnitColumn`. */
  unitColumn?: string
  valueUnitConceptIdColumn?: string
  routeConceptIdColumn?: string
  routeColumn?: string
  patientIdColumn?: string
  dateColumn?: string
  endDateColumn?: string
  conceptDictionaryKey?: string
}

export interface SchemaMappingV1 {
  presetId: string
  presetLabel: LocalizedString
  description?: LocalizedString
  patientTable?: V1Ref & {
    idColumn: string
    birthDateColumn?: string
    birthYearColumn?: string
    anchorAgeColumn?: string
    anchorYearColumn?: string
    genderColumn?: string
    deathDateColumn?: string
  }
  visitTable?: V1Ref & {
    idColumn: string
    patientIdColumn: string
    startDateColumn: string
    endDateColumn?: string
    typeColumn?: string
    careSiteColumn?: string
    careSiteNameTable?: string
    careSiteNameIdColumn?: string
    careSiteNameColumn?: string
  }
  noteTable?: V1Ref & {
    idColumn: string
    patientIdColumn: string
    visitIdColumn?: string
    dateColumn: string
    titleColumn?: string
    textColumn: string
    typeColumn?: string
  }
  visitDetailTable?: V1Ref & {
    idColumn: string
    visitIdColumn: string
    patientIdColumn: string
    startDateColumn: string
    endDateColumn?: string
    unitColumn?: string
    unitNameTable?: string
    unitNameIdColumn?: string
    unitNameColumn?: string
    unitSourceValueColumn?: string
  }
  deathTable?: V1Ref & { patientIdColumn: string; dateColumn: string }
  conceptTables?: V1ConceptDictionary[]
  eventTables?: Record<string, V1EventTable>
  genderValues?: { male: string; female: string; unknown?: string }
  knownTables?: string[]
  ddl?: string
  erdGroups?: SchemaMapping['erdGroups']
  erdLayout?: SchemaMapping['erdLayout']
}

const V1_BLOCKS = ['patientTable', 'visitTable', 'visitDetailTable', 'noteTable', 'deathTable', 'conceptTables', 'eventTables', 'genderValues'] as const

/** A mapping written before format v2: no `formatVersion`, or any v1 block. */
export function isMappingV1(mapping: unknown): mapping is SchemaMappingV1 {
  if (!mapping || typeof mapping !== 'object') return false
  const m = mapping as Record<string, unknown>
  if (m.formatVersion === 2) return false
  return V1_BLOCKS.some((k) => k in m) || !('formatVersion' in m)
}

/** `a.column`, or undefined when the column is unset. */
function ref(alias: string, column: string | undefined): string | undefined {
  return column ? `${alias}.${column}` : undefined
}

/** `a."column"` inside an expression, where the generator does not quote. */
function q(alias: string, column: string): string {
  return `${alias}."${column}"`
}

function qualified(r: V1Ref): string {
  return r.schema ? `"${r.schema}"."${r.table}"` : `"${r.table}"`
}

function fields(entries: Record<string, FieldSpec | undefined>): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {}
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v
  return out
}

function from(r: V1Ref, alias: string): RelationSpec['from'] {
  return r.schema ? { schema: r.schema, table: r.table, alias } : { table: r.table, alias }
}

/**
 * Convert a v1 mapping to v2, relation by relation. The generated SQL of each
 * relation is the one phase A generated from the v1 block (parity-tested), so a
 * converted mapping reads exactly the same rows.
 */
export function mappingV1ToV2(v1: SchemaMappingV1): SchemaMapping {
  const out: SchemaMapping = { formatVersion: 2, presetId: v1.presetId, presetLabel: v1.presetLabel }
  if (v1.description) out.description = v1.description

  // Which columns a table has, when the preset carries its DDL — used to leave
  // out the conventional visit column of an event table that has none.
  const ddl = v1.ddl ? indexTables(parseDdl(v1.ddl)) : null
  const tableHas = (r: V1Ref, column: string): boolean => {
    if (!ddl) return true
    const t = resolveTableRef(ddl.byQualified, ddl.byBare, r)
    return !t || t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase())
  }

  const pt = v1.patientTable
  if (pt) {
    const p = 'p'
    const dt = v1.deathTable
    const death: FieldSpec | undefined = pt.deathDateColumn
      ? ref(p, pt.deathDateColumn)
      : dt
        ? { expr: `SELECT MIN(_d."${dt.dateColumn}") FROM ${qualified(dt)} _d WHERE _d."${dt.patientIdColumn}" = ${q(p, pt.idColumn)}` }
        : undefined
    const birthYear: FieldSpec | undefined = pt.birthYearColumn
      ? ref(p, pt.birthYearColumn)
      : pt.anchorYearColumn && pt.anchorAgeColumn
        ? { expr: `${q(p, pt.anchorYearColumn)} - ${q(p, pt.anchorAgeColumn)}` }
        : undefined
    const patient: PatientSpec = {
      from: from(pt, p),
      fields: fields({
        patient_id: ref(p, pt.idColumn),
        birth_date: ref(p, pt.birthDateColumn),
        birth_year: birthYear,
        gender_source_value: ref(p, pt.genderColumn),
        death_datetime: death,
      }),
    }
    if (v1.genderValues) patient.genderValues = v1.genderValues
    out.patient = patient
  }
  // Gender codes without a patient table still say how to read the raw values.
  else if (v1.genderValues) out.patient = { genderValues: v1.genderValues }

  const vt = v1.visitTable
  if (vt) {
    const lookup = vt.careSiteColumn && vt.careSiteNameTable && vt.careSiteNameIdColumn && vt.careSiteNameColumn
    const joins: RelationJoin[] = lookup
      ? [{ type: 'left', ...from({ schema: vt.schema, table: vt.careSiteNameTable! }, 'cs')!, on: [[`v.${vt.careSiteColumn}`, `cs.${vt.careSiteNameIdColumn}`]] }]
      : []
    out.visit = {
      from: from(vt, 'v'),
      ...(joins.length ? { joins } : {}),
      fields: fields({
        visit_id: ref('v', vt.idColumn),
        patient_id: ref('v', vt.patientIdColumn),
        start_datetime: ref('v', vt.startDateColumn),
        end_datetime: ref('v', vt.endDateColumn),
        visit_type: ref('v', vt.typeColumn),
        care_site_id: ref('v', vt.careSiteColumn),
        care_site_name: lookup ? ref('cs', vt.careSiteNameColumn) : undefined,
      }),
    }
  }

  const vdt = v1.visitDetailTable
  if (vdt) {
    const lookup = vdt.unitColumn && vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn
    const joins: RelationJoin[] = lookup
      ? [{ type: 'left', ...from({ schema: vdt.schema, table: vdt.unitNameTable! }, 'un')!, on: [[`vd.${vdt.unitColumn}`, `un.${vdt.unitNameIdColumn}`]] }]
      : []
    const lookupName = lookup ? q('un', vdt.unitNameColumn!) : undefined
    const unit = vdt.unitColumn ? q('vd', vdt.unitColumn) : undefined
    // The ward, in order of clinical usefulness: the verbatim source value, then
    // the looked-up name, then the raw column — a name on MIMIC, an id on OMOP.
    const candidates = [vdt.unitSourceValueColumn ? q('vd', vdt.unitSourceValueColumn) : undefined, lookupName, unit]
      .filter((x): x is string => !!x)
      .map((x) => `NULLIF(CAST(${x} AS VARCHAR), '')`)
    const category = lookupName ?? unit
    out.visitDetail = {
      from: from(vdt, 'vd'),
      ...(joins.length ? { joins } : {}),
      fields: fields({
        visit_detail_id: ref('vd', vdt.idColumn),
        visit_id: ref('vd', vdt.visitIdColumn),
        patient_id: ref('vd', vdt.patientIdColumn),
        start_datetime: ref('vd', vdt.startDateColumn),
        end_datetime: ref('vd', vdt.endDateColumn),
        unit_id: ref('vd', vdt.unitColumn),
        unit_name: candidates.length === 0 ? undefined : { expr: candidates.length === 1 ? candidates[0] : `COALESCE(${candidates.join(', ')})` },
        // The looked-up name groups wards of the same kind.
        unit_category: category ? { expr: `CAST(${category} AS VARCHAR)` } : undefined,
      }),
    }
  }

  const nt = v1.noteTable
  if (nt) {
    out.note = {
      from: from(nt, 'n'),
      fields: fields({
        note_id: ref('n', nt.idColumn),
        patient_id: ref('n', nt.patientIdColumn),
        visit_id: ref('n', nt.visitIdColumn),
        note_datetime: ref('n', nt.dateColumn),
        title: ref('n', nt.titleColumn),
        text: ref('n', nt.textColumn),
        note_type: ref('n', nt.typeColumn),
      }),
    }
  }

  if (v1.conceptTables?.length) {
    out.concepts = v1.conceptTables.map((d): ConceptSpec => {
      const extras: Record<string, FieldSpec> = {}
      for (const [alias, column] of Object.entries(d.extraColumns ?? {})) {
        if (isSafeIdentifier(alias) && !alias.includes('.')) extras[`extra_${alias}`] = `d.${column}`
      }
      return {
        key: d.key,
        from: from(d, 'd'),
        fields: fields({
          // A code-only dictionary (MIMIC d_icd_diagnoses) is keyed by its code.
          concept_id: ref('d', d.idColumn ?? d.codeColumn),
          concept_terminology: ref('d', d.vocabularyColumn ?? d.terminologyIdColumn),
          concept_name: ref('d', d.nameColumn),
          concept_code: ref('d', d.codeColumn),
          terminology_id: ref('d', d.terminologyIdColumn ?? d.vocabularyColumn),
          terminology_name: ref('d', d.terminologyNameColumn),
          category: ref('d', d.categoryColumn),
          subcategory: ref('d', d.subcategoryColumn),
          ...extras,
        }),
      }
    })
  }

  const events = Object.entries(v1.eventTables ?? {})
  if (events.length) {
    const visitColumn = vt?.idColumn
    out.events = events.map(([label, et]): EventSpec => {
      const spec: EventSpec = {
        label,
        from: from(et, 'e'),
        fields: fields({
          patient_id: ref('e', et.patientIdColumn ?? pt?.idColumn),
          concept_id: ref('e', et.conceptIdColumn),
          start_datetime: ref('e', et.dateColumn),
          // v1 named no visit column on an event table: by convention it was the
          // visit table's id column (`visit_occurrence_id`, `hadm_id`).
          visit_id: visitColumn && tableHas(et, visitColumn) ? ref('e', visitColumn) : undefined,
          concept_terminology: ref('e', et.conceptVocabularyColumn),
          concept_code: ref('e', et.conceptCodeColumn),
          source_concept_id: ref('e', et.sourceConceptIdColumn),
          end_datetime: ref('e', et.endDateColumn),
          value_number: ref('e', et.valueColumn),
          value_string: ref('e', et.valueStringColumn),
          unit: ref('e', et.valueUnitColumn ?? et.unitColumn),
          unit_concept_id: ref('e', et.valueUnitConceptIdColumn),
          route: ref('e', et.routeColumn),
          route_concept_id: ref('e', et.routeConceptIdColumn),
        }),
      }
      if (et.conceptDictionaryKey) spec.conceptDictionaryKey = et.conceptDictionaryKey
      return spec
    })
  }

  if (v1.knownTables) out.knownTables = v1.knownTables
  if (v1.ddl) out.ddl = v1.ddl
  if (v1.erdGroups) out.erdGroups = v1.erdGroups
  if (v1.erdLayout) out.erdLayout = v1.erdLayout
  return out
}
