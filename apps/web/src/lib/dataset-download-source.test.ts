import { describe, expect, it } from 'vitest'
import type { DatasetOp } from '@linkr/format'
import { rawFileRepresentsDataset } from './dataset-download-source'

const op = (): DatasetOp => ({
  id: 'o1', at: 0, type: 'addColumn', column: 'col_weight', name: 'weight', colType: 'number',
})

describe('rawFileRepresentsDataset', () => {
  it('trusts the raw file while nothing has been edited', () => {
    expect(rawFileRepresentsDataset({ ops: undefined })).toBe(true)
    expect(rawFileRepresentsDataset({ ops: [] })).toBe(true)
  })

  it('stops trusting it once an op is recorded', () => {
    // The regression: a collection dataset's raw file is the near-empty CSV written
    // at setup, so downloading it returned the identity columns alone and none of
    // the variables added afterwards.
    expect(rawFileRepresentsDataset({ ops: [op()] })).toBe(false)
  })
})
