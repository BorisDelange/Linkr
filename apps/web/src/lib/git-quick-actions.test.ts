import { describe, it, expect } from 'vitest'
import { buildQuickActions } from './git-quick-actions'
import type { GitFileChange } from '@/lib/api/git'

/** Build change rows from paths; default change type "modified" (or pass [path, type]). */
const ch = (...items: (string | [string, string])[]): GitFileChange[] =>
  items.map((it) => {
    const [path, changeType] = Array.isArray(it) ? it : [it, 'modified']
    return { path, changeType: changeType as GitFileChange['changeType'], size: 1 }
  })

const paths = (a: { files: { path: string }[] }) => a.files.map((f) => f.path)

describe('buildQuickActions', () => {
  it('returns no actions for a scope without presets', () => {
    expect(buildQuickActions('etl-pipelines', ch('_pipeline.json'))).toEqual([])
  })

  it('projects: Sync all takes every changed path; per-group actions narrow', () => {
    const changed = ch('project.json', 'scripts/a.sql', 'dashboards/d.json', 'cohorts/c.json')
    const [all, dashboards, scripts] = buildQuickActions('projects', changed)
    expect(all.labelKey).toBe('versioning.quick_sync_all')
    expect(all.isSyncAll).toBe(true)
    expect(paths(all)).toEqual(['project.json', 'scripts/a.sql', 'dashboards/d.json', 'cohorts/c.json'])
    expect(paths(dashboards)).toEqual(['dashboards/d.json'])
    expect(dashboards.isSyncAll).toBe(false)
    expect(paths(scripts)).toEqual(['scripts/a.sql'])
  })

  it('carries each file change type through to the action files (badges)', () => {
    const changed = ch(['project.json', 'modified'], ['dashboards/d.json', 'added'], ['dashboards/old.json', 'deleted'])
    const [all] = buildQuickActions('projects', changed)
    expect(all.files).toEqual([
      { path: 'project.json', changeType: 'modified' },
      { path: 'dashboards/d.json', changeType: 'added' },
      { path: 'dashboards/old.json', changeType: 'deleted' },
    ])
  })

  it('mapping-projects: Sync all takes every changed path (order preserved)', () => {
    const changed = ch('project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/ranges.json')
    const [all] = buildQuickActions('mapping-projects', changed)
    expect(all.labelKey).toBe('versioning.quick_sync_all')
    expect(all.descriptionKey).toBe('versioning.quick_desc_all')
    expect(paths(all)).toEqual(['project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/ranges.json'])
  })

  it('mapping-projects: Sync mappings narrows to project.json + mappings.{json,csv}', () => {
    const changed = ch('project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/entries.json')
    const [, mappings] = buildQuickActions('mapping-projects', changed)
    expect(mappings.labelKey).toBe('versioning.quick_sync_mappings')
    expect(paths(mappings)).toEqual(['project.json', 'mappings.json'])
  })

  it('an action whose patterns match nothing gets an empty file list', () => {
    // Only a source-concepts change: "Sync mappings" matches nothing.
    const [all, mappings] = buildQuickActions('mapping-projects', ch('source-concepts.csv'))
    expect(paths(all)).toEqual(['source-concepts.csv'])
    expect(paths(mappings)).toEqual([])
  })

  it('matches mappings.csv as well as mappings.json', () => {
    const [, mappings] = buildQuickActions('mapping-projects', ch('mappings.csv'))
    expect(paths(mappings)).toEqual(['mappings.csv'])
  })

  it('Sync all drops "other" (unrecognised) files but keeps .gitignore', () => {
    // review/*, state.json, a custom CSV aren't in the taxonomy → "other" (dropped).
    // .gitignore IS part of the exported tree → recognised, kept.
    const changed = ch('project.json', 'mappings.json', 'review/app.js', 'state.json', 'hosp_units_cleaned.csv', '.gitignore', 'source-concepts.csv')
    const [all] = buildQuickActions('mapping-projects', changed)
    expect(paths(all)).toEqual(['project.json', 'mappings.json', '.gitignore', 'source-concepts.csv'])
  })
})
