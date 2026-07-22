import { describe, it, expect } from 'vitest'
import { isDataFile, defaultSelectedPaths } from './git-file-classify'

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

  it('selects everything except data files', () => {
    const files = [f('project.json'), f('datasets/c/data.csv'), f('dashboards/d.json'), f('datasets/_tree.json')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json', 'dashboards/d.json', 'datasets/_tree.json'])
  })

  it('selects a deletion of a Linkr-OWNED file (its removal is a genuine deletion to push)', () => {
    const files = [f('project.json'), f('dashboards/old.json', 'deleted'), f('scripts/gone.sql', 'deleted')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json', 'dashboards/old.json', 'scripts/gone.sql'])
  })

  it('leaves a deletion of an UNOWNED (other-category) file unchecked (review/, state.json)', () => {
    const files = [f('project.json'), f('review/app.js', 'deleted'), f('state.json', 'deleted')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json'])
  })

  it('leaves a MODIFIED .gitignore/.gitattributes unchecked (would clobber a hand-enriched remote copy)', () => {
    const files = [f('project.json'), f('.gitignore', 'modified'), f('.gitattributes', 'modified')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['project.json'])
  })

  it('selects an ADDED .gitignore (Linkr\'s copy is the only one)', () => {
    const files = [f('.gitignore', 'added'), f('.gitattributes', 'added')]
    expect(defaultSelectedPaths('projects', files)).toEqual(['.gitignore', '.gitattributes'])
  })
})
