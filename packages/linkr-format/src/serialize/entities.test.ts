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

  it('writes badges where the app writes them, right after description', () => {
    // The app has always exported badges; the authoring writer dropped them, so
    // an authored tree lost them and the first sync after an install added them
    // back — a diff nobody wrote.
    const badges = [{ id: 'b1', label: { en: 'Reference' }, color: 'blue' }]
    const catalog = JSON.parse(
      treeOf('data-catalog', {
        ...SPECS['data-catalog'], description: { en: 'D' }, badges,
      } as never).read('entity.json')!,
    )
    expect(catalog.badges).toEqual(badges)
    const keys = Object.keys(catalog)
    expect(keys.indexOf('badges')).toBe(keys.indexOf('description') + 1)

    // A preset keeps them at entity level, NOT inside the mapping: the mapping is
    // copied verbatim into every database that uses the schema.
    const preset = JSON.parse(
      treeOf('schema-preset', { ...SPECS['schema-preset'], badges } as never).read('entity.json')!,
    )
    expect(preset.badges).toEqual(badges)
    // and NOT inside the mapping, which every database copies verbatim.
    expect(JSON.parse(
      treeOf('schema-preset', { ...SPECS['schema-preset'], badges } as never).read('mapping.json')!,
    ).badges).toBeUndefined()
  })

  it('omits badges when the list is empty, as the app does', () => {
    // A row carries `[]` or nothing depending only on whether it was last
    // written by a create or an update; both mean "no badges". The app deletes
    // the key (stripInstanceFields), so writing `[]` here showed up as an added
    // line on the first sync after an authored edit.
    const catalog = JSON.parse(
      treeOf('data-catalog', {
        ...SPECS['data-catalog'], description: { en: 'D' }, badges: [],
      } as never).read('entity.json')!,
    )
    expect('badges' in catalog).toBe(false)
  })

  it('declares every parent folder in the tree', () => {
    const tree = treeOf('sql-collection', SPECS['sql-collection'])
    const entries = JSON.parse(tree.read('scripts/_tree.json')!) as { path: string; type: string }[]
    // Without the folder entry the import reparents the file to the root.
    expect(entries).toContainEqual(expect.objectContaining({ path: 'queries', type: 'folder' }))
    expect(entries.map((e) => e.path)).toContain('queries/cohort.sql')
  })

  it('derives a script language from its extension', () => {
    const tree = treeOf('etl-pipeline', SPECS['etl-pipeline'])
    const entries = JSON.parse(tree.read('scripts/_tree.json')!) as { path: string; language?: string }[]
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
      const mapping = JSON.parse(tree.read('mapping.json')!) as Record<string, unknown>
      expect(mapping.ddl).toBeUndefined()
    })

    it('leads with the identity block, keyed on entityId', () => {
      // No `id`: `idOf` refuses the field for a preset, because a repo's local
      // primary key must not become the installing instance's. `presetId` is the
      // retired identity and is never written.
      const tree = treeOf('schema-preset', SPECS['schema-preset'])
      const preset = JSON.parse(tree.read('entity.json')!)
      expect(Object.keys(preset).slice(0, 4))
        .toEqual(['entityId', 'type', 'name', 'description'])
      expect(preset.id).toBeUndefined()
      expect(preset.entityId).toBe('omop-cdm-5-4')
      expect(preset.presetId).toBeUndefined()
      // The label rises to the root as the entity's name.
      expect(preset.name.en).toBe('OMOP CDM 5.4')
      expect(preset.mapping).toBeUndefined()
      // Not in the payload either: it is `entityId` one level down, and writing
      // it twice meant the export and the install had to keep the two in step by
      // hand. The reader puts it back from `entityId` for a database's copy.
      expect(JSON.parse(tree.read('mapping.json')!).presetId).toBeUndefined()
    })

    it('accepts a tree identified only by entityId', () => {
      // The retired `presetId` must not be demanded — `entityId` alone identifies
      // the preset. Still a legacy tree (old manifest name, inline mapping), so
      // the only thing asserted here is that nothing is reported as an ERROR.
      const tree = new MemoryTree({
        'preset.json': JSON.stringify({ entityId: 'omop-cdm-5-4', mapping: { presetId: 'omop-cdm-5-4' } }),
      })
      expect(validateEntity(tree, 'schema-preset').filter((i) => i.severity === 'error')).toEqual([])
    })

    it('warns a pre-harmonization tree without failing it', () => {
      // A published repo that has not been re-exported yet: old manifest name,
      // payload inline, `presetId` alongside `entityId`. All three still import,
      // so they warn — silence would leave an author no reason to migrate.
      const tree = new MemoryTree({
        'preset.json': JSON.stringify({
          presetId: 'omop-cdm-5-4',
          entityId: 'omop-cdm-5-4',
          mapping: { presetId: 'omop-cdm-5-4' },
        }),
      })
      const issues = validateEntity(tree, 'schema-preset')
      expect(issues.filter((i) => i.severity === 'error')).toEqual([])
      expect(issues.every((i) => i.code === 'legacy-format')).toBe(true)
      expect(issues.map((i) => i.pointer)).toEqual(
        expect.arrayContaining(['', '/mapping', '/presetId']),
      )
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

      const mappingFile = messy.find((f) => f.path === 'mapping.json')!
      const preset = JSON.parse(mappingFile.content) as {
        eventTables: Record<string, Record<string, string>>
      }
      expect(Object.keys(preset.eventTables)).toEqual(['Alpha', 'Zeta'])
      expect(Object.keys(preset.eventTables.Zeta))
        .toEqual(['table', 'conceptIdColumn', 'dateColumn'])
    })

    it('keeps the rest of the mapping as supplied', () => {
      const tree = treeOf('schema-preset', SPECS['schema-preset'])
      const preset = JSON.parse(tree.read('mapping.json')!) as {
        patientTable: { table: string }
      }
      expect(preset.patientTable.table).toBe('person')
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
      const preset = JSON.parse(tree.read('mapping.json')!) as Record<string, unknown>
      // Four keys are absent from a preset's OWN mapping. `presetLabel` and
      // `description` are the entity's name and blurb, at the manifest root.
      // `presetId` duplicates `entityId`. `templateId` named the built-in preset
      // a schema derived from, back when the app shipped a picker of them —
      // nothing has read it since, so it only froze a dead reference into the
      // file. A database's copied mapping still carries all four.
      expect(Object.keys(preset)).toEqual([
        'patientTable', 'deathTable', 'visitTable',
        'noteTable', 'visitDetailTable', 'conceptTables', 'eventTables',
        'genderValues', 'knownTables', 'erdGroups',
      ])
    })
  })
})
