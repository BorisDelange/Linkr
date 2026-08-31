import { describe, it, expect } from 'vitest'
import { buildQuickActions } from './git-quick-actions'
import type { GitFileChange, GitScope } from '@/lib/api/git'

/** Build change rows from paths; default change type "modified" (or pass [path, type]). */
const ch = (...items: (string | [string, string])[]): GitFileChange[] =>
  items.map((it) => {
    const [path, changeType] = Array.isArray(it) ? it : [it, 'modified']
    return { path, changeType: changeType as GitFileChange['changeType'], size: 1 }
  })

const paths = (a: { files: { path: string }[] }) => a.files.map((f) => f.path)

describe('buildQuickActions', () => {
  it('returns no actions for an unknown scope (the panel then shows Details only)', () => {
    expect(buildQuickActions('nope' as GitScope, ch('_pipeline.json'))).toEqual([])
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

  it('projects: Sync all carries a patient board (it was dropped as a foreign file)', () => {
    // patient-dashboards/ had no rule in git-file-meta, so it fell to the 'other'
    // category and excludeForeign silently dropped it: creating a patient board
    // left nothing to push.
    const changed = ch('project.json', 'patient-dashboards/icu.json')
    const [all] = buildQuickActions('projects', changed)
    expect(paths(all)).toEqual(['project.json', 'patient-dashboards/icu.json'])
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

  it('mapping-projects: Sync all is the ONLY card, and takes everything owned', () => {
    // Per-kind cards were dropped: `stats` in project.json is derived from
    // mappings.json, so a card pushing one without the other committed a repo
    // contradicting itself. A genuine subset belongs in the Details tab.
    const changed = ch('project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/entries.json')
    const actions = buildQuickActions('mapping-projects', changed)
    expect(actions).toHaveLength(1)
    expect(actions[0].labelKey).toBe('versioning.quick_sync_all')
    expect(paths(actions[0])).toEqual([
      'project.json', 'mappings.json', 'source-concepts.csv', 'source-concept-ids/entries.json',
    ])
  })

  it('sql-script-collections: Sync all only, taking every changed path', () => {
    const changed = ch('_collection.json', '_tree.json', 'folder/query.sql', 'README.md')
    const actions = buildQuickActions('sql-script-collections', changed)
    expect(actions).toHaveLength(1)
    expect(actions[0].labelKey).toBe('versioning.quick_sync_all')
    expect(actions[0].descriptionKey).toBe('versioning.quick_desc_all_collection')
    expect(actions[0].isSyncAll).toBe(true)
    expect(paths(actions[0])).toEqual(['_collection.json', '_tree.json', 'folder/query.sql', 'README.md'])
  })

  it('every git scope offers a Quick actions tab (a scope with no action has none)', () => {
    const scopes: GitScope[] = [
      'projects', 'workspaces', 'mapping-projects', 'sql-script-collections',
      'etl-pipelines', 'data-catalogs', 'dq-rule-sets', 'schema-presets',
      'databases', 'user-plugins', 'settings',
    ]
    for (const scope of scopes) {
      const actions = buildQuickActions(scope, ch('_tree.json'))
      expect(actions.length, scope).toBeGreaterThan(0)
      // The first preset is always the primary "Sync all" (shared accent colour).
      expect(actions[0].labelKey, scope).toBe('versioning.quick_sync_all')
      expect(actions[0].isSyncAll, scope).toBe(true)
    }
  })

  it('the single-entity scopes expose Sync all and nothing else', () => {
    for (const scope of ['etl-pipelines', 'data-catalogs', 'dq-rule-sets', 'schema-presets', 'databases', 'user-plugins'] as GitScope[]) {
      expect(buildQuickActions(scope, ch('_tree.json')), scope).toHaveLength(1)
    }
  })

  it('databases: Sync all takes metadata and docs together', () => {
    const changed = ch('_database.json', 'mapping.json', 'schema.ddl', 'README.md', 'LICENSE.md', 'attachments/logo.png')
    const [all] = buildQuickActions('databases', changed)
    expect(all.labelKey).toBe('versioning.quick_sync_all')
    expect(all.isSyncAll).toBe(true)
    expect(paths(all)).toEqual([
      '_database.json', 'mapping.json', 'schema.ddl', 'README.md', 'LICENSE.md', 'attachments/logo.png',
    ])
  })

  it('databases: Sync all never touches data/, so a one-click push cannot drop the remote tables', () => {
    // Linkr publishes metadata only, so a repo that ships its own tables reports
    // every data/ file as deleted in each status — without the user having
    // removed anything. Dropping them stays possible, per file, from Details.
    const changed = ch(
      ['_database.json', 'modified'], ['data/person.parquet', 'deleted'], ['data/visit.parquet', 'deleted'],
    )
    const [all] = buildQuickActions('databases', changed)
    expect(paths(all)).toEqual(['_database.json'])
  })

  it('Sync all drops foreign files and modified repo config, keeps added config', () => {
    // review/*, state.json, a custom CSV aren't Linkr's → foreign (dropped).
    // A MODIFIED .gitignore/.gitattributes may clobber a hand-enriched remote
    // copy → left to Details, like the default selection. ADDED ones are Linkr's
    // only copy → kept.
    const changed = ch(
      'project.json', 'mappings.json', 'review/app.js', 'state.json', 'hosp_units_cleaned.csv',
      ['.gitignore', 'modified'], ['.gitattributes', 'added'], 'source-concepts.csv',
    )
    const [all] = buildQuickActions('mapping-projects', changed)
    expect(paths(all)).toEqual(['project.json', 'mappings.json', '.gitattributes', 'source-concepts.csv'])
  })

  it('Sync all keeps a modified .gitignore in the projects scope (Linkr fully owns it there)', () => {
    const changed = ch(['project.json', 'modified'], ['.gitignore', 'modified'])
    const [all] = buildQuickActions('projects', changed)
    expect(paths(all)).toEqual(['project.json', '.gitignore'])
  })

  it('Sync all never proposes deleting repo config or foreign files', () => {
    const changed = ch(['mappings.json', 'deleted'], ['.gitignore', 'deleted'], ['state.json', 'deleted'])
    const [all] = buildQuickActions('mapping-projects', changed)
    // A Linkr-owned file deletion is genuine and stays; config/foreign deletions don't.
    expect(paths(all)).toEqual(['mappings.json'])
  })
})
