import { describe, it, expect } from 'vitest'
import {
  isCompleteSchemaPresetPull,
  presetDocItems,
  presetInfoChanged,
  presetInfoOf,
  presetMappingChanged,
  schemaPresetPullPlanGroups,
  stripInstancePresetMapping,
  PRESET_MANIFEST_FILE,
  type SchemaPresetPullPlan,
} from './schema-preset-pull'
import { buildSchemaPresetPullPlan } from './schema-preset-pull-plan-builder'
import { buildSchemaPresetPullDiff } from './schema-preset-pull-diff'
import { SCHEMA_PRESET_DDL_FILE } from './entity-io'
import type { PullFile } from './pull-plan'
import type { CustomSchemaPreset, SchemaMapping } from '@/types'

const mapping = (over: Partial<SchemaMapping> = {}): SchemaMapping => ({
  presetId: 'omop-cdm-5-4',
  presetLabel: { en: 'OMOP CDM 5.4' },
  ...over,
} as SchemaMapping)

const plan = (over: Partial<SchemaPresetPullPlan> = {}): SchemaPresetPullPlan => ({
  schemaChanged: false,
  ddlChanged: false,
  mappingChanged: false,
  docs: [],
  infoChanged: false,
  ...over,
})

describe('stripInstancePresetMapping', () => {
  it('drops the DDL — it travels as its own file', () => {
    const out = stripInstancePresetMapping(mapping({ ddl: 'CREATE TABLE person ();' }))
    expect(out.ddl).toBeUndefined()
  })

  it('drops the descriptive fields — they are decided with the docs', () => {
    // Left here, renaming a preset upstream would light the SCHEMA row.
    const out = stripInstancePresetMapping(
      mapping({ presetLabel: { en: 'X' }, description: { en: 'D' } }),
    )
    expect(out.presetLabel).toBeUndefined()
    expect(out.description).toBeUndefined()
  })

  it('keeps the mapping config itself', () => {
    const out = stripInstancePresetMapping(mapping({ knownTables: ['person'] } as Partial<SchemaMapping>))
    expect(out.knownTables).toEqual(['person'])
  })
})

describe('presetMappingChanged', () => {
  it('ignores a DDL-only difference', () => {
    // The DDL is its own item in the schema row; counting it here would double
    // up on one change.
    const local = mapping({ ddl: 'CREATE TABLE a ();' })
    const remote = stripInstancePresetMapping(mapping({ ddl: 'CREATE TABLE b ();' }))
    expect(presetMappingChanged(local, remote)).toBe(false)
  })

  it('ignores a rename — that belongs to the docs group', () => {
    const local = mapping({ presetLabel: { en: 'Old' } })
    const remote = stripInstancePresetMapping(mapping({ presetLabel: { en: 'New' } }))
    expect(presetMappingChanged(local, remote)).toBe(false)
  })

  it('reports a real config difference', () => {
    const local = mapping({ knownTables: ['person'] } as Partial<SchemaMapping>)
    const remote = stripInstancePresetMapping(
      mapping({ knownTables: ['person', 'visit_occurrence'] } as Partial<SchemaMapping>),
    )
    expect(presetMappingChanged(local, remote)).toBe(true)
  })

  it('is insensitive to key order', () => {
    // Two instances serialise the same config with different key order; without
    // sorting, the toggle would stay permanently lit.
    const local = mapping({ knownTables: ['a'], templateId: 'omop-5.4' } as Partial<SchemaMapping>)
    const remote = stripInstancePresetMapping(
      mapping({ templateId: 'omop-5.4', knownTables: ['a'] } as Partial<SchemaMapping>),
    )
    expect(presetMappingChanged(local, remote)).toBe(false)
  })

  it('compares both sides stripped, so identity fields never read as a change', () => {
    // The remote arrives without presetId (stripped on export); comparing it to a
    // raw local copy that still has one made every preset look permanently changed.
    const local = mapping({ presetId: 'omop-cdm-5-4' })
    const remote = stripInstancePresetMapping(mapping({ presetId: 'omop-cdm-5-4' }))
    expect(presetMappingChanged(local, remote)).toBe(false)
  })

  it('reports nothing when the remote has no mapping at all', () => {
    expect(presetMappingChanged(mapping(), null)).toBe(false)
  })
})

describe('presetInfoChanged', () => {
  it('reports a renamed preset', () => {
    expect(presetInfoChanged(
      mapping({ presetLabel: { en: 'Old' } }),
      presetInfoOf(mapping({ presetLabel: { en: 'New' } })),
    )).toBe(true)
  })

  it('reports a changed description', () => {
    expect(presetInfoChanged(
      mapping({ description: { en: 'A' } }),
      presetInfoOf(mapping({ description: { en: 'B' } })),
    )).toBe(true)
  })

  it('ignores everything structural', () => {
    // A DDL or config change must light the schema row, not this one.
    expect(presetInfoChanged(
      mapping({ ddl: 'a', knownTables: ['x'] } as Partial<SchemaMapping>),
      presetInfoOf(mapping({ ddl: 'b', knownTables: ['y'] } as Partial<SchemaMapping>)),
    )).toBe(false)
  })

  it('reads the info off the RAW remote, not the stripped one', () => {
    // stripInstancePresetMapping removes exactly these fields, so reading them
    // off the stripped copy would always report "no change".
    expect(presetInfoOf(stripInstancePresetMapping(mapping({ presetLabel: { en: 'X' } }))))
      .toEqual({})
    expect(presetInfoOf(mapping({ presetLabel: { en: 'X' } })))
      .toEqual({ presetLabel: { en: 'X' } })
  })
})

describe('presetDocItems', () => {
  const preset = (over: Partial<CustomSchemaPreset> = {}) => ({
    presetId: 'p', mapping: mapping(), ...over,
  } as CustomSchemaPreset)

  it('offers the primary README as the suffix-free file', () => {
    const items = presetDocItems({ readme: { en: 'hello' } }, preset())
    expect(items.map((i) => i.key)).toEqual(['README.md'])
  })

  it('suffixes the other languages', () => {
    const items = presetDocItems({ readme: { fr: 'bonjour' } }, preset())
    expect(items.map((i) => i.key)).toEqual(['README.fr.md'])
  })

  it('skips a README identical to the local one', () => {
    const items = presetDocItems(
      { readme: { en: 'same' } },
      preset({ readme: { en: 'same' } }),
    )
    expect(items).toEqual([])
  })

  it('offers the licence only when its text actually differs', () => {
    const same = presetDocItems(
      { license: { id: 'MIT', text: 'x' } },
      preset({ license: { id: 'MIT', text: 'x' } } as Partial<CustomSchemaPreset>),
    )
    expect(same).toEqual([])
    const differs = presetDocItems({ license: { id: 'MIT', text: 'y' } }, preset())
    expect(differs.map((i) => i.key)).toEqual(['LICENSE.md'])
  })
})

describe('isCompleteSchemaPresetPull', () => {
  it('is complete only when every offered group was taken', () => {
    const p = plan({ schemaChanged: true, infoChanged: true })
    const groups = schemaPresetPullPlanGroups(p)
    expect(groups).toEqual(new Set(['schema', 'docs']))
    expect(isCompleteSchemaPresetPull(p, { groups })).toBe(true)
  })

  it('is incomplete when a group was refused', () => {
    // The content anchor may not advance here, or the refused group would never
    // be offered again.
    const p = plan({ schemaChanged: true, infoChanged: true })
    expect(isCompleteSchemaPresetPull(p, { groups: new Set(['schema']) })).toBe(false)
  })

  it('counts a docs-only change as the docs group', () => {
    const p = plan({ docs: [{ key: 'README.md', exists: true }] })
    expect(schemaPresetPullPlanGroups(p)).toEqual(new Set(['docs']))
  })

  it('is trivially complete when the plan offers nothing', () => {
    expect(isCompleteSchemaPresetPull(plan(), { groups: new Set() })).toBe(true)
  })
})

describe('buildSchemaPresetPullPlan', () => {
  const prepared = (over: Partial<Parameters<typeof buildSchemaPresetPullPlan>[0]> = {}) => ({
    plan: plan(),
    remoteDdl: null,
    remoteMapping: null,
    remoteInfo: {},
    remoteDocs: {},
    localPreset: undefined,
    clonedOid: 'oid-1',
    branch: 'main',
    ...over,
  } as Parameters<typeof buildSchemaPresetPullPlan>[0])

  it('offers two rows, one per subject', () => {
    const built = buildSchemaPresetPullPlan(prepared({
      plan: plan({ schemaChanged: true, ddlChanged: true, infoChanged: true }),
    }), 'main')
    expect(built.files.map((f) => f.path))
      .toEqual([PRESET_MANIFEST_FILE, SCHEMA_PRESET_DDL_FILE])
  })

  it('puts the DDL and the mapping config in ONE row', () => {
    // They are one subject: a config taken without its DDL can name columns the
    // local schema does not have.
    const built = buildSchemaPresetPullPlan(prepared({
      plan: plan({ schemaChanged: true, ddlChanged: true, mappingChanged: true }),
    }), 'main')
    const schemaRow = built.files.find((f) => f.path === SCHEMA_PRESET_DDL_FILE)
    expect(schemaRow?.items.map((i) => i.key)).toEqual(['ddl', 'mapping'])
    expect(schemaRow?.wholeFile).toBe(true)
  })

  it('groups the name/description with README and licence', () => {
    const built = buildSchemaPresetPullPlan(prepared({
      plan: plan({ docs: [{ key: 'README.md', exists: true }], infoChanged: true }),
    }), 'main')
    const docsRow = built.files.find((f) => f.path === PRESET_MANIFEST_FILE)
    expect(docsRow?.items.map((i) => i.key)).toEqual(['README.md', 'info'])
  })

  it('calls the DDL an add when we hold none, an update when we do', () => {
    const added = buildSchemaPresetPullPlan(prepared({
      plan: plan({ schemaChanged: true, ddlChanged: true }),
    }), 'main')
    expect(added.files[0].items[0].state).toBe('add')

    const updated = buildSchemaPresetPullPlan(prepared({
      plan: plan({ schemaChanged: true, ddlChanged: true }),
      localPreset: { mapping: mapping({ ddl: 'CREATE TABLE a ();' }) } as CustomSchemaPreset,
    }), 'main')
    expect(updated.files[0].items[0].state).toBe('update')
  })

  it('carries the scope and the cloned head the cursors advance to', () => {
    const built = buildSchemaPresetPullPlan(prepared({
      plan: plan({ schemaChanged: true, ddlChanged: true }),
    }), 'main')
    expect(built.scope).toBe('schema-presets')
    expect(built.remoteHead).toBe('oid-1')
  })

  it('is empty when nothing differs', () => {
    expect(buildSchemaPresetPullPlan(prepared(), 'main').files).toEqual([])
  })
})

describe('buildSchemaPresetPullDiff', () => {
  const file = (path: string): PullFile => ({ path, category: 'scripts', order: 1, items: [], wholeFile: true })

  const prepared = (over: Record<string, unknown> = {}) => ({
    plan: plan(),
    remoteDdl: null,
    remoteMapping: null,
    remoteInfo: {},
    remoteDocs: {},
    localPreset: undefined,
    clonedOid: 'oid-1',
    branch: 'main',
    ...over,
  } as Parameters<typeof buildSchemaPresetPullDiff>[1])

  it('shows the DDL before and after, as SQL', () => {
    const diff = buildSchemaPresetPullDiff(file(SCHEMA_PRESET_DDL_FILE), prepared({
      plan: plan({ schemaChanged: true, ddlChanged: true }),
      remoteDdl: 'CREATE TABLE b ();',
      localPreset: { mapping: mapping({ ddl: 'CREATE TABLE a ();' }) },
    }))
    expect(diff.oldContent).toBe('CREATE TABLE a ();')
    expect(diff.newContent).toBe('CREATE TABLE b ();')
    expect(diff.language).toBe('sql')
  })

  it('shows the config instead when only the config moved', () => {
    // Diffing the DDL there would render "no change" on a row that IS changed.
    const diff = buildSchemaPresetPullDiff(file(SCHEMA_PRESET_DDL_FILE), prepared({
      plan: plan({ schemaChanged: true, mappingChanged: true }),
      remoteDdl: 'SAME',
      remoteMapping: stripInstancePresetMapping(mapping({ knownTables: ['b'] } as Partial<SchemaMapping>)),
      localPreset: { mapping: mapping({ ddl: 'SAME', knownTables: ['a'] } as Partial<SchemaMapping>) },
    }))
    expect(diff.language).toBe('json')
    expect(diff.oldContent).toContain('"a"')
    expect(diff.newContent).toContain('"b"')
  })

  it('shows the whole descriptive block for the docs row', () => {
    const diff = buildSchemaPresetPullDiff(file(PRESET_MANIFEST_FILE), prepared({
      plan: plan({ infoChanged: true }),
      remoteInfo: { presetLabel: { en: 'New' } },
      remoteDocs: { readme: { en: 'remote readme' } },
      localPreset: { mapping: mapping({ presetLabel: { en: 'Old' } }), readme: { en: 'local readme' } },
    }))
    expect(diff.oldContent).toContain('Old')
    expect(diff.oldContent).toContain('local readme')
    expect(diff.newContent).toContain('New')
    expect(diff.newContent).toContain('remote readme')
  })

  it('sorts keys so key order never reads as a difference', () => {
    const diff = buildSchemaPresetPullDiff(file(PRESET_MANIFEST_FILE), prepared({
      remoteInfo: { presetLabel: { en: 'X' }, description: { en: 'D' } },
      localPreset: { mapping: mapping({ description: { en: 'D' }, presetLabel: { en: 'X' } }) },
    }))
    expect(diff.oldContent).toBe(diff.newContent)
  })
})
