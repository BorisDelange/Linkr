import { describe, it, expect } from 'vitest'
import { isDataFile, defaultSelectedPaths, isForeignPath } from './git-file-classify'

describe('isForeignPath', () => {
  it('flags files no scope rule recognises (another tool wrote them)', () => {
    expect(isForeignPath('mapping-projects', 'review/app.js')).toBe(true)
    expect(isForeignPath('mapping-projects', 'state.json')).toBe(true)
    expect(isForeignPath('projects', 'weird/unknown.xyz')).toBe(true)
  })

  it('never flags .gitignore/.gitattributes — Linkr-managed even when category is "other"', () => {
    // In a scope without an explicit gitignore rule these fall to 'other', but they
    // are Linkr's own config and must not be treated as foreign.
    expect(isForeignPath('data-catalogs', '.gitignore')).toBe(false)
    expect(isForeignPath('data-catalogs', '.gitattributes')).toBe(false)
    expect(isForeignPath('projects', '.gitignore')).toBe(false)
  })

  it('never flags a patient board — Linkr writes that folder, so Sync all must carry it', () => {
    expect(isForeignPath('projects', 'patient-dashboards/icu.json')).toBe(false)
  })

  it('never flags recognised content', () => {
    expect(isForeignPath('projects', 'project.json')).toBe(false)
    expect(isForeignPath('projects', 'dashboards/d.json')).toBe(false)
  })

  it('does not treat a pipeline\'s own scripts as foreign', () => {
    // They used to fall to 'other' for want of a scope rule, which made "Sync all"
    // skip them and left them unchecked by default — the user had to tick every
    // script by hand to commit their own pipeline.
    expect(isForeignPath('etl-pipelines', '00_vocabulary.sql')).toBe(false)
    expect(isForeignPath('etl-pipelines', 'transform.py')).toBe(false)
    expect(isForeignPath('etl-pipelines', 'mapping/source_to_concept_map.csv')).toBe(false)
  })
})

// Health data must never be pushed to git by default, so the commit list leaves
// data files unchecked — this must match the export tab's includeDataFiles rule.
describe('isDataFile', () => {
  it('flags dataset CSV / parquet / excel as data', () => {
    expect(isDataFile('datasets/cohort/data.csv')).toBe(true)
    expect(isDataFile('datasets/cohort/rows.parquet')).toBe(true)
    expect(isDataFile('datasets/cohort/x.xlsx')).toBe(true)
    expect(isDataFile('datasets/cohort/x.xls')).toBe(true)
  })

  it('flags the raw row dump _data.json as data', () => {
    expect(isDataFile('datasets/cohort/_data.json')).toBe(true)
  })

  it('keeps dataset metadata (tree/columns/analysis) as non-data', () => {
    expect(isDataFile('datasets/_tree.json')).toBe(false)
    expect(isDataFile('datasets/cohort/_columns.json')).toBe(false)
    expect(isDataFile('datasets/cohort/my-analysis.json')).toBe(false)
  })

  it('never flags files outside datasets/', () => {
    expect(isDataFile('project.json')).toBe(false)
    expect(isDataFile('README.md')).toBe(false)
    expect(isDataFile('dashboards/main.json')).toBe(false)
    expect(isDataFile('scripts/analysis.csv')).toBe(false) // a CSV in scripts/ is code-adjacent, not dataset data
  })

  it('is case-insensitive on extension and folder', () => {
    expect(isDataFile('datasets/Cohort/DATA.CSV')).toBe(true)
  })
})

describe('defaultSelectedPaths', () => {
  const f = (path: string, changeType = 'modified') => ({ path, changeType })

  it('selects data files too — a data file only reaches the status when marked for versioning, so its presence is consent', () => {
    const files = [f('project.json'), f('datasets/c/data.csv'), f('dashboards/d.json'), f('datasets/_tree.json')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json', 'datasets/c/data.csv', 'dashboards/d.json', 'datasets/_tree.json'])
  })

  it('selects a deletion of a Linkr-OWNED file (its removal is a genuine deletion to push)', () => {
    const files = [f('project.json'), f('dashboards/old.json', 'deleted'), f('scripts/gone.sql', 'deleted')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json', 'dashboards/old.json', 'scripts/gone.sql'])
  })

  it('leaves a deletion of an UNOWNED (other-category) file unchecked (review/, state.json)', () => {
    const files = [f('project.json'), f('review/app.js', 'deleted'), f('state.json', 'deleted')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json'])
  })

  it('leaves a MODIFIED .gitignore/.gitattributes unchecked for a scope Linkr does not fully own (would clobber a hand-enriched remote)', () => {
    const files = [f('project.json'), f('.gitignore', 'modified'), f('.gitattributes', 'modified')]
    expect(defaultSelectedPaths('mapping-projects', files)).toEqual(['project.json'])
  })

  it('selects a MODIFIED project .gitignore/.gitattributes (Linkr owns them — the change IS the mark/LFS toggle to push)', () => {
    const files = [f('project.json'), f('.gitignore', 'modified'), f('.gitattributes', 'modified')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json', '.gitignore', '.gitattributes'])
  })

  it('selects an ADDED .gitignore (Linkr\'s copy is the only one)', () => {
    const files = [f('.gitignore', 'added'), f('.gitattributes', 'added')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['.gitignore', '.gitattributes'])
  })

  it('leaves a DELETED .gitignore/.gitattributes unchecked (would erase a hand-enriched remote copy)', () => {
    const files = [f('project.json'), f('.gitignore', 'deleted'), f('.gitattributes', 'deleted')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json'])
  })
})
