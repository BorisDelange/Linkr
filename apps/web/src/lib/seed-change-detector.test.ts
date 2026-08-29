import { describe, it, expect } from 'vitest'
import { mergeSeedHashesFor, dropFromSeedHashes, diffSeedHashes, isBaselineStale } from './seed-change-detector'
import type { SeedHashesManifest, SeedEntityHashes } from '../../vite-plugin-seed-hashes'
// Tracked, not hardcoded: a baseline's schemaVersion has to follow the constant, or every
// fixture goes stale — and reads as "no changes" — the next time the shape is bumped.
import { SEED_HASHES_SCHEMA_VERSION } from './seed-schema-version'

// mergeSeedHashesFor advances the stored baseline to `current` for ONLY the selected
// entities. A wrong merge either re-notifies forever (didn't advance) or hides future
// changes the user skipped (advanced too much) — both are data-staleness bugs.

function emptyEntity(workspace = 'w0') {
  return {
    workspace,
    databases: {}, conceptMappings: {}, etlScripts: {}, datasets: {},
    dashboards: {}, projects: {}, mappingProjects: {}, dqRuleSets: {}, catalogs: {},
  }
}

const stored: SeedHashesManifest = {
  schemaVersion: SEED_HASHES_SCHEMA_VERSION,
  workspaces: {
    ricdc: { ...emptyEntity('w0'), projects: { neoclip: 'old1', other: 'old2' } },
  },
}

const current: SeedHashesManifest = {
  schemaVersion: SEED_HASHES_SCHEMA_VERSION,
  workspaces: {
    ricdc: { ...emptyEntity('w1'), projects: { neoclip: 'new1', other: 'new2' } },
  },
}

describe('mergeSeedHashesFor', () => {
  it('advances only the selected entity, leaving others stale', () => {
    const merged = mergeSeedHashesFor(stored, current, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect(merged.workspaces.ricdc.projects.neoclip).toBe('new1') // advanced
    expect(merged.workspaces.ricdc.projects.other).toBe('old2')   // still stale → still notifies
  })

  it('advances the workspace metadata hash when workspace is selected', () => {
    const merged = mergeSeedHashesFor(stored, current, [
      { workspaceFolder: 'ricdc', entityType: 'workspace', entityId: 'ricdc' },
    ])
    expect(merged.workspaces.ricdc.workspace).toBe('w1')
    expect(merged.workspaces.ricdc.projects.neoclip).toBe('old1') // untouched
  })

  it('drops an entity from the baseline when it was removed from the seed', () => {
    const currentRemoved: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { ricdc: { ...emptyEntity('w0'), projects: { other: 'old2' } } },
    }
    const merged = mergeSeedHashesFor(stored, currentRemoved, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect('neoclip' in merged.workspaces.ricdc.projects).toBe(false)
  })

  it('copies a brand-new workspace wholesale', () => {
    const currentNew: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: {
        ricdc: stored.workspaces.ricdc,
        extra: { ...emptyEntity('we'), datasets: { d1: 'h1' } },
      },
    }
    const merged = mergeSeedHashesFor(stored, currentNew, [
      { workspaceFolder: 'extra', entityType: 'dataset', entityId: 'd1' },
    ])
    expect(merged.workspaces.extra.datasets.d1).toBe('h1')
  })

  it('does not mutate the stored input', () => {
    const snapshot = JSON.parse(JSON.stringify(stored))
    mergeSeedHashesFor(stored, current, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect(stored).toEqual(snapshot)
  })

  it('starts from empty when no baseline is stored', () => {
    const merged = mergeSeedHashesFor(null, current, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect(merged.workspaces.ricdc.projects.neoclip).toBe('new1')
  })

  // Regression: an older baseline predates a newer entity-type key (e.g. etlPipelines
  // added after the baseline was stored). Indexing that missing map used to throw
  // "can't access property <id>, undefined" when applying a re-seed of that type.
  it('creates a missing entity-type map instead of throwing (stale baseline)', () => {
    const staleStored = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { ricdc: { workspace: 'w0', projects: { neoclip: 'old1' } } },
    } as unknown as SeedHashesManifest
    const currentWithEtl: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { ricdc: { ...emptyEntity('w0'), etlPipelines: { 'etl-7': 'h7' } } as SeedEntityHashes },
    }
    const merged = mergeSeedHashesFor(staleStored, currentWithEtl, [
      { workspaceFolder: 'ricdc', entityType: 'etlPipeline', entityId: 'etl-7' },
    ])
    expect(merged.workspaces.ricdc.etlPipelines?.['etl-7']).toBe('h7')
    // Pre-existing keys on the stale baseline survive.
    expect(merged.workspaces.ricdc.projects.neoclip).toBe('old1')
  })
})

// dropFromSeedHashes removes entities from the baseline after they're deleted locally. Unlike
// mergeSeedHashesFor it must NOT depend on the current build (a removed entity/workspace is
// absent there). Getting this wrong re-notifies the deletion on every reload.
describe('dropFromSeedHashes', () => {
  it('drops a single entity from the baseline', () => {
    const merged = dropFromSeedHashes(stored, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect('neoclip' in merged.workspaces.ricdc.projects).toBe(false)
    expect(merged.workspaces.ricdc.projects.other).toBe('old2') // untouched
  })

  it('drops the whole workspace when a workspace entity is removed', () => {
    const merged = dropFromSeedHashes(stored, [
      { workspaceFolder: 'ricdc', entityType: 'workspace', entityId: 'ricdc' },
    ])
    expect('ricdc' in merged.workspaces).toBe(false)
  })

  it('keeps a replaced workspace folder, adopting the successor now living there', () => {
    // Both workspaces share the folder. Dropping it wholesale threw away the baseline the
    // re-seed had just written for the incoming one, so its whole content reappeared as
    // "New" on the next load — the update looked like it had not been applied.
    const merged = dropFromSeedHashes(
      stored,
      [{ workspaceFolder: 'ricdc', entityType: 'workspace', entityId: 'ricdc' }],
      current,
    )
    expect('ricdc' in merged.workspaces).toBe(true)
    expect(merged.workspaces.ricdc.projects).toEqual(current.workspaces.ricdc.projects)
  })

  it('does not mutate the stored input', () => {
    const snapshot = JSON.parse(JSON.stringify(stored))
    dropFromSeedHashes(stored, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect(stored).toEqual(snapshot)
  })

  it('tolerates a stale baseline missing the entity-type map', () => {
    const staleStored = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { ricdc: { workspace: 'w0', projects: { neoclip: 'old1' } } },
    } as unknown as SeedHashesManifest
    const merged = dropFromSeedHashes(staleStored, [
      { workspaceFolder: 'ricdc', entityType: 'etlPipeline', entityId: 'etl-7' },
    ])
    expect(merged.workspaces.ricdc.projects.neoclip).toBe('old1')
  })

  it('is a no-op for an unknown workspace', () => {
    const merged = dropFromSeedHashes(stored, [
      { workspaceFolder: 'ghost', entityType: 'project', entityId: 'x' },
    ])
    expect(merged.workspaces.ricdc.projects.neoclip).toBe('old1')
  })
})

// isBaselineStale gates the silent reset. A wrong answer either wipes a valid baseline (losing
// real change detection) or diffs an incompatible old format (the spurious "everything changed").
describe('isBaselineStale', () => {
  it('is stale when no baseline is stored', () => {
    expect(isBaselineStale(null)).toBe(true)
  })

  it('is stale when the schemaVersion is older/different', () => {
    expect(isBaselineStale({ schemaVersion: 1, workspaces: {} } as unknown as SeedHashesManifest)).toBe(true)
  })

  it('is stale when schemaVersion is absent (pre-versioning baseline)', () => {
    expect(isBaselineStale({ workspaces: {} } as unknown as SeedHashesManifest)).toBe(true)
  })

  it('is fresh when the schemaVersion matches the current one', () => {
    expect(isBaselineStale(stored)).toBe(false)
  })
})

// diffSeedHashes is the brain of change detection. It must catch added/modified/removed at the
// entity level and, for a whole workspace added/removed, still list the children so the user sees
// what they gain or lose.
describe('diffSeedHashes', () => {
  const ws = (over: Partial<SeedEntityHashes>): SeedEntityHashes => ({ ...emptyEntity('w'), ...over })
  const types = (cs: ReturnType<typeof diffSeedHashes>) =>
    cs.map((c) => `${c.entityType}:${c.entityId}:${c.changeType}`).sort()

  it('reports no changes for identical baselines', () => {
    const a: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ projects: { p1: 'h' } }) } }
    expect(diffSeedHashes(a, a)).toEqual([])
  })

  it('detects a modified entity (hash changed)', () => {
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ projects: { p1: 'old' } }) } }
    const c: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ projects: { p1: 'new' } }) } }
    expect(types(diffSeedHashes(s, c))).toEqual(['project:p1:modified'])
  })

  it('detects an added and a removed entity', () => {
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ datasets: { d1: 'h' } }) } }
    const c: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ datasets: { d2: 'h' } }) } }
    expect(types(diffSeedHashes(s, c))).toEqual(['dataset:d1:removed', 'dataset:d2:added'])
  })

  it('flags workspace metadata changes (workspace hash)', () => {
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ workspace: 'm1' }) } }
    const c: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ workspace: 'm2' }) } }
    expect(types(diffSeedHashes(s, c))).toEqual(['workspace:w:modified'])
  })

  // A folder is a location, not an identity. Swapping the bundled default workspace for
  // another reuses `default/`; reading that as an edit updated the old workspace in place
  // and created the new one beside it, leaving the old row orphaned with its children gone.
  it('reports a replaced workspace as removed + added, not modified', () => {
    const s: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: { ...ws({ workspace: 'm1' }), workspaceIdentity: 'old-id' } },
    }
    const c: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: { ...ws({ workspace: 'm2' }), workspaceIdentity: 'new-id' } },
    }
    expect(types(diffSeedHashes(s, c))).toEqual(['workspace:w:added', 'workspace:w:removed'])
  })

  it("reports a replaced workspace's children as removed + added, id reuse and all", () => {
    // Both workspaces ship a project under the same id. Diffing them pairwise called it
    // "modified" — one entity edited — when they are two: one leaving with the old
    // workspace, one arriving with the new.
    const s: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: {
        w: { ...ws({ workspace: 'm1', projects: { p1: 'h1' } }), workspaceIdentity: 'old-id' },
      },
    }
    const c: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: {
        w: { ...ws({ workspace: 'm2', projects: { p1: 'h2' } }), workspaceIdentity: 'new-id' },
      },
    }
    expect(types(diffSeedHashes(s, c))).toEqual([
      'project:p1:added', 'project:p1:removed',
      'workspace:w:added', 'workspace:w:removed',
    ])
  })

  it('still reports a same-identity edit as modified', () => {
    const s: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: { ...ws({ workspace: 'm1' }), workspaceIdentity: 'same' } },
    }
    const c: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: { ...ws({ workspace: 'm2' }), workspaceIdentity: 'same' } },
    }
    expect(types(diffSeedHashes(s, c))).toEqual(['workspace:w:modified'])
  })

  it('treats an identity appearing where there was none as a replacement', () => {
    // An identity-less baseline never reaches the diff — it fails the schema-version
    // check and is reset first — so this asymmetry is a real difference, not a stale
    // baseline to be tolerated.
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ workspace: 'm1' }) } }
    const c: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: { ...ws({ workspace: 'm2' }), workspaceIdentity: 'new-id' } },
    }
    expect(types(diffSeedHashes(s, c))).toEqual(['workspace:w:added', 'workspace:w:removed'])
  })

  it('leaves an identity-less pair to the hash comparison', () => {
    // Neither side declares one (a workspace export without id or lineageId): nothing
    // to compare, so the metadata hash decides — never a spurious replacement.
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ workspace: 'm1' }) } }
    const c: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: { w: ws({ workspace: 'm2' }) } }
    expect(types(diffSeedHashes(s, c))).toEqual(['workspace:w:modified'])
  })

  it('lists children when a whole workspace is added', () => {
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: {} }
    const c: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: ws({ projects: { p1: 'h' }, datasets: { d1: 'h' } }) },
    }
    expect(types(diffSeedHashes(s, c))).toEqual(['dataset:d1:added', 'project:p1:added', 'workspace:w:added'])
  })

  it('lists children when a whole workspace is removed', () => {
    const s: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: ws({ projects: { p1: 'h' }, dashboards: { db1: 'h' } }) },
    }
    const c: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: {} }
    expect(types(diffSeedHashes(s, c))).toEqual(['dashboard:db1:removed', 'project:p1:removed', 'workspace:w:removed'])
  })

  it('labels an entity with its readable name when available', () => {
    const names = {
      databases: {}, conceptMappings: {}, etlScripts: {}, datasets: {},
      dashboards: {}, projects: { p1: 'My Project' }, mappingProjects: {}, dqRuleSets: {}, catalogs: {},
    }
    const s: SeedHashesManifest = { schemaVersion: SEED_HASHES_SCHEMA_VERSION, workspaces: {} }
    const c: SeedHashesManifest = {
      schemaVersion: SEED_HASHES_SCHEMA_VERSION,
      workspaces: { w: { ...ws({ projects: { p1: 'h' } }), names } },
    }
    const proj = diffSeedHashes(s, c).find((x) => x.entityType === 'project')
    expect(proj?.entityLabel).toBe('My Project')
  })
})
