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
    expect(() => serializeEntity('schema-preset' as SerializableEntityKind, SPECS['data-catalog'] as never))
      .toThrow(/Cannot serialize/)
  })
})
