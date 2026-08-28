import { describe, it, expect } from 'vitest'
import { buildSeedManifest, buildSeedRoot } from './seed-manifest.js'
import { MemoryTree } from './tree.js'

/** A workspace tree as the fetch script assembles it: pointers already spliced. */
function workspace(files: Record<string, string>): MemoryTree {
  return new MemoryTree({ 'entity.json': '{"type":"workspace"}', ...files })
}

describe('buildSeedManifest — entities', () => {
  it('indexes a project by its folder name', () => {
    const m = buildSeedManifest(workspace({ 'projects/icu-demo/entity.json': '{}' }))
    expect(m.entities).toEqual([{ type: 'project', id: 'icu-demo', folder: 'icu-demo' }])
    expect(m.schemaVersion).toBe(2)
  })

  it('skips a folder with no manifest — it is not an entity', () => {
    const m = buildSeedManifest(workspace({ 'projects/stray/README.md': '# hi' }))
    expect(m.entities).toEqual([])
  })

  // A repo published before the rename must keep indexing: both names resolve.
  it('accepts a retired manifest name', () => {
    const m = buildSeedManifest(workspace({ 'projects/old/project.json': '{}' }))
    expect(m.entities).toHaveLength(1)
    const mp = buildSeedManifest(workspace({ 'mapping-projects/mimic/_project.json': '{}' }))
    expect(mp.entities[0]).toMatchObject({ type: 'mappingProject', id: 'mimic' })
  })

  it('reads both the folder and the flat pre-folder form of a rule set', () => {
    const m = buildSeedManifest(workspace({
      'data-quality/legacy.json': '{}',
      'data-quality/modern/entity.json': '{}',
    }))
    expect(m.entities).toEqual([
      { type: 'dqRuleSet', id: 'legacy', path: 'data-quality/legacy.json' },
      { type: 'dqRuleSet', id: 'modern', path: 'data-quality/modern/entity.json' },
    ])
  })

  // Declaration order is replayed by the loader and feeds the seed hashes, so a
  // manifest that reshuffled per build would announce phantom "data updates".
  it('orders folders deterministically', () => {
    const files = { b: '{}', a: '{}', c: '{}' }
    const tree = workspace(Object.fromEntries(
      Object.keys(files).map((n) => [`projects/${n}/entity.json`, '{}']),
    ))
    expect(buildSeedManifest(tree).entities.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('buildSeedManifest — databases', () => {
  const manifest = JSON.stringify({
    entityId: 'mimic-iv-demo',
    alias: 'mimic_iv',
    name: { en: 'MIMIC-IV Demo' },
    schemaMapping: { tables: {} },
  })
  const withData = {
    'databases/mimic-iv-demo/entity.json': manifest,
    'databases/mimic-iv-demo/data/person.parquet': 'PAR1',
    'databases/mimic-iv-demo/data/visit_occurrence.parquet': 'PAR1',
  }

  // No rows in the repo means nothing to mount, so it stays metadata: the
  // workspace import writes the row like any other pointer.
  it('leaves a database out of entities when the repo ships no Parquet', () => {
    const m = buildSeedManifest(
      workspace({ 'databases/mimic-iv-demo/entity.json': manifest }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities).toEqual([])
    expect(m.internals?.databases).toEqual(['databases/mimic-iv-demo/entity.json'])
  })

  // Derived from the files present, never from a hand-kept list — the two cannot
  // drift, and adding a table to the repo needs no change here.
  it('derives parquetBase and tables from the repo itself', () => {
    const m = buildSeedManifest(workspace(withData), { seedBaseUrl: '/data/seed/default' })
    expect(m.entities[0]).toMatchObject({
      type: 'database',
      // Keyed on the manifest's entityId, not the folder: the workspace import
      // wrote the row under that id, and the loader has to find the same one.
      id: 'mimic-iv-demo',
      alias: 'mimic_iv',
      parquetBase: '/data/seed/default/databases/mimic-iv-demo/data',
      tables: ['person', 'visit_occurrence'],
    })
  })

  it('stays metadata-only when no base URL is given to build a fetchable path', () => {
    expect(buildSeedManifest(workspace(withData)).entities).toEqual([])
  })

  it('carries the one seed-only link a project export deliberately strips', () => {
    const m = buildSeedManifest(workspace(withData), {
      seedBaseUrl: '/data/seed/default',
      databases: { 'mimic-iv-demo': { linkToProject: 'proj-1' } },
    })
    expect(m.entities[0]).toMatchObject({ linkToProject: 'proj-1' })
  })

  it('keeps the vocabulary flag, which changes how the loader mounts it', () => {
    const m = buildSeedManifest(
      workspace({
        'databases/vocab/entity.json': '{"entityId":"vocab","isVocabularyReference":true}',
        'databases/vocab/data/concept.parquet': 'PAR1',
      }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities[0]).toMatchObject({ isVocabularyReference: true })
  })
})

describe('buildSeedManifest — internals', () => {
  it('lists a pipeline and its script files, minus the manifest', () => {
    const m = buildSeedManifest(workspace({
      'etl/mimic/entity.json': '{}',
      'etl/mimic/_tree.json': '[]',
      'etl/mimic/scripts/01_load.sql': 'select 1',
    }))
    expect(m.internals?.etlPipelines).toEqual(['mimic'])
    expect(m.internals?.etlFiles).toEqual({ 'mimic/scripts/01_load.sql': 'scripts/01_load.sql' })
  })

  it('keeps a plugin\'s own functional manifest in its file list', () => {
    const m = buildSeedManifest(workspace({
      'plugins/chart/entity.json': '{}',
      'plugins/chart/plugin.json': '{}',
      'plugins/chart/index.js': 'export {}',
    }))
    expect(m.internals?.pluginFolders).toEqual(['chart'])
    // entity.json is Linkr metadata and drops out; plugin.json is content.
    expect(m.internals?.pluginFiles?.chart).toEqual(['index.js', 'plugin.json'])
  })

  it('ignores wiki pages with no tree index', () => {
    const withoutTree = buildSeedManifest(workspace({ 'wiki/home.md': '# home' }))
    expect(withoutTree.internals?.wikiPages).toBeUndefined()
    const withTree = buildSeedManifest(workspace({
      'wiki/_tree.json': '[]',
      'wiki/home.md': '# home',
    }))
    expect(withTree.internals?.wikiPages).toEqual(['wiki/home.md'])
  })

  it('omits internals entirely when there are none', () => {
    const m = buildSeedManifest(workspace({ 'projects/p/entity.json': '{}' }))
    expect(m.internals).toBeUndefined()
  })

  it('stamps the organization only when given one', () => {
    expect(buildSeedManifest(workspace({})).organization).toBeUndefined()
    const org = { id: 'org-1', name: 'Demo' }
    expect(buildSeedManifest(workspace({}), { organization: org }).organization).toEqual(org)
  })
})

describe('buildSeedRoot', () => {
  it('sorts the workspace list so the file is stable across builds', () => {
    expect(buildSeedRoot(['b', 'a'])).toEqual({ schemaVersion: 2, workspaces: ['a', 'b'] })
  })
})
