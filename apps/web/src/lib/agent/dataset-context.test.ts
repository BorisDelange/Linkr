import { describe, expect, it } from 'vitest'
import type { DatasetColumn } from '@/types'
import { datasetContext, datasetsContext } from './dataset-context'

function col(partial: Partial<DatasetColumn> & { name: string }): DatasetColumn {
  return {
    id: `col_${partial.name}`,
    type: 'string',
    order: 0,
    ...partial,
  } as DatasetColumn
}

describe('datasetContext', () => {
  it('lists id, name, row count and one line per column', () => {
    const out = datasetContext({
      id: 'ds_patients',
      name: 'patients',
      rowCount: 1420,
      columns: [
        col({ name: 'age', type: 'number', order: 0 }),
        col({ name: 'sex', type: 'string', order: 1 }),
      ],
    })
    expect(out).toContain('ds_patients — patients (1420 rows)')
    expect(out).toContain('  age (number)')
    expect(out).toContain('  sex (string)')
  })

  it('includes the human label and description', () => {
    const out = datasetContext({
      id: 'ds',
      name: 'd',
      columns: [
        col({
          name: 'sofa_d1',
          type: 'number',
          label: 'SOFA at day 1',
          description: 'Total SOFA score computed on admission day.',
        }),
      ],
    })
    expect(out).toContain('sofa_d1 (number, "SOFA at day 1")')
    expect(out).toContain('— Total SOFA score computed on admission day.')
  })

  it('omits the label when it merely repeats the technical name', () => {
    const out = datasetContext({
      id: 'ds',
      name: 'd',
      columns: [col({ name: 'age', type: 'number', label: 'age' })],
    })
    expect(out).toBe('ds — d\n  age (number)')
  })

  it('exposes categorical value labels so codes are interpretable', () => {
    const out = datasetContext({
      id: 'ds',
      name: 'd',
      columns: [col({ name: 'sex', valueLabels: { M: 'Male', F: 'Female' } })],
    })
    expect(out).toContain('[values: M=Male, F=Female]')
  })

  it('caps value labels and says how many were dropped', () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`c${i}`, `Label ${i}`])
    )
    const out = datasetContext({
      id: 'ds',
      name: 'd',
      columns: [col({ name: 'centre', valueLabels: many })],
    })
    expect(out).toContain('…+8')
    expect(out).not.toContain('c15=')
  })

  it('sorts columns by their stored order, not by object key order', () => {
    const out = datasetContext({
      id: 'ds',
      name: 'd',
      columns: [
        col({ name: 'third', order: 2 }),
        col({ name: 'first', order: 0 }),
        col({ name: 'second', order: 1 }),
      ],
    })
    const lines = out.split('\n').slice(1)
    expect(lines.map((l) => l.trim().split(' ')[0])).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('handles an empty dataset list', () => {
    expect(datasetsContext([])).toBe('No datasets available.')
  })

  it('never emits anything beyond schema metadata', () => {
    // Guards the copilot's core safety rule: the context builder must not grow a
    // "sample rows" or "preview" feature. If a future change adds row data here,
    // this test is the tripwire.
    const out = datasetContext({
      id: 'ds',
      name: 'labs',
      rowCount: 3,
      columns: [
        col({ name: 'patient_id', order: 0 }),
        col({ name: 'lactate', type: 'number', order: 1 }),
      ],
      // A caller passing extra payload must not leak it into the prompt.
      ...({ rows: [{ patient_id: 'P001', lactate: 4.2 }] } as object),
    })
    expect(out).not.toContain('P001')
    expect(out).not.toContain('4.2')
  })
})
