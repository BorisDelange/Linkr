import { describe, it, expect } from 'vitest'
import { gitFileMeta, groupGitFiles } from './git-file-meta'

// The sync panel groups files by category and shows a per-file description, so
// the path→category/description mapping must be stable and specific-before-broad.
describe('gitFileMeta', () => {
  it('classifies project files into distinct categories', () => {
    expect(gitFileMeta('projects', 'project.json').category).toBe('general')
    expect(gitFileMeta('projects', 'README.md').category).toBe('readme')
    expect(gitFileMeta('projects', 'README.fr.md').category).toBe('readme')
    expect(gitFileMeta('projects', 'scripts/analysis.R').category).toBe('scripts')
    expect(gitFileMeta('projects', 'datasets/cohort/data.csv').category).toBe('datasets')
    expect(gitFileMeta('projects', 'dashboards/overview.json').category).toBe('dashboards')
    expect(gitFileMeta('projects', 'cohorts/adults.json').category).toBe('cohorts')
  })

  it('matches the specific rule before the broad one (tree vs file)', () => {
    // scripts/_tree.json must be the "tree" description, not the generic script file.
    expect(gitFileMeta('projects', 'scripts/_tree.json').descriptionKey).toBe('versioning.file_desc_scripts_tree')
    expect(gitFileMeta('projects', 'scripts/a/b.sql').descriptionKey).toBe('versioning.file_desc_script_file')
    expect(gitFileMeta('projects', 'datasets/_tree.json').descriptionKey).toBe('versioning.file_desc_datasets_tree')
    expect(gitFileMeta('projects', 'datasets/x/_columns.json').descriptionKey).toBe('versioning.file_desc_dataset_columns')
  })

  it('classifies mapping-project files', () => {
    expect(gitFileMeta('mapping-projects', 'project.json').category).toBe('general')
    expect(gitFileMeta('mapping-projects', 'mappings.csv').category).toBe('mappings')
    expect(gitFileMeta('mapping-projects', 'source-concepts.csv').category).toBe('concepts')
    expect(gitFileMeta('mapping-projects', 'source-concept-ids/entries.json').category).toBe('concepts')
    expect(gitFileMeta('mapping-projects', 'similarity-scores.parquet').category).toBe('scores')
  })

  it('routes .gitattributes to its own trailing category everywhere', () => {
    for (const scope of ['projects', 'mapping-projects', 'sql-script-collections', 'user-plugins'] as const) {
      const m = gitFileMeta(scope, '.gitattributes')
      expect(m.category).toBe('attrs')
      expect(m.descriptionKey).toBe('versioning.file_desc_gitattributes')
    }
  })

  it('falls back to "other" with no description for unknown paths', () => {
    const m = gitFileMeta('projects', 'weird/unknown.xyz')
    expect(m.category).toBe('other')
    // No descriptionKey → the row shows no info icon (rather than a useless tooltip).
    expect(m.descriptionKey).toBeUndefined()
    expect(gitFileMeta('data-catalogs', 'not-a-known-file.txt').descriptionKey).toBeUndefined()
  })

  it('classifies the new entity scopes', () => {
    expect(gitFileMeta('etl-pipelines', '_pipeline.json').category).toBe('general')
    expect(gitFileMeta('data-catalogs', 'catalog.json').category).toBe('general')
    expect(gitFileMeta('dq-rule-sets', 'rule-set.json').category).toBe('general')
    expect(gitFileMeta('dq-rule-sets', 'checks.json').category).toBe('checks')
    expect(gitFileMeta('schema-presets', 'preset.json').category).toBe('general')
    expect(gitFileMeta('user-plugins', 'main.py').category).toBe('scripts')
    expect(gitFileMeta('user-plugins', 'plugin.json').category).toBe('general')
  })

  it('groups a workspace export by top-level entity kind', () => {
    const cat = (p: string) => gitFileMeta('workspaces', p).category
    expect(cat('workspace.json')).toBe('general')
    expect(cat('README.md')).toBe('readme')
    expect(cat('projects/neoclip/project.json')).toBe('projects')
    expect(cat('mapping-projects/adult-icu/project.json')).toBe('mapping_projects')
    expect(cat('databases/my-pg.json')).toBe('databases')
    expect(cat('wiki/intro--1.md')).toBe('wiki')
    expect(cat('sql-scripts/coll/query.sql')).toBe('sql')
    expect(cat('etl/pipe/_pipeline.json')).toBe('etl')
    expect(cat('data-quality/rs.json')).toBe('data_quality')
    expect(cat('catalogs/cat.json')).toBe('catalogs')
    expect(cat('service-mappings/sm.json')).toBe('catalogs')
    expect(cat('plugins/p/_plugin.json')).toBe('plugins')
    expect(cat('source-concept-ids/ranges.json')).toBe('concept_ids')
    expect(cat('git-links.json')).toBe('config')
    // Strays still fall through to "other".
    expect(cat('state.json')).toBe('other')
  })

  it('every workspace category carries an i18n description (no contentless rows)', () => {
    for (const p of [
      'workspace.json', 'projects/x/project.json', 'mapping-projects/x/project.json',
      'databases/x.json', 'wiki/x.md', 'sql-scripts/x/x.sql', 'etl/x/_pipeline.json',
      'data-quality/x.json', 'catalogs/x.json', 'plugins/x/_plugin.json',
      'source-concept-ids/ranges.json', 'git-links.json',
    ]) {
      expect(gitFileMeta('workspaces', p).descriptionKey).toBeTruthy()
    }
  })
})

describe('groupGitFiles', () => {
  it('groups by category, orders groups, preserves file order within a group', () => {
    const files = [
      { path: 'dashboards/a.json' },
      { path: 'project.json' },
      { path: '.gitattributes' },
      { path: 'dashboards/b.json' },
      { path: 'scripts/x.R' },
    ]
    const groups = groupGitFiles('projects', files, (f) => f.path)
    expect(groups.map((g) => g.category)).toEqual(['general', 'scripts', 'dashboards', 'attrs'])
    const dashboards = groups.find((g) => g.category === 'dashboards')!
    expect(dashboards.files.map((f) => f.path)).toEqual(['dashboards/a.json', 'dashboards/b.json'])
  })
})
