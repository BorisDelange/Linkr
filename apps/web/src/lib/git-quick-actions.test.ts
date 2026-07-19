import { describe, it, expect } from 'vitest'
import { buildQuickActions } from './git-quick-actions'

describe('buildQuickActions', () => {
  it('returns no actions for a scope without presets', () => {
    expect(buildQuickActions('projects', ['project.json'])).toEqual([])
  })

  it('mapping-projects: Sync all takes every changed path (order preserved)', () => {
    const changed = ['project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/ranges.json']
    const [all] = buildQuickActions('mapping-projects', changed)
    expect(all.labelKey).toBe('versioning.quick_sync_all')
    expect(all.paths).toEqual(changed)
  })

  it('mapping-projects: Sync mappings narrows to project.json + mappings.{json,csv}', () => {
    const changed = ['project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/entries.json']
    const [, mappings] = buildQuickActions('mapping-projects', changed)
    expect(mappings.labelKey).toBe('versioning.quick_sync_mappings')
    expect(mappings.paths).toEqual(['project.json', 'mappings.json'])
  })

  it('an action whose patterns match nothing gets an empty path list', () => {
    // Only a source-concepts change: "Sync mappings" matches nothing.
    const [all, mappings] = buildQuickActions('mapping-projects', ['source-concepts.csv'])
    expect(all.paths).toEqual(['source-concepts.csv'])
    expect(mappings.paths).toEqual([])
  })

  it('matches mappings.csv as well as mappings.json', () => {
    const [, mappings] = buildQuickActions('mapping-projects', ['mappings.csv'])
    expect(mappings.paths).toEqual(['mappings.csv'])
  })
})
