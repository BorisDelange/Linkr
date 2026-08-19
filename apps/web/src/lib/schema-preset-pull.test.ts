import { describe, it, expect } from 'vitest'
import {
  isCompleteSchemaPresetPull,
  presetDocItems,
  presetDocTarget,
  presetMappingChanged,
  schemaPresetPullPlanPaths,
  stripInstancePresetMapping,
  PRESET_MANIFEST_FILE,
  type SchemaPresetPullPlan,
} from './schema-preset-pull'
import { buildSchemaPresetPullPlan } from './schema-preset-pull-plan-builder'
import { SCHEMA_PRESET_DDL_FILE } from './entity-io'
import type { CustomSchemaPreset, SchemaMapping } from '@/types'

const mapping = (over: Partial<SchemaMapping> = {}): SchemaMapping => ({
  presetId: 'omop-cdm-5-4',
  presetLabel: { en: 'OMOP CDM 5.4' },
  ...over,
} as SchemaMapping)

const plan = (over: Partial<SchemaPresetPullPlan> = {}): SchemaPresetPullPlan => ({
  ddlChanged: false,
  mappingChanged: false,
  docs: [],
  ...over,
})

describe('stripInstancePresetMapping', () => {
  it('drops the DDL — it travels as its own file and is decided separately', () => {
    const out = stripInstancePresetMapping(mapping({ ddl: 'CREATE TABLE person ();' }))
    expect(out.ddl).toBeUndefined()
  })

  it('keeps the mapping config itself', () => {
    const out = stripInstancePresetMapping(mapping({ knownTables: ['person'] } as Partial<SchemaMapping>))
    expect(out.knownTables).toEqual(['person'])
  })
})

describe('presetMappingChanged', () => {
  it('ignores a DDL-only difference', () => {
    // The DDL is its own row; counting it here would light both toggles for one
    // change and make "take the config" mean "take the SQL too".
    const local = mapping({ ddl: 'CREATE TABLE a ();' })
    const remote = stripInstancePresetMapping(mapping({ ddl: 'CREATE TABLE b ();' }))
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

describe('presetDocTarget', () => {
  it('maps a docs path back to what it writes', () => {
    expect(presetDocTarget('LICENSE.md')).toBe('license')
    expect(presetDocTarget('README.md')).toEqual({ readmeLang: 'en' })
    expect(presetDocTarget('README.fr.md')).toEqual({ readmeLang: 'fr' })
  })

  it('returns null for anything that is not a docs file', () => {
    expect(presetDocTarget(SCHEMA_PRESET_DDL_FILE)).toBeNull()
    expect(presetDocTarget(PRESET_MANIFEST_FILE)).toBeNull()
  })
})

describe('isCompleteSchemaPresetPull', () => {
  it('is complete only when every offered block was taken', () => {
    const p = plan({ ddlChanged: true, mappingChanged: true })
    const paths = schemaPresetPullPlanPaths(p)
    expect(paths).toEqual(new Set([SCHEMA_PRESET_DDL_FILE, PRESET_MANIFEST_FILE]))
    expect(isCompleteSchemaPresetPull(p, { paths })).toBe(true)
  })

  it('is incomplete when a block was refused', () => {
    // The content anchor may not advance here, or the refused block would never
    // be offered again.
    const p = plan({ ddlChanged: true, mappingChanged: true })
    expect(isCompleteSchemaPresetPull(p, {
      paths: new Set([SCHEMA_PRESET_DDL_FILE]),
    })).toBe(false)
  })

  it('is trivially complete when the plan offers nothing', () => {
    expect(isCompleteSchemaPresetPull(plan(), { paths: new Set() })).toBe(true)
  })
})

describe('buildSchemaPresetPullPlan', () => {
  const prepared = (over: Partial<Parameters<typeof buildSchemaPresetPullPlan>[0]> = {}) => ({
    plan: plan(),
    remoteDdl: null,
    remoteMapping: null,
    remoteDocs: {},
    localPreset: undefined,
    clonedOid: 'oid-1',
    branch: 'main',
    ...over,
  } as Parameters<typeof buildSchemaPresetPullPlan>[0])

  it('orders rows by category, like the push list', () => {
    // preset.json is 'general' (rank 0), schema.ddl is 'scripts' (rank 2) — the
    // builder's own push order is irrelevant, buildPullFiles re-sorts.
    const built = buildSchemaPresetPullPlan(
      prepared({ plan: plan({ ddlChanged: true, mappingChanged: true }) }),
      'main',
    )
    expect(built.files.map((f) => f.path)).toEqual([PRESET_MANIFEST_FILE, SCHEMA_PRESET_DDL_FILE])
  })

  const ddlRow = (built: ReturnType<typeof buildSchemaPresetPullPlan>) =>
    built.files.find((f) => f.path === SCHEMA_PRESET_DDL_FILE)

  it('calls the DDL an add when we hold none, an update when we do', () => {
    const added = buildSchemaPresetPullPlan(prepared({ plan: plan({ ddlChanged: true }) }), 'main')
    expect(ddlRow(added)?.items[0].state).toBe('add')

    const updated = buildSchemaPresetPullPlan(prepared({
      plan: plan({ ddlChanged: true }),
      localPreset: { mapping: mapping({ ddl: 'CREATE TABLE a ();' }) } as CustomSchemaPreset,
    }), 'main')
    expect(ddlRow(updated)?.items[0].state).toBe('update')
  })

  it('marks every row whole-file — a half-taken DDL is not a schema', () => {
    const built = buildSchemaPresetPullPlan(
      prepared({ plan: plan({ ddlChanged: true, mappingChanged: true }) }),
      'main',
    )
    expect(built.files.every((f) => f.wholeFile)).toBe(true)
  })

  it('classifies the DDL as a script, so it lands in a named group', () => {
    const built = buildSchemaPresetPullPlan(prepared({ plan: plan({ ddlChanged: true }) }), 'main')
    expect(ddlRow(built)?.category).toBe('scripts')
  })

  it('carries the scope and the cloned head the cursors advance to', () => {
    const built = buildSchemaPresetPullPlan(prepared({ plan: plan({ ddlChanged: true }) }), 'main')
    expect(built.scope).toBe('schema-presets')
    expect(built.remoteHead).toBe('oid-1')
  })

  it('is empty when nothing differs', () => {
    expect(buildSchemaPresetPullPlan(prepared(), 'main').files).toEqual([])
  })
})
