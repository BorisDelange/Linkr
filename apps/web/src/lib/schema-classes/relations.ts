import type { ConceptDictionary, EventTable, SchemaMapping } from '@/types/schema-mapping'
import { escSql, isSafeIdentifier } from '@/lib/format-helpers'
import { birthYearSql, qualify, qualifyIn } from '@/lib/schema-helpers'
import { CLASS_CONTRACTS, RELATION_PREFIX, type ClassName } from './contracts'

/**
 * One class relation: a SELECT honouring its class contract, and the name
 * queries reach it by. The only place mapping fields turn into SQL — every
 * consumer reads the contract columns (plan §6, "What this centralises").
 */
export interface ClassRelation {
  name: string
  cls: ClassName
  /** Concept dictionary key, or event-table label (v1 `eventTables` key). */
  key?: string
  sql: string
  /** Contract columns that carry data; the others are emitted as NULL. */
  mapped: ReadonlySet<string>
  /** Event: relation name of its concept dictionary; null when the event names
   *  its concepts inline (`conceptDictionaryKey: 'none'`). */
  dictionary?: string | null
  /** Event: joins its dictionary on (concept_terminology, concept_code) rather
   *  than concept_id — a thesaurus where a code is only unique per terminology. */
  compositeConceptKey?: boolean
  /** Concept: `extra_<alias>` columns, keyed by the mapping's alias. */
  extras?: Readonly<Record<string, string>>
}

const cache = new WeakMap<SchemaMapping, ClassRelation[]>()

/** Every relation the mapping defines. Memoised per mapping object. */
export function classRelations(mapping: SchemaMapping): ClassRelation[] {
  let rels = cache.get(mapping)
  if (!rels) {
    rels = buildRelations(mapping)
    cache.set(mapping, rels)
  }
  return rels
}

export function classRelation(mapping: SchemaMapping, cls: 'patient' | 'visit' | 'visit_detail' | 'note'): ClassRelation | undefined {
  return classRelations(mapping).find((r) => r.cls === cls)
}

export function eventRelations(mapping: SchemaMapping): ClassRelation[] {
  return classRelations(mapping).filter((r) => r.cls === 'event')
}

export function conceptRelations(mapping: SchemaMapping): ClassRelation[] {
  return classRelations(mapping).filter((r) => r.cls === 'concept')
}

/** The relation of the event table the mapping labels `label`. */
export function eventRelation(mapping: SchemaMapping, label: string): ClassRelation | undefined {
  return eventRelations(mapping).find((r) => r.key === label)
}

export function conceptRelation(mapping: SchemaMapping, key: string): ClassRelation | undefined {
  return conceptRelations(mapping).find((r) => r.key === key)
}

/** The concept dictionary an event relation joins, if any. */
export function dictionaryOf(mapping: SchemaMapping, event: ClassRelation): ClassRelation | undefined {
  if (!event.dictionary) return undefined
  return classRelations(mapping).find((r) => r.name === event.dictionary)
}

/** ON clause joining an event relation (alias `e`) to its dictionary (alias `c`). */
export function conceptJoinOn(event: ClassRelation, e: string, c: string): string {
  return event.compositeConceptKey
    ? `${e}.concept_terminology = ${c}.concept_terminology AND ${e}.concept_code = ${c}.concept_code`
    : `${e}.concept_id = ${c}.concept_id`
}

/** Is this contract column filled by the relation? */
export function has(rel: ClassRelation | undefined, column: string): boolean {
  return !!rel && rel.mapped.has(column)
}

// ---------------------------------------------------------------------------
// Generation from the v1 mapping blocks
// ---------------------------------------------------------------------------

type Exprs = Record<string, string | null | undefined>

/** `SELECT <contract columns> FROM …`, one line per column, NULL where unmapped. */
function select(cls: ClassName, exprs: Exprs, from: string): { sql: string; mapped: Set<string> } {
  const mapped = new Set<string>()
  const lines = CLASS_CONTRACTS[cls].map(({ name }) => {
    const expr = exprs[name]
    if (expr) mapped.add(name)
    return `  ${expr ?? 'NULL'} AS ${name}`
  })
  return { sql: `SELECT\n${lines.join(',\n')}\nFROM ${from}`, mapped }
}

const c = (alias: string, column: string | undefined): string | null => (column ? `${alias}."${column}"` : null)

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table'
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  taken.add(name)
  return name
}

function buildRelations(mapping: SchemaMapping): ClassRelation[] {
  const rels: ClassRelation[] = []
  const taken = new Set<string>()
  const push = (rel: ClassRelation) => {
    taken.add(rel.name)
    rels.push(rel)
  }

  const patient = patientRelation(mapping)
  if (patient) push(patient)
  const visit = visitRelation(mapping)
  if (visit) push(visit)
  const visitDetail = visitDetailRelation(mapping)
  if (visitDetail) push(visitDetail)
  const note = noteRelation(mapping)
  if (note) push(note)

  const dictNames = new Map<string, string>()
  for (const dict of mapping.conceptTables ?? []) {
    const name = uniqueName(`${RELATION_PREFIX}concept_${slug(dict.key)}`, taken)
    dictNames.set(dict.key, name)
    rels.push(conceptRelation1(dict, name))
  }

  const defaultDict = mapping.conceptTables?.[0]
  for (const [label, et] of Object.entries(mapping.eventTables ?? {})) {
    const dict =
      et.conceptDictionaryKey === 'none'
        ? undefined
        : et.conceptDictionaryKey
          ? mapping.conceptTables?.find((d) => d.key === et.conceptDictionaryKey)
          : defaultDict
    const name = uniqueName(`${RELATION_PREFIX}event_${slug(label)}`, taken)
    rels.push(eventRelation1(mapping, label, et, dict, name, dict ? (dictNames.get(dict.key) ?? null) : null))
  }
  return rels
}

function patientRelation(mapping: SchemaMapping): ClassRelation | null {
  const pt = mapping.patientTable
  if (!pt) return null
  const birthDateYear = pt.birthDateColumn ? `DATE_PART('year', p."${pt.birthDateColumn}"::TIMESTAMP)` : null
  const yearCol = birthYearSql(pt, 'p')
  // Birth date first: in OMOP `year_of_birth` is NOT NULL but `birth_datetime` is
  // frequently empty, so the precise column alone leaves most ages NULL.
  const birthYear = birthDateYear && yearCol ? `COALESCE(${birthDateYear}, ${yearCol})` : (birthDateYear ?? yearCol)

  const gv = mapping.genderValues
  const genderCol = c('p', pt.genderColumn)
  const gender =
    genderCol && gv
      ? `CASE WHEN ${genderCol} IS NULL THEN NULL WHEN CAST(${genderCol} AS VARCHAR) = '${escSql(gv.male)}' THEN 'male' WHEN CAST(${genderCol} AS VARCHAR) = '${escSql(gv.female)}' THEN 'female' ELSE 'unknown' END`
      : null

  // A death table is read through MIN(): a JOIN would duplicate a patient who
  // has more than one death row.
  const dt = mapping.deathTable
  const death =
    c('p', pt.deathDateColumn) ??
    (dt ? `(SELECT MIN(_d."${dt.dateColumn}") FROM ${qualify(dt)} _d WHERE _d."${dt.patientIdColumn}" = p."${pt.idColumn}")` : null)

  const { sql, mapped } = select(
    'patient',
    {
      patient_id: c('p', pt.idColumn),
      birth_date: c('p', pt.birthDateColumn),
      birth_year: birthYear,
      gender,
      gender_source_value: genderCol,
      death_datetime: death,
    },
    `${qualify(pt)} p`,
  )
  return { name: `${RELATION_PREFIX}patient`, cls: 'patient', sql, mapped }
}

function visitRelation(mapping: SchemaMapping): ClassRelation | null {
  const vt = mapping.visitTable
  if (!vt) return null
  const hasLookup = !!(vt.careSiteColumn && vt.careSiteNameTable && vt.careSiteNameIdColumn && vt.careSiteNameColumn)
  const join = hasLookup
    ? `\nLEFT JOIN ${qualifyIn(vt, vt.careSiteNameTable)} cs ON v."${vt.careSiteColumn}" = cs."${vt.careSiteNameIdColumn}"`
    : ''
  const { sql, mapped } = select(
    'visit',
    {
      visit_id: c('v', vt.idColumn),
      patient_id: c('v', vt.patientIdColumn),
      start_datetime: c('v', vt.startDateColumn),
      end_datetime: c('v', vt.endDateColumn),
      visit_type: c('v', vt.typeColumn),
      care_site_id: c('v', vt.careSiteColumn),
      care_site_name: hasLookup ? c('cs', vt.careSiteNameColumn) : null,
    },
    `${qualify(vt)} v${join}`,
  )
  return { name: `${RELATION_PREFIX}visit`, cls: 'visit', sql, mapped }
}

function visitDetailRelation(mapping: SchemaMapping): ClassRelation | null {
  const vdt = mapping.visitDetailTable
  if (!vdt) return null
  const hasLookup = !!(vdt.unitColumn && vdt.unitNameTable && vdt.unitNameIdColumn && vdt.unitNameColumn)
  const join = hasLookup
    ? `\nLEFT JOIN ${qualifyIn(vdt, vdt.unitNameTable)} un ON vd."${vdt.unitColumn}" = un."${vdt.unitNameIdColumn}"`
    : ''
  // The ward, in order of clinical usefulness: the verbatim source value, then
  // the looked-up name, then the raw column — a name on MIMIC, an id on OMOP.
  const candidates = [c('vd', vdt.unitSourceValueColumn), hasLookup ? c('un', vdt.unitNameColumn) : null, c('vd', vdt.unitColumn)]
    .filter((x): x is string => !!x)
    .map((x) => `NULLIF(CAST(${x} AS VARCHAR), '')`)
  // The looked-up name groups wards of the same kind.
  const category = hasLookup ? `CAST(un."${vdt.unitNameColumn}" AS VARCHAR)` : vdt.unitColumn ? `CAST(vd."${vdt.unitColumn}" AS VARCHAR)` : null
  const { sql, mapped } = select(
    'visit_detail',
    {
      visit_detail_id: c('vd', vdt.idColumn),
      visit_id: c('vd', vdt.visitIdColumn),
      patient_id: c('vd', vdt.patientIdColumn),
      start_datetime: c('vd', vdt.startDateColumn),
      end_datetime: c('vd', vdt.endDateColumn),
      unit_id: c('vd', vdt.unitColumn),
      unit_name: candidates.length ? `COALESCE(${candidates.join(', ')})` : null,
      unit_category: category,
    },
    `${qualify(vdt)} vd${join}`,
  )
  return { name: `${RELATION_PREFIX}visit_detail`, cls: 'visit_detail', sql, mapped }
}

function noteRelation(mapping: SchemaMapping): ClassRelation | null {
  const nt = mapping.noteTable
  if (!nt) return null
  const { sql, mapped } = select(
    'note',
    {
      note_id: c('n', nt.idColumn),
      patient_id: c('n', nt.patientIdColumn),
      visit_id: c('n', nt.visitIdColumn),
      note_datetime: c('n', nt.dateColumn),
      title: c('n', nt.titleColumn),
      text: c('n', nt.textColumn),
      note_type: c('n', nt.typeColumn),
    },
    `${qualify(nt)} n`,
  )
  return { name: `${RELATION_PREFIX}note`, cls: 'note', sql, mapped }
}

function conceptRelation1(dict: ConceptDictionary, name: string): ClassRelation {
  const extras: Record<string, string> = {}
  const extraLines: string[] = []
  for (const [alias, column] of Object.entries(dict.extraColumns ?? {})) {
    // The alias becomes a column name here, unlike before, so it is checked like
    // one; `sanitizeSchemaMapping` only vets the values.
    if (!isSafeIdentifier(alias)) continue
    extras[alias] = `extra_${alias}`
    extraLines.push(`  d."${column}" AS "extra_${alias}"`)
  }
  const { sql, mapped } = select(
    'concept',
    {
      // A code-only dictionary (MIMIC d_icd_diagnoses) is keyed by its code.
      concept_id: c('d', dict.idColumn ?? dict.codeColumn),
      concept_terminology: c('d', dict.vocabularyColumn ?? dict.terminologyIdColumn),
      concept_name: c('d', dict.nameColumn),
      concept_code: c('d', dict.codeColumn),
      terminology_id: c('d', dict.terminologyIdColumn ?? dict.vocabularyColumn),
      terminology_name: c('d', dict.terminologyNameColumn),
      category: c('d', dict.categoryColumn),
      subcategory: c('d', dict.subcategoryColumn),
    },
    `${qualify(dict)} d`,
  )
  const withExtras = extraLines.length ? sql.replace(/\nFROM /, `,\n${extraLines.join(',\n')}\nFROM `) : sql
  return { name, cls: 'concept', key: dict.key, sql: withExtras, mapped, extras }
}

function eventRelation1(
  mapping: SchemaMapping,
  label: string,
  et: EventTable,
  dict: ConceptDictionary | undefined,
  name: string,
  dictionary: string | null,
): ClassRelation {
  const legacyUnit = (et as EventTable & { unitColumn?: string }).unitColumn
  // v1 names no visit column on an event table: by convention it is the visit
  // table's id column (`visit_occurrence_id`, `hadm_id`), which not every event
  // table has. An empty UNION BY NAME branch pads the column with NULLs where it
  // is missing, so the relation binds either way.
  const visitIdCol = mapping.visitTable?.idColumn
  const from = visitIdCol
    ? `(SELECT * FROM ${qualify(et)} UNION ALL BY NAME SELECT NULL AS "${visitIdCol}" WHERE false) e`
    : `${qualify(et)} e`
  const composite = !!(et.conceptVocabularyColumn && et.conceptCodeColumn && dict?.vocabularyColumn && dict.codeColumn)

  const { sql, mapped } = select(
    'event',
    {
      patient_id: c('e', et.patientIdColumn ?? mapping.patientTable?.idColumn),
      concept_id: c('e', et.conceptIdColumn),
      start_datetime: c('e', et.dateColumn),
      visit_id: c('e', visitIdCol),
      concept_terminology: c('e', et.conceptVocabularyColumn),
      concept_code: c('e', et.conceptCodeColumn),
      source_concept_id: c('e', et.sourceConceptIdColumn),
      concept_name: et.conceptDictionaryKey === 'none' ? `CAST(e."${et.conceptIdColumn}" AS VARCHAR)` : null,
      end_datetime: c('e', et.endDateColumn),
      value_number: c('e', et.valueColumn),
      value_string: c('e', et.valueStringColumn),
      unit: c('e', et.valueUnitColumn ?? legacyUnit),
      unit_concept_id: c('e', et.valueUnitConceptIdColumn),
      route: c('e', et.routeColumn),
      route_concept_id: c('e', et.routeConceptIdColumn),
    },
    from,
  )
  // The padded visit column is a guess, not a mapping: never advertise it.
  mapped.delete('visit_id')
  return { name, cls: 'event', key: label, sql, mapped, dictionary, compositeConceptKey: composite }
}
