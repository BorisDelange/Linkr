/**
 * The checks a rule set starts with when it is created from a schema.
 *
 * Two sources, written once into the rule set as ordinary checks:
 *  - the DDL — structure, NOT NULL, primary and foreign keys — on the raw tables.
 *    A database of Parquet or CSV files enforces none of these, and OMOP loads
 *    usually skip the constraint scripts, so they are checked, not assumed;
 *  - the schema mapping — what the class relations promise (a visit has a patient
 *    and a start, events happen during life) — on the `linkr_*` relations, so they
 *    follow each database's effective mapping.
 *
 * A mapping check that a DDL check already covers (a contract column read
 * straight from a NOT NULL column, an orphan test a FOREIGN KEY already runs) is
 * left out. Every SQL returns one row of `violated_rows`, `total_rows`, in the
 * dialect DuckDB and PostgreSQL share.
 */
import type { SchemaMapping, RelationTable } from '@/types/schema-mapping'
import type { DqCustomCheck } from '@/types'
import { indexTables, parseDdl, resolveTableRef, type ParsedTable } from '@/lib/ddl-parse'
import { quoteIdent, quoteTableRef } from '@/lib/format-helpers'
import { CLASS_CONTRACTS } from '@/lib/schema-classes/contracts'
import { classRelation, classRelations, drugRelations, eventRelations, has, type ClassRelation } from '@/lib/schema-classes/relations'
import { fieldColumn, specAt } from '@/lib/schema-classes/spec'
import type { DqCategory, DqCheckOrigin, DqSeverity, DqSubcategory } from '@/lib/dq-taxonomy'

export interface DqCheckTemplate {
  templateKey: string
  origin: Exclude<DqCheckOrigin, 'manual'>
  name: string
  description: string
  category: DqCategory
  subcategory: DqSubcategory | null
  severity: DqSeverity
  threshold: number
  tableName: string
  sql: string
  exploreSql: string
}

export type Translate = (key: string, vars?: Record<string, unknown>) => string

const DAYS_AFTER_DEATH = 60

const EXPLORE_LIMIT = 100

/**
 * Rows of `from` (restricted to `scope`) that break `violation`: the count a run
 * scores, and the rows to look at when it fails — one definition, so the two
 * can never disagree.
 */
function rowsBreaking(from: string, violation: string, opts: { scope?: string; select?: string } = {}) {
  const { scope, select = '*' } = opts
  return {
    sql: `SELECT\n  COUNT(*) FILTER (WHERE ${violation})::BIGINT AS violated_rows,\n  COUNT(*)::BIGINT AS total_rows\nFROM ${from}${scope ? `\nWHERE ${scope}` : ''}`,
    exploreSql: `SELECT ${select}\nFROM ${from}\nWHERE ${scope ? `${scope}\n  AND ` : ''}(${violation})\nLIMIT ${EXPLORE_LIMIT}`,
  }
}

/** Rows sharing a key: how many too many, and which keys, most repeated first. */
function duplicatedKeys(from: string, key: string[]) {
  const cols = key.join(', ')
  return {
    sql: `SELECT\n  (COUNT(*) - COUNT(DISTINCT ${key.length === 1 ? cols : `(${cols})`}))::BIGINT AS violated_rows,\n  COUNT(*)::BIGINT AS total_rows\nFROM ${from}`,
    exploreSql: `SELECT ${cols}, COUNT(*) AS n\nFROM ${from}\nGROUP BY ${cols}\nHAVING COUNT(*) > 1\nORDER BY n DESC\nLIMIT ${EXPLORE_LIMIT}`,
  }
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

function refTable(tables: ParsedTable[], from: ParsedTable, ref: string): ParsedTable | undefined {
  const { byQualified, byBare } = indexTables(tables)
  const [schema, table] = ref.includes('.') ? ref.split('.') : [undefined, ref]
  return resolveTableRef(byQualified, byBare, { schema, table }, from.schema)
}

export function ddlCheckTemplates(ddl: string, t: Translate): DqCheckTemplate[] {
  const tables = parseDdl(ddl)
  const out: DqCheckTemplate[] = []
  for (const table of tables) {
    const from = quoteTableRef(table.name)
    if (table.columns.length) {
      out.push({
        templateKey: `ddl.columns:${table.name}`,
        origin: 'ddl',
        name: t('data_quality.tpl.columns_name', { table: table.name }),
        description: t('data_quality.tpl.columns_desc', { table: table.name }),
        category: 'conformance',
        subcategory: 'relational',
        severity: 'error',
        threshold: 0,
        tableName: table.name,
        // Selecting every column binds them all; a missing one fails the query.
        sql: `SELECT\n  0::BIGINT AS violated_rows,\n  1::BIGINT AS total_rows\nFROM (SELECT COUNT(*) AS n FROM (SELECT ${table.columns.map((c) => quoteIdent(c.name)).join(', ')} FROM ${from} LIMIT 0) AS cols) AS bound`,
        // A failure is a missing column: its error names it. The table as it is shows the rest.
        exploreSql: `SELECT *\nFROM ${from}\nLIMIT ${EXPLORE_LIMIT}`,
      })
    }
    for (const col of table.columns.filter((c) => !c.nullable)) {
      out.push({
        templateKey: `ddl.not_null:${table.name}.${col.name}`,
        origin: 'ddl',
        name: t('data_quality.tpl.not_null_name', { column: `${table.name}.${col.name}` }),
        description: t('data_quality.tpl.not_null_desc', { column: col.name, table: table.name }),
        category: 'conformance',
        subcategory: 'relational',
        severity: 'error',
        threshold: 0,
        tableName: table.name,
        ...rowsBreaking(from, `${quoteIdent(col.name)} IS NULL`),
      })
    }
    if (table.pkColumns.length) {
      out.push({
        templateKey: `ddl.primary_key:${table.name}`,
        origin: 'ddl',
        name: t('data_quality.tpl.primary_key_name', { table: table.name }),
        description: t('data_quality.tpl.primary_key_desc', { table: table.name, columns: table.pkColumns.join(', ') }),
        category: 'conformance',
        subcategory: 'relational',
        severity: 'error',
        threshold: 0,
        tableName: table.name,
        ...duplicatedKeys(from, table.pkColumns.map(quoteIdent)),
      })
    }
    for (const fk of table.fks) {
      const target = refTable(tables, table, fk.refTable)
      if (!target || fk.columns.length !== fk.refColumns.length) continue
      const on = fk.columns.map((c, i) => `t.${quoteIdent(c)} = r.${quoteIdent(fk.refColumns[i])}`).join(' AND ')
      out.push({
        templateKey: `ddl.foreign_key:${table.name}(${fk.columns.join(',')})->${target.name}(${fk.refColumns.join(',')})`,
        origin: 'ddl',
        name: t('data_quality.tpl.foreign_key_name', { column: `${table.name}.${fk.columns.join(', ')}`, target: target.name }),
        description: t('data_quality.tpl.foreign_key_desc', { table: table.name, columns: fk.columns.join(', '), target: target.name }),
        category: 'conformance',
        subcategory: 'relational',
        severity: 'error',
        threshold: 0,
        tableName: table.name,
        ...rowsBreaking(
          `${from} t\nLEFT JOIN (SELECT DISTINCT ${fk.refColumns.map(quoteIdent).join(', ')} FROM ${quoteTableRef(target.name)}) r ON ${on}`,
          `r.${quoteIdent(fk.refColumns[0])} IS NULL`,
          { scope: fk.columns.map((c) => `t.${quoteIdent(c)} IS NOT NULL`).join(' AND '), select: 't.*' },
        ),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** What the DDL already guarantees about the tables a relation reads. */
class DdlFacts {
  private readonly tables: ParsedTable[]
  private readonly index: ReturnType<typeof indexTables>

  constructor(ddl: string | undefined) {
    this.tables = ddl ? parseDdl(ddl) : []
    this.index = indexTables(this.tables)
  }

  private table(ref: RelationTable): ParsedTable | undefined {
    return resolveTableRef(this.index.byQualified, this.index.byBare, ref)
  }

  /** The column a relation reads `field` from, when it is its grain table's own. */
  private grainColumn(mapping: SchemaMapping, rel: ClassRelation, field: string) {
    const spec = specAt(mapping, rel.specKey)
    const direct = fieldColumn(spec, field)
    if (!direct || !spec?.from || direct.table.alias !== spec.from.alias) return null
    const table = this.table(direct.table)
    const column = table?.columns.find((c) => c.name.toLowerCase() === direct.column.toLowerCase())
    return table && column ? { table, column, spec } : null
  }

  notNull(mapping: SchemaMapping, rel: ClassRelation, field: string): boolean {
    const g = this.grainColumn(mapping, rel, field)
    return !!g && !g.column.nullable
  }

  /** One row per `field`: its grain column is the whole primary key and no join can repeat rows. */
  unique(mapping: SchemaMapping, rel: ClassRelation, field: string): boolean {
    const g = this.grainColumn(mapping, rel, field)
    if (!g || g.spec.joins?.length) return false
    return g.table.pkColumns.length === 1 && g.table.pkColumns[0].toLowerCase() === g.column.name.toLowerCase()
  }

  /** `child.childField` → `parent.parentField` is a FOREIGN KEY, and the parent relation keeps all its table's rows. */
  foreignKey(mapping: SchemaMapping, child: ClassRelation, childField: string, parent: ClassRelation, parentField: string): boolean {
    const c = this.grainColumn(mapping, child, childField)
    const p = this.grainColumn(mapping, parent, parentField)
    if (!c || !p || p.spec.where?.trim()) return false
    return c.table.fks.some((fk) =>
      fk.columns.length === 1
      && fk.columns[0].toLowerCase() === c.column.name.toLowerCase()
      && refTable(this.tables, c.table, fk.refTable) === p.table
      && fk.refColumns[0].toLowerCase() === p.column.name.toLowerCase(),
    )
  }
}

const GRAIN_ID: Partial<Record<ClassRelation['cls'], string>> = {
  patient: 'patient_id', visit: 'visit_id', visit_detail: 'visit_detail_id', note: 'note_id', concept: 'concept_id',
}

export function mappingCheckTemplates(mapping: SchemaMapping, t: Translate): DqCheckTemplate[] {
  const ddl = new DdlFacts(mapping.ddl)
  const out: DqCheckTemplate[] = []
  const push = (rel: ClassRelation, tpl: Omit<DqCheckTemplate, 'origin' | 'tableName'>) =>
    out.push({ ...tpl, origin: 'mapping', tableName: rel.name })

  const patient = classRelation(mapping, 'patient')
  const visit = classRelation(mapping, 'visit')

  // --- Required contract columns ---
  for (const rel of classRelations(mapping)) {
    for (const col of CLASS_CONTRACTS[rel.cls].filter((c) => c.required)) {
      if (!has(rel, col.name) || ddl.notNull(mapping, rel, col.name)) continue
      push(rel, {
        templateKey: `mapping.required:${rel.name}.${col.name}`,
        name: t('data_quality.tpl.required_name', { column: `${rel.name}.${col.name}` }),
        description: t('data_quality.tpl.required_desc', { column: col.name, relation: rel.name }),
        category: 'conformance',
        subcategory: 'relational',
        severity: 'error',
        threshold: 0,
        ...rowsBreaking(rel.name, `${col.name} IS NULL`),
      })
    }
  }

  // --- One row per id ---
  for (const rel of classRelations(mapping)) {
    const id = GRAIN_ID[rel.cls]
    if (!id || !has(rel, id) || ddl.unique(mapping, rel, id)) continue
    push(rel, {
      templateKey: `mapping.unique:${rel.name}`,
      name: t('data_quality.tpl.unique_name', { relation: rel.name, column: id }),
      description: t('data_quality.tpl.unique_desc', { relation: rel.name, column: id }),
      category: 'plausibility',
      subcategory: 'uniqueness',
      severity: 'error',
      threshold: 0,
      ...duplicatedKeys(rel.name, [id]),
    })
  }

  // --- Records pointing at a patient or a visit that does not exist ---
  const orphan = (child: ClassRelation, field: string, parent: ClassRelation | undefined, parentField: string) => {
    if (!parent || !has(child, field) || !has(parent, parentField)) return
    if (ddl.foreignKey(mapping, child, field, parent, parentField)) return
    push(child, {
      templateKey: `mapping.orphan:${child.name}.${field}->${parent.name}`,
      name: t('data_quality.tpl.orphan_name', { column: `${child.name}.${field}`, target: parent.name }),
      description: t('data_quality.tpl.orphan_desc', { relation: child.name, column: field, target: parent.name }),
      category: 'conformance',
      subcategory: 'relational',
      severity: 'error',
      threshold: 0,
      ...rowsBreaking(
        `${child.name} c\nLEFT JOIN (SELECT DISTINCT ${parentField} FROM ${parent.name}) p ON c.${field} = p.${parentField}`,
        `p.${parentField} IS NULL`,
        { scope: `c.${field} IS NOT NULL`, select: 'c.*' },
      ),
    })
  }
  const events = eventRelations(mapping)
  const visitDetail = classRelation(mapping, 'visit_detail')
  const note = classRelation(mapping, 'note')
  for (const rel of [visit, visitDetail, note, ...events]) {
    if (rel) orphan(rel, 'patient_id', patient, 'patient_id')
  }
  for (const rel of [visitDetail, note, ...events]) {
    if (rel) orphan(rel, 'visit_id', visit, 'visit_id')
  }

  // --- Temporal order: an end never before its start ---
  for (const rel of [visit, visitDetail, ...events]) {
    if (!rel || !has(rel, 'start_datetime') || !has(rel, 'end_datetime')) continue
    push(rel, {
      templateKey: `mapping.end_after_start:${rel.name}`,
      name: t('data_quality.tpl.end_after_start_name', { relation: rel.name }),
      description: t('data_quality.tpl.end_after_start_desc', { relation: rel.name }),
      category: 'plausibility',
      subcategory: 'temporal',
      severity: 'warning',
      threshold: 0,
      ...rowsBreaking(rel.name, 'CAST(end_datetime AS TIMESTAMP) < CAST(start_datetime AS TIMESTAMP)', {
        scope: 'start_datetime IS NOT NULL AND end_datetime IS NOT NULL',
      }),
    })
  }

  // --- During the patient's life ---
  if (patient && has(patient, 'patient_id')) {
    // The exact date when known, else the year: an OMOP birth_datetime is often
    // empty while year_of_birth never is.
    const beforeBirth = has(patient, 'birth_date')
      ? (has(patient, 'birth_year')
          ? 'COALESCE(CAST(e.start_datetime AS TIMESTAMP) < CAST(p.birth_date AS TIMESTAMP), EXTRACT(YEAR FROM CAST(e.start_datetime AS TIMESTAMP)) < p.birth_year)'
          : 'CAST(e.start_datetime AS TIMESTAMP) < CAST(p.birth_date AS TIMESTAMP)')
      : has(patient, 'birth_year') ? 'EXTRACT(YEAR FROM CAST(e.start_datetime AS TIMESTAMP)) < p.birth_year' : null
    const afterDeath = has(patient, 'death_datetime')
      ? `CAST(e.start_datetime AS TIMESTAMP) > CAST(p.death_datetime AS TIMESTAMP) + INTERVAL '${DAYS_AFTER_DEATH} days'`
      : null
    const withPatient = (rel: ClassRelation) => `${rel.name} e\nJOIN ${patient.name} p ON e.patient_id = p.patient_id`
    const lifeColumns = 'e.*, p.birth_date, p.birth_year, p.death_datetime'
    const during = (rel: ClassRelation, key: string, where: string, extra: Record<string, unknown> = {}) => push(rel, {
      templateKey: `mapping.${key}:${rel.name}`,
      name: t(`data_quality.tpl.${key}_name`, { relation: rel.name, ...extra }),
      description: t(`data_quality.tpl.${key}_desc`, { relation: rel.name, ...extra }),
      category: 'plausibility',
      subcategory: 'temporal',
      severity: 'error',
      threshold: 0,
      ...rowsBreaking(withPatient(rel), where, { scope: 'e.start_datetime IS NOT NULL', select: lifeColumns }),
    })
    for (const rel of [visit, visitDetail, ...events]) {
      if (!rel || !has(rel, 'start_datetime') || !has(rel, 'patient_id')) continue
      if (beforeBirth) during(rel, 'after_birth', beforeBirth)
      if (afterDeath) during(rel, 'before_death', afterDeath, { days: DAYS_AFTER_DEATH })
    }

    // --- Plausible age at the visit ---
    if (visit && has(visit, 'start_datetime') && has(patient, 'birth_year')) {
      const byYear = 'EXTRACT(YEAR FROM CAST(e.start_datetime AS TIMESTAMP)) - p.birth_year'
      const age = has(patient, 'birth_date')
        ? `COALESCE(EXTRACT(YEAR FROM AGE(CAST(e.start_datetime AS TIMESTAMP), CAST(p.birth_date AS TIMESTAMP))), ${byYear})`
        : byYear
      push(visit, {
        templateKey: `mapping.plausible_age:${visit.name}`,
        name: t('data_quality.tpl.plausible_age_name'),
        description: t('data_quality.tpl.plausible_age_desc', { relation: visit.name }),
        category: 'plausibility',
        subcategory: 'atemporal',
        severity: 'error',
        threshold: 0,
        ...rowsBreaking(withPatient(visit), `${age} < 0 OR ${age} > 130`, { scope: 'e.start_datetime IS NOT NULL', select: lifeColumns }),
      })
    }
  }

  // --- Events: codes mapped, values with a unit ---
  for (const rel of events) {
    // concept_id 0 means "no standard concept" only where the relation also
    // keeps the source code apart (OMOP); elsewhere 0 is just an id.
    if (has(rel, 'concept_id') && has(rel, 'source_concept_id')) {
      push(rel, {
        templateKey: `mapping.concept_mapped:${rel.name}`,
        name: t('data_quality.tpl.concept_mapped_name', { relation: rel.name }),
        description: t('data_quality.tpl.concept_mapped_desc', { relation: rel.name }),
        category: 'completeness',
        subcategory: null,
        severity: 'warning',
        threshold: 5,
        ...rowsBreaking(rel.name, 'concept_id = 0'),
      })
    }
    if (has(rel, 'value_number') && has(rel, 'unit')) {
      push(rel, {
        templateKey: `mapping.value_unit:${rel.name}`,
        name: t('data_quality.tpl.value_unit_name', { relation: rel.name }),
        description: t('data_quality.tpl.value_unit_desc', { relation: rel.name }),
        category: 'completeness',
        subcategory: null,
        severity: 'warning',
        threshold: 5,
        ...rowsBreaking(rel.name, "unit IS NULL OR TRIM(CAST(unit AS VARCHAR)) = ''", { scope: 'value_number IS NOT NULL' }),
      })
    }
  }

  // --- Drugs: no negative dose ---
  for (const rel of drugRelations(mapping)) {
    const doses = ['quantity', 'amount_value', 'rate_value'].filter((c) => has(rel, c))
    if (!doses.length) continue
    push(rel, {
      templateKey: `mapping.dose_positive:${rel.name}`,
      name: t('data_quality.tpl.dose_positive_name', { relation: rel.name }),
      description: t('data_quality.tpl.dose_positive_desc', { relation: rel.name, columns: doses.join(', ') }),
      category: 'plausibility',
      subcategory: 'atemporal',
      severity: 'warning',
      threshold: 0,
      ...rowsBreaking(rel.name, doses.map((c) => `${c} < 0`).join(' OR ')),
    })
  }

  return out
}

/** Every check a rule set created from this schema starts with, DDL first. */
export function schemaCheckTemplates(mapping: SchemaMapping, t: Translate): DqCheckTemplate[] {
  const all = [...(mapping.ddl ? ddlCheckTemplates(mapping.ddl, t) : []), ...mappingCheckTemplates(mapping, t)]
  const seen = new Set<string>()
  return all.filter((c) => !seen.has(c.templateKey) && !!seen.add(c.templateKey))
}

// ---------------------------------------------------------------------------
// Stored checks
// ---------------------------------------------------------------------------

type CheckFields = Pick<DqCustomCheck, 'name' | 'description' | 'category' | 'subcategory' | 'severity' | 'threshold' | 'sql' | 'exploreSql' | 'origin' | 'templateKey' | 'tableName'>

/** A stored check, keys in the order the server's response has them. */
export function makeCheck(ruleSetId: string, order: number, fields: CheckFields, now = new Date().toISOString()): DqCustomCheck {
  return {
    id: crypto.randomUUID(),
    ruleSetId,
    name: fields.name,
    description: fields.description,
    category: fields.category,
    subcategory: fields.subcategory,
    severity: fields.severity,
    threshold: fields.threshold,
    sql: fields.sql,
    exploreSql: fields.exploreSql,
    order,
    origin: fields.origin,
    templateKey: fields.templateKey,
    tableName: fields.tableName,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function checksFromTemplates(ruleSetId: string, templates: DqCheckTemplate[], firstOrder = 0): DqCustomCheck[] {
  const now = new Date().toISOString()
  return templates.map((tpl, i) => makeCheck(ruleSetId, firstOrder + i, tpl, now))
}
