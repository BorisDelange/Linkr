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
  it('selects everything except data files', () => {
    const paths = ['project.json', 'datasets/c/data.csv', 'dashboards/d.json', 'datasets/_tree.json']
    expect(defaultSelectedPaths(paths)).toEqual(['project.json', 'dashboards/d.json', 'datasets/_tree.json'])
  })
})
