import { describe, expect, it } from 'vitest'
import { resolveRolePrefixes, usedRoles } from './role-prefix'

const SCHEMAS = { source: 'ds_mimic_raw', target: 'ds_omop', vocab: 'ds_athena' }

describe('resolveRolePrefixes', () => {
  it('rewrites both roles to their quoted schema', () => {
    expect(resolveRolePrefixes('SELECT * FROM source.patients', SCHEMAS))
      .toBe('SELECT * FROM "ds_mimic_raw".patients')
    expect(resolveRolePrefixes('INSERT INTO target.person VALUES (1)', SCHEMAS))
      .toBe('INSERT INTO "ds_omop".person VALUES (1)')
  })

  it('handles the cross-database ETL statement', () => {
    expect(resolveRolePrefixes(
      'INSERT INTO target.person SELECT subject_id FROM source.patients;',
      SCHEMAS,
    )).toBe('INSERT INTO "ds_omop".person SELECT subject_id FROM "ds_mimic_raw".patients;')
  })

  it('is case-insensitive on the role but keeps the table name', () => {
    expect(resolveRolePrefixes('SELECT * FROM SOURCE.Patients', SCHEMAS))
      .toBe('SELECT * FROM "ds_mimic_raw".Patients')
  })

  it('rewrites after punctuation and across newlines', () => {
    expect(resolveRolePrefixes('SELECT * FROM (source.a JOIN target.b ON 1=1)', SCHEMAS))
      .toBe('SELECT * FROM ("ds_mimic_raw".a JOIN "ds_omop".b ON 1=1)')
    expect(resolveRolePrefixes('SELECT *\nFROM\n  source.patients', SCHEMAS))
      .toBe('SELECT *\nFROM\n  "ds_mimic_raw".patients')
  })

  it('leaves identifiers that merely contain a role name', () => {
    expect(resolveRolePrefixes('SELECT * FROM my_source.patients', SCHEMAS))
      .toBe('SELECT * FROM my_source.patients')
    expect(resolveRolePrefixes('SELECT source_id FROM t', SCHEMAS))
      .toBe('SELECT source_id FROM t')
    expect(resolveRolePrefixes('SELECT a.target.b FROM t', SCHEMAS))
      .toBe('SELECT a.target.b FROM t')
  })

  it('never rewrites inside string literals', () => {
    expect(resolveRolePrefixes("SELECT 'source.patients' AS s", SCHEMAS))
      .toBe("SELECT 'source.patients' AS s")
    expect(resolveRolePrefixes("SELECT 'it''s source.x', source.y", SCHEMAS))
      .toBe("SELECT 'it''s source.x', \"ds_mimic_raw\".y")
  })

  it('never rewrites inside comments', () => {
    expect(resolveRolePrefixes('-- read source.patients\nSELECT * FROM source.a', SCHEMAS))
      .toBe('-- read source.patients\nSELECT * FROM "ds_mimic_raw".a')
    expect(resolveRolePrefixes('/* source.x */ SELECT * FROM target.y', SCHEMAS))
      .toBe('/* source.x */ SELECT * FROM "ds_omop".y')
  })

  it('leaves an already-qualified schema alone', () => {
    expect(resolveRolePrefixes('SELECT * FROM "ds_other".source.x', SCHEMAS))
      .toBe('SELECT * FROM "ds_other".source.x')
  })

  it('leaves a role with no bound schema so the SQL error names it', () => {
    expect(resolveRolePrefixes('SELECT * FROM source.a, target.b', { target: 'ds_omop' }))
      .toBe('SELECT * FROM source.a, "ds_omop".b')
    expect(resolveRolePrefixes('SELECT * FROM source.a', {}))
      .toBe('SELECT * FROM source.a')
  })

  it('rewrites the vocab role (ATHENA reference of the mapping project)', () => {
    expect(resolveRolePrefixes('INSERT INTO concept SELECT c.* FROM vocab.concept c', SCHEMAS))
      .toBe('INSERT INTO concept SELECT c.* FROM "ds_athena".concept c')
  })

  it('does not mistake `vocabulary.` for the vocab role', () => {
    // The generated script also writes a bare `vocabulary` table on the target.
    expect(resolveRolePrefixes('SELECT * FROM vocabulary.x', SCHEMAS))
      .toBe('SELECT * FROM vocabulary.x')
    expect(resolveRolePrefixes('DELETE FROM vocabulary;', SCHEMAS))
      .toBe('DELETE FROM vocabulary;')
  })

  it('handles all three roles in one script', () => {
    expect(resolveRolePrefixes(
      'INSERT INTO target.concept SELECT c.* FROM vocab.concept c JOIN source.d_items d ON 1=1',
      SCHEMAS,
    )).toBe('INSERT INTO "ds_omop".concept SELECT c.* FROM "ds_athena".concept c JOIN "ds_mimic_raw".d_items d ON 1=1')
  })

  it('rewrites every occurrence, not just the first', () => {
    expect(resolveRolePrefixes('SELECT * FROM source.a UNION SELECT * FROM source.b', SCHEMAS))
      .toBe('SELECT * FROM "ds_mimic_raw".a UNION SELECT * FROM "ds_mimic_raw".b')
  })

  it('does not rewrite inside a dollar-quoted block', () => {
    expect(resolveRolePrefixes('SELECT $$ source.x $$, source.a', SCHEMAS))
      .toBe('SELECT $$ source.x $$, "ds_mimic_raw".a')
  })

  // A sequence is named by a string, so the qualifier rule skips it: the demo
  // ETL's first script failed in the browser on nextval('target.seq_row_id').
  it("rewrites the role naming a sequence in nextval('…') and currval('…')", () => {
    expect(resolveRolePrefixes("SELECT nextval('target.seq_row_id'), currval( 'target.seq_row_id')", SCHEMAS))
      .toBe("SELECT nextval('ds_omop.seq_row_id'), currval( 'ds_omop.seq_row_id')")
    expect(resolveRolePrefixes("SELECT NEXTVAL('Source.s')", SCHEMAS))
      .toBe("SELECT NEXTVAL('ds_mimic_raw.s')")
  })

  it('leaves any other literal, a commented call and an unbound role alone', () => {
    expect(resolveRolePrefixes("SELECT concat('target.seq_row_id')", SCHEMAS))
      .toBe("SELECT concat('target.seq_row_id')")
    expect(resolveRolePrefixes("-- nextval('target.s')\nSELECT 1", SCHEMAS))
      .toBe("-- nextval('target.s')\nSELECT 1")
    expect(resolveRolePrefixes("SELECT nextval('target.s')", {}))
      .toBe("SELECT nextval('target.s')")
  })

  it('an escaped quote does not disable rewriting for the rest of the script', () => {
    // The `\'` must not be read as opening a literal that swallows source.a.
    expect(resolveRolePrefixes("SELECT E'\\'' AS q, source.a", SCHEMAS))
      .toBe("SELECT E'\\'' AS q, \"ds_mimic_raw\".a")
  })
})

describe('resolveRolePrefixes — server mode', () => {
  // '' marks the database the query is already sent to: the qualifier must go
  // away entirely, because `ds_<alias>` does not exist server-side.
  it('drops the qualifier of the database being queried', () => {
    expect(resolveRolePrefixes('DELETE FROM target.source_to_concept_map;', { target: '' }))
      .toBe('DELETE FROM source_to_concept_map;')
    expect(resolveRolePrefixes('SELECT * FROM (target.a JOIN target.b ON 1=1)', { target: '' }))
      .toBe('SELECT * FROM (a JOIN b ON 1=1)')
  })

  it("drops the role naming a sequence of the database being queried", () => {
    expect(resolveRolePrefixes("SELECT nextval('target.seq_row_id')", { target: '' }))
      .toBe("SELECT nextval('seq_row_id')")
  })

  it('leaves the other roles untouched so the error names the role', () => {
    expect(resolveRolePrefixes('INSERT INTO target.c SELECT * FROM vocab.concept', { target: '' }))
      .toBe('INSERT INTO c SELECT * FROM vocab.concept')
  })
})

describe('usedRoles', () => {
  it('reports the roles a script actually qualifies', () => {
    expect(usedRoles('SELECT * FROM source.a')).toEqual(['source'])
    expect(usedRoles('INSERT INTO target.p SELECT * FROM source.a')).toEqual(['source', 'target'])
    expect(usedRoles('INSERT INTO target.c SELECT * FROM vocab.concept')).toEqual(['target', 'vocab'])
    expect(usedRoles('SELECT 1')).toEqual([])
  })

  it('ignores roles inside literals, comments and longer identifiers', () => {
    expect(usedRoles("SELECT 'source.x'")).toEqual([])
    expect(usedRoles('-- source.x')).toEqual([])
    expect(usedRoles('SELECT * FROM my_source.x')).toEqual([])
  })

  it("counts a role named only in a sequence function's argument", () => {
    // The runner tests the connection of every used role before running.
    expect(usedRoles("SELECT nextval('target.seq_row_id')")).toEqual(['target'])
    expect(usedRoles("INSERT INTO target.p SELECT currval( 'vocab.s' ) FROM source.a"))
      .toEqual(['source', 'target', 'vocab'])
    expect(usedRoles("-- nextval('target.s')")).toEqual([])
    expect(usedRoles("SELECT 'nextval(''target.s'')'")).toEqual([])
  })
})
