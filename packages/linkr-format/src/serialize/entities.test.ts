import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { detectTreeKind, validateEntity } from '../validate/entities.js'
import { serializeEntity, type EntitySpecMap, type SerializableEntityKind } from './entities.js'

function treeOf<K extends SerializableEntityKind>(kind: K, spec: EntitySpecMap[K]): MemoryTree {
  return new MemoryTree(Object.fromEntries(serializeEntity(kind, spec).map((f) => [f.path, f.content])))
}

const SPECS: { [K in SerializableEntityKind]: EntitySpecMap[K] } = {
  'sql-collection': {
    name: { en: 'Cohort queries', fr: 'Requêtes de cohorte' },
    files: [
      { path: 'top.sql', content: 'SELECT 1;\n' },
      { path: 'queries/cohort.sql', content: 'SELECT person_id FROM person;\n' },
    ],
  },
  'etl-pipeline': {
    name: { en: 'MIMIC → OMOP' },
    files: [{ path: 'etl/01_person.sql', content: 'INSERT INTO person SELECT 1;\n' }],
  },
  'dq-rule-set': {
    name: { en: 'ICU data quality' },
    checks: [
      { name: 'Non-null person id', sql: 'SELECT COUNT(*) FROM person WHERE person_id IS NULL;' },
    ],
  },
  'data-catalog': {
    name: { en: 'ICU catalog' },
    dimensions: ['age', 'sex'],
  },
  'mapping-project': {
    name: { en: 'MIMIC-IV → OMOP' },
    mappings: [
      { sourceConceptCode: '220045', sourceConceptName: 'Heart Rate', targetConceptId: 3027018, status: 'approved' },
    ],
  },
  'schema-preset': {
    presetId: 'omop-cdm-5-4',
    presetLabel: { en: 'OMOP CDM 5.4', fr: 'OMOP CDM 5.4' },
    eventTables: {
      Measurement: {
        table: 'measurement',
        conceptIdColumn: 'measurement_concept_id',
        dateColumn: 'measurement_datetime',
        valueColumn: 'value_as_number',
      },
    },
    mapping: {
      patientTable: { table: 'person', idColumn: 'person_id' },
    },
    ddl: 'CREATE TABLE person (person_id INTEGER);\n',
  },
}

describe('serializeEntity', () => {
  // The loop that matters: anything written here must pass the same checks an
  // externally authored tree is held to.
  for (const kind of Object.keys(SPECS) as SerializableEntityKind[]) {
    it(`${kind}: produces a tree its own validator accepts`, () => {
      const tree = treeOf(kind, SPECS[kind])
      expect(detectTreeKind(tree)).toBe(kind)
      expect(validateEntity(tree, kind)).toEqual([])
    })

    it(`${kind}: is deterministic`, () => {
      expect(serializeEntity(kind, SPECS[kind])).toEqual(serializeEntity(kind, SPECS[kind]))
    })

    it(`${kind}: writes JSON with no trailing newline, like the app`, () => {
      // Byte-parity with `entity-io.ts`'s `json` (JSON.stringify(x, null, 2), no
      // trailing newline) and the server's `export_json`. A newline here means the
      // first sync after installing an authored tree commits a diff that only
      // removes it — a commit for nothing, on every entity.
      for (const file of serializeEntity(kind, SPECS[kind])) {
        if (!file.path.endsWith('.json') || typeof file.content !== 'string') continue
        expect(file.content.endsWith('\n'), `${file.path} ends with a newline`).toBe(false)
        expect(file.content).toBe(JSON.stringify(JSON.parse(file.content), null, 2))
      }
    })
  }

  it('declares every parent folder in the tree', () => {
    const tree = treeOf('sql-collection', SPECS['sql-collection'])
    const entries = JSON.parse(tree.read('_tree.json')!) as { path: string; type: string }[]
    // Without the folder entry the import reparents the file to the root.
    expect(entries).toContainEqual(expect.objectContaining({ path: 'queries', type: 'folder' }))
    expect(entries.map((e) => e.path)).toContain('queries/cohort.sql')
  })

  it('derives a script language from its extension', () => {
    const tree = treeOf('etl-pipeline', SPECS['etl-pipeline'])
    const entries = JSON.parse(tree.read('_tree.json')!) as { path: string; language?: string }[]
    expect(entries.find((e) => e.path.endsWith('.sql'))?.language).toBe('sql')
  })

  it('sorts mappings by source code so a re-export is byte-stable', () => {
    const one = serializeEntity('mapping-project', {
      name: { en: 'M' },
      mappings: [{ sourceConceptCode: 'b' }, { sourceConceptCode: 'a' }],
    })
    const two = serializeEntity('mapping-project', {
      name: { en: 'M' },
      mappings: [{ sourceConceptCode: 'a' }, { sourceConceptCode: 'b' }],
    })
    expect(one).toEqual(two)
  })

  it('defaults a mapping with no status to pending, not approved', () => {
    // An approved mapping with no target is an error; defaulting to approved
    // would manufacture that failure for every unreviewed row.
    const tree = treeOf('mapping-project', {
      name: { en: 'M' },
      mappings: [{ sourceConceptCode: 'x' }],
    })
    const mappings = JSON.parse(tree.read('mappings.json')!) as { status: string }[]
    expect(mappings[0].status).toBe('pending')
    expect(validateEntity(tree, 'mapping-project')).toEqual([])
  })

  it('writes checks in declaration order', () => {
    const tree = treeOf('dq-rule-set', {
      name: { en: 'DQ' },
      checks: [
        { name: 'first', sql: 'SELECT 1;' },
        { name: 'second', sql: 'SELECT 2;' },
      ],
    })
    const checks = JSON.parse(tree.read('checks.json')!) as { name: string; order: number }[]
    expect(checks.map((c) => [c.name, c.order])).toEqual([['first', 0], ['second', 1]])
  })

  it('refuses a kind it cannot serialize', () => {
    expect(() => serializeEntity('cohort' as SerializableEntityKind, SPECS['data-catalog'] as never))
      .toThrow(/Cannot serialize/)
  })

  describe('schema-preset', () => {
    it('writes the DDL to its own file, never inline in the mapping', () => {
      // A 50k blob on one JSON line makes every preset diff unreadable, so the
      // validator warns about an inline `mapping.ddl` — writing one would be
      // producing a tree our own checks flag.
      const tree = treeOf('schema-preset', SPECS['schema-preset'])
      expect(tree.read('schema.ddl')).toBe('CREATE TABLE person (person_id INTEGER);\n')
      const preset = JSON.parse(tree.read('preset.json')!) as { mapping: Record<string, unknown> }
      expect(preset.mapping.ddl).toBeUndefined()
    })

    it('writes entityId as the readable identity, in the app\'s key order', () => {
      // The app writes `presetId, id, entityId`. An authored tree must match, so
      // installing it and syncing lands on "nothing to commit" rather than a
      // reordering diff. No `id` here: the author has no local key to declare —
      // the app mints one on import and writes it from then on.
      const preset = JSON.parse(treeOf('schema-preset', SPECS['schema-preset']).read('preset.json')!)
      expect(preset.entityId).toBe('omop-cdm-5-4')
      expect(preset.presetId).toBe('omop-cdm-5-4')
      expect(Object.keys(preset).slice(0, 2)).toEqual(['presetId', 'entityId'])
    })

    it('accepts a tree identified only by entityId', () => {
      // What the export writes once `presetId` is dropped: the validator must
      // not demand the retired field.
      const tree = new MemoryTree({
        'preset.json': JSON.stringify({ entityId: 'omop-cdm-5-4', mapping: { presetId: 'omop-cdm-5-4' } }),
      })
      expect(validateEntity(tree, 'schema-preset')).toEqual([])
    })

    it('accepts the id + entityId pair the app exports', () => {
      // Every standalone entity's export carries both (_collection.json,
      // _pipeline.json, rule-set.json, catalog.json). A preset is not special.
      const tree = new MemoryTree({
        'preset.json': JSON.stringify({
          presetId: 'omop-cdm-5-4',
          id: '9f3c2a11-0000-4000-8000-000000000001',
          entityId: 'omop-cdm-5-4',
          mapping: { presetId: 'omop-cdm-5-4' },
        }),
      })
      expect(validateEntity(tree, 'schema-preset')).toEqual([])
    })

    it('moves a DDL supplied inside the mapping out to schema.ddl', () => {
      const tree = treeOf('schema-preset', {
        presetId: 'p',
        presetLabel: { en: 'P' },
        mapping: { ddl: 'CREATE TABLE t (a INT);\n' },
      })
      expect(tree.read('schema.ddl')).toBe('CREATE TABLE t (a INT);\n')
      expect(validateEntity(tree, 'schema-preset')).toEqual([])
    })

    it('omits schema.ddl entirely when there is no DDL', () => {
      const tree = treeOf('schema-preset', { presetId: 'p', presetLabel: { en: 'P' } })
      expect(tree.read('schema.ddl')).toBeNull()
    })

    it('orders event tables canonically, whatever order the author used', () => {
      // Two instances holding the same mapping must emit identical bytes, or
      // git shows a diff where nothing changed.
      const messy = serializeEntity('schema-preset', {
        presetId: 'p',
        presetLabel: { en: 'P' },
        eventTables: {
          Zeta: { dateColumn: 'd', conceptIdColumn: 'c', table: 't' },
          Alpha: { table: 't', dateColumn: 'd', conceptIdColumn: 'c' },
        },
      })
      const tidy = serializeEntity('schema-preset', {
        presetId: 'p',
        presetLabel: { en: 'P' },
        eventTables: {
          Alpha: { table: 't', conceptIdColumn: 'c', dateColumn: 'd' },
          Zeta: { table: 't', conceptIdColumn: 'c', dateColumn: 'd' },
        },
      })
      expect(messy).toEqual(tidy)

      const preset = JSON.parse(messy[0].content) as {
        mapping: { eventTables: Record<string, Record<string, string>> }
      }
      expect(Object.keys(preset.mapping.eventTables)).toEqual(['Alpha', 'Zeta'])
      expect(Object.keys(preset.mapping.eventTables.Zeta))
        .toEqual(['table', 'conceptIdColumn', 'dateColumn'])
    })

    it('keeps the rest of the mapping as supplied', () => {
      const tree = treeOf('schema-preset', SPECS['schema-preset'])
      const preset = JSON.parse(tree.read('preset.json')!) as {
        mapping: { patientTable: { table: string } }
      }
      expect(preset.mapping.patientTable.table).toBe('person')
    })

    it('emits the mapping keys in the order the app exports them', () => {
      // Checked against the four presets in linkr-public-content: the writer
      // reproduces byte for byte what the app's export produces today. Drifting
      // here would make an authored preset and an exported one differ as files
      // while describing the same schema — a diff nobody can act on.
      const tree = treeOf('schema-preset', {
        presetId: 'p',
        presetLabel: { en: 'P' },
        description: { en: 'D' },
        templateId: 'omop-5.4',
        eventTables: { M: { table: 'm', conceptIdColumn: 'c', dateColumn: 'd' } },
        mapping: {
          erdGroups: [],
          knownTables: ['person'],
          genderValues: { male: '8507' },
          conceptTables: [],
          visitDetailTable: { table: 'vd', idColumn: 'vd_id' },
          noteTable: { table: 'n', idColumn: 'n_id' },
          visitTable: { table: 'v', idColumn: 'v_id' },
          deathTable: { table: 'de', patientIdColumn: 'p' },
          patientTable: { table: 'person', idColumn: 'person_id' },
        },
      })
      const preset = JSON.parse(tree.read('preset.json')!) as { mapping: Record<string, unknown> }
      expect(Object.keys(preset.mapping)).toEqual([
        'presetId', 'presetLabel', 'patientTable', 'deathTable', 'visitTable',
        'noteTable', 'visitDetailTable', 'conceptTables', 'eventTables',
        'genderValues', 'knownTables', 'erdGroups', 'templateId', 'description',
      ])
    })
  })
})
