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

  it('says NOTHING when the data file is absent', () => {
    // Data is gitignored by default and re-included one file at a time, so a tree
    // carrying its columns without the rows is the normal — and for health data the
    // recommended — shape. It used to warn, which made importing a properly
    // anonymised project announce format problems it did not have; a panel that
    // cries wolf on the good case is one people stop reading.
    const { issues } = run({ 'datasets/_tree.json': tree([{ id: 'col_age', name: 'age' }]) })
    expect(issues).toEqual([])
  })

  // A dataset is `raw -> parse -> replay(journal)`: the tree describes the
  // MATERIALISED columns, the file holds only the raw ones. Comparing the two
  // directly reported every hand-added column as missing — so a manual collection,
  // which is made almost entirely of such columns, errored on its own export.
  describe('with an edit journal', () => {
    const edits = (...ops: unknown[]) => JSON.stringify({ ops })

    it('does not miss a column the journal added', () => {
      const { issues } = run({
        'datasets/_tree.json': tree([
          { id: 'col_age', name: 'age', type: 'number' },
          { id: 'col_hr', name: 'hr', type: 'number' },
        ]),
        'datasets/patients/patients.csv': 'age\n60\n',
        'datasets/patients/patients.edits.json': edits(
          { type: 'addColumn', column: 'col_hr', name: 'hr', colType: 'number' },
        ),
      })
      expect(issues).toEqual([])
    })

    it('does not flag a column the journal removed as undeclared', () => {
      const { issues } = run({
        'datasets/_tree.json': tree([{ id: 'col_age', name: 'age', type: 'number' }]),
        'datasets/patients/patients.csv': 'age,sex\n60,M\n',
        'datasets/patients/patients.edits.json': edits(
          { type: 'removeColumn', column: 'col_sex' },
        ),
      })
      expect(issues).toEqual([])
    })

    it('follows a renamed raw column from the file name to the tree name', () => {
      // A rename is a REKEY — ids derive from names — so the tree carries the new
      // id and the new name while the file still has the old header.
      const { issues } = run({
        'datasets/_tree.json': tree([{ id: 'col_age_years', name: 'age_years', type: 'number' }]),
        'datasets/patients/patients.csv': 'age\n60\n',
        'datasets/patients/patients.edits.json': edits(
          { type: 'renameColumn', column: 'col_age', to: 'col_age_years', toName: 'age_years' },
        ),
      })
      expect(issues).toEqual([])
    })

    it('handles a hand-added column that was then renamed', () => {
      // Only its latest name is in the tree, and it never reached the file at all.
      const { issues } = run({
        'datasets/_tree.json': tree([
          { id: 'col_age', name: 'age', type: 'number' },
          { id: 'col_heart_rate', name: 'heart_rate', type: 'number' },
        ]),
        'datasets/patients/patients.csv': 'age\n60\n',
        'datasets/patients/patients.edits.json': edits(
          { type: 'addColumn', column: 'col_hr', name: 'hr', colType: 'number' },
          { type: 'renameColumn', column: 'col_hr', to: 'col_heart_rate', toName: 'heart_rate' },
        ),
      })
      expect(issues).toEqual([])
    })

    it('still reports a genuine mismatch the journal does not explain', () => {
      // The check must not become a rubber stamp: a column in neither the file nor
      // the journal is a real problem and has to survive.
      const { issues } = run({
        'datasets/_tree.json': tree([
          { id: 'col_age', name: 'age', type: 'number' },
          { id: 'col_ghost', name: 'ghost', type: 'number' },
        ]),
        'datasets/patients/patients.csv': 'age\n60\n',
        'datasets/patients/patients.edits.json': edits(
          { type: 'setCell', row: 0, column: 'col_age', value: 61 },
        ),
      })
      expect(issues.some((i) => i.code === 'csv-header-mismatch')).toBe(true)
    })

    it('falls back to the plain check when the journal is unreadable', () => {
      // A truncated journal must not silence the header check — that would turn one
      // problem into a silent second one.
      const { issues } = run({
        'datasets/_tree.json': tree([
          { id: 'col_age', name: 'age', type: 'number' },
          { id: 'col_hr', name: 'hr', type: 'number' },
        ]),
        'datasets/patients/patients.csv': 'age\n60\n',
        'datasets/patients/patients.edits.json': '{ not json',
      })
      expect(issues.some((i) => i.code === 'csv-header-mismatch')).toBe(true)
    })
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

  it('accepts the "unknown" column type', () => {
    // Regression: `unknown` is what the parser assigns to a column it cannot type
    // (an all-empty one) and what an added column starts as, so rejecting it made a
    // project report errors on its OWN export the moment it was re-imported.
    const { issues } = run({
      'datasets/_tree.json': tree([{ id: 'col_age', name: 'age', type: 'unknown' }]),
      'datasets/patients/patients.csv': 'age\n60\n',
    })
    expect(issues.some((i) => i.code === 'wrong-type')).toBe(false)
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
