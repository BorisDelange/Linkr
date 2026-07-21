import { describe, it, expect } from 'vitest'
import { buildQuickActions } from './git-quick-actions'

describe('buildQuickActions', () => {
  it('returns no actions for a scope without presets', () => {
    expect(buildQuickActions('etl-pipelines', ['_pipeline.json'])).toEqual([])
  })

  it('projects: Sync all takes every changed path; per-group actions narrow', () => {
    const changed = ['project.json', 'scripts/a.sql', 'dashboards/d.json', 'cohorts/c.json']
    const [all, dashboards, scripts] = buildQuickActions('projects', changed)
    expect(all.labelKey).toBe('versioning.quick_sync_all')
    expect(all.paths).toEqual(changed)
    expect(dashboards.paths).toEqual(['dashboards/d.json'])
    expect(scripts.paths).toEqual(['scripts/a.sql'])
  })

  it('mapping-projects: Sync all takes every changed path (order preserved)', () => {
    const changed = ['project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/ranges.json']
    const [all] = buildQuickActions('mapping-projects', changed)
    expect(all.labelKey).toBe('versioning.quick_sync_all')
    expect(all.descriptionKey).toBe('versioning.quick_desc_all')
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

  it('Sync all drops "other" (unrecognised) files but keeps .gitignore', () => {
    // review/*, state.json, a custom CSV aren't in the taxonomy → "other" (dropped).
    // .gitignore IS part of the exported tree → recognised, kept.
    const changed = ['project.json', 'mappings.json', 'review/app.js', 'state.json', 'hosp_units_cleaned.csv', '.gitignore', 'source-concepts.csv']
    const [all] = buildQuickActions('mapping-projects', changed)
    expect(all.paths).toEqual(['project.json', 'mappings.json', '.gitignore', 'source-concepts.csv'])
  })
})
