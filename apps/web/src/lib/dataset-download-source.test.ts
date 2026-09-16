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

  it('cannot tell "unedited" from "log not loaded" — the CALLER must', () => {
    // Both read as `ops: undefined` here, and this function answers the same for
    // each. That is not a flaw in it: it takes what it is given. But the dataset
    // LISTING carries no log (resolved lazily, per file, on open), so a download
    // straight from the tree once handed back the pre-edit source file of an edited
    // dataset. The caller resolves the meta first; this test records why it must.
    expect(rawFileRepresentsDataset({ ops: undefined })).toBe(true)
  })
})
