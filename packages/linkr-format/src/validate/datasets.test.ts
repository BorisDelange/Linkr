import { describe, expect, it } from 'vitest'
import { IssueBag } from '../issue.js'
import { MemoryTree } from '../tree.js'
import { validateDatasets } from './datasets.js'

function run(files: Record<string, string>) {
  const bag = new IssueBag()
  const index = validateDatasets(new MemoryTree(files), bag)
  return { issues: bag.all(), index }
}

const tree = (columns: unknown[], name = 'patients.csv') =>
  JSON.stringify([{ id: name, name, type: 'file', columns }])

describe('validateDatasets', () => {
  it('accepts a tree whose columns match the data file', () => {
    const { issues, index } = run({
      'datasets/_tree.json': tree([
        { id: 'col_age', name: 'age', type: 'number' },
        { id: 'col_sex', name: 'sex', type: 'string' },
      ]),
      'datasets/patients/patients.csv': 'age,sex\n60,M\n',
    })
    expect(issues).toEqual([])
    expect(index.datasets.get('patients.csv')?.columnIds).toEqual(new Set(['col_age', 'col_sex']))
  })

  it('accepts a project with no datasets at all', () => {
    expect(run({}).issues).toEqual([])
  })

  it('flags a column declared in the tree but absent from the data file', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([
        { id: 'col_age', name: 'age' },
        { id: 'col_ward', name: 'ward' },
      ]),
      'datasets/patients/patients.csv': 'age\n60\n',
    })
    const mismatch = issues.find((i) => i.code === 'csv-header-mismatch')
    expect(mismatch?.severity).toBe('error')
    expect(mismatch?.hint).toContain('ward')
  })

  it('flags a data-file column missing from the tree', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([{ id: 'col_age', name: 'age' }]),
      'datasets/patients/patients.csv': 'age,ward\n60,ICU\n',
    })
    expect(issues.some((i) => i.code === 'csv-header-mismatch')).toBe(true)
  })

  it('flags a column id that does not derive from its name', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([{ id: 'col_wrong', name: 'age' }]),
      'datasets/patients/patients.csv': 'age\n60\n',
    })
    const mismatch = issues.find((i) => i.code === 'column-id-mismatch')
    expect(mismatch?.severity).toBe('error')
    expect(mismatch?.hint).toContain('col_age')
  })

  it('accepts deterministic collision suffixes', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([
        { id: 'col_hospit_unit', name: 'hospit unit' },
        { id: 'col_hospit_unit_2', name: 'hospit_unit' },
      ]),
      'datasets/patients/patients.csv': 'hospit unit,hospit_unit\nA,B\n',
    })
    // Both names normalise onto one slug; `_2` is the app's own collision scheme.
    expect(issues.filter((i) => i.code === 'column-id-mismatch')).toEqual([])
  })

  it('flags a collision suffix handed out in the wrong order', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([
        { id: 'col_hospit_unit_2', name: 'hospit unit' },
        { id: 'col_hospit_unit', name: 'hospit_unit' },
      ]),
      'datasets/patients/patients.csv': 'hospit unit,hospit_unit\nA,B\n',
    })
    // Suffixes are assigned in header order, so swapping them is a real defect:
    // the app would re-derive the other id and orphan whatever pointed here.
    expect(issues.some((i) => i.code === 'column-id-mismatch')).toBe(true)
  })

  it('reports a legacy positional id as a warning, not an error', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([{ id: 'col-0', name: 'age' }]),
      'datasets/patients/patients.csv': 'age\n60\n',
    })
    const legacy = issues.find((i) => i.code === 'legacy-format')
    expect(legacy?.severity).toBe('warning')
    expect(issues.some((i) => i.severity === 'error')).toBe(false)
  })

  it('flags a missing data file', () => {
    const { issues } = run({ 'datasets/_tree.json': tree([{ id: 'col_age', name: 'age' }]) })
    expect(issues.some((i) => i.code === 'missing-file')).toBe(true)
  })

  it('flags duplicate column ids', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([
        { id: 'col_age', name: 'age' },
        { id: 'col_age', name: 'age' },
      ]),
      'datasets/patients/patients.csv': 'age,age\n60,61\n',
    })
    expect(issues.some((i) => i.code === 'duplicate-key')).toBe(true)
  })

  it('flags an unknown column type', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([{ id: 'col_age', name: 'age', type: 'integer' }]),
      'datasets/patients/patients.csv': 'age\n60\n',
    })
    const wrong = issues.find((i) => i.code === 'wrong-type')
    expect(wrong?.hint).toContain('number')
  })

  it('reads a quoted CSV header', () => {
    const { issues } = run({
      'datasets/_tree.json': tree([
        { id: 'col_full_name', name: 'full name' },
        { id: 'col_age', name: 'age' },
      ]),
      'datasets/patients/patients.csv': '"full name","age"\n"Doe, J",60\n',
    })
    expect(issues.filter((i) => i.code === 'csv-header-mismatch')).toEqual([])
  })

  it('reports a JSON syntax error rather than throwing', () => {
    const { issues } = run({ 'datasets/_tree.json': '[{' })
    expect(issues[0]?.code).toBe('invalid-json')
  })
})
