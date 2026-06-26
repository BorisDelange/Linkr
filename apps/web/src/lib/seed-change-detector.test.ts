import { describe, it, expect } from 'vitest'
import { mergeSeedHashesFor } from './seed-change-detector'
import type { SeedHashesManifest } from '../../vite-plugin-seed-hashes'

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
  schemaVersion: 2,
  workspaces: {
    ricdc: { ...emptyEntity('w0'), projects: { neoclip: 'old1', other: 'old2' } },
  },
}

const current: SeedHashesManifest = {
  schemaVersion: 2,
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
      schemaVersion: 2,
      workspaces: { ricdc: { ...emptyEntity('w0'), projects: { other: 'old2' } } },
    }
    const merged = mergeSeedHashesFor(stored, currentRemoved, [
      { workspaceFolder: 'ricdc', entityType: 'project', entityId: 'neoclip' },
    ])
    expect('neoclip' in merged.workspaces.ricdc.projects).toBe(false)
  })

  it('copies a brand-new workspace wholesale', () => {
    const currentNew: SeedHashesManifest = {
      schemaVersion: 2,
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
})
