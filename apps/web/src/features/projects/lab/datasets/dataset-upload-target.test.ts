import { describe, expect, it } from 'vitest'
import {
  findDatasetConflict,
  resolveDatasetUploadTarget,
  type DatasetSibling,
} from './dataset-upload-target'

const file = (name: string, parentId: string | null = null): DatasetSibling => ({
  id: parentId ? `${parentId}/${name}` : name,
  name,
  type: 'file',
  parentId,
})
const folder = (name: string): DatasetSibling => ({ id: name, name, type: 'folder', parentId: null })

const SIBLINGS = [file('cohort.csv'), file('labs.csv'), folder('raw')]

describe('findDatasetConflict', () => {
  it('finds an exact name at the same parent', () => {
    expect(findDatasetConflict('cohort.csv', null, SIBLINGS)?.name).toBe('cohort.csv')
  })

  it('matches case-insensitively, which the old check did not', () => {
    // "Data.csv" beside "data.csv" is one file to git on macOS/Windows, and the
    // export tree could not hold both — the user must be offered the choice.
    expect(findDatasetConflict('COHORT.CSV', null, SIBLINGS)?.name).toBe('cohort.csv')
  })

  it('ignores a same-named file in ANOTHER folder', () => {
    const nested = [file('cohort.csv', 'raw')]
    expect(findDatasetConflict('cohort.csv', null, nested)).toBeNull()
    expect(findDatasetConflict('cohort.csv', 'raw', nested)?.id).toBe('raw/cohort.csv')
  })

  it('never matches a folder', () => {
    expect(findDatasetConflict('raw', null, SIBLINGS)).toBeNull()
  })

  it('is null when the name is free', () => {
    expect(findDatasetConflict('new.csv', null, SIBLINGS)).toBeNull()
  })
})

describe('resolveDatasetUploadTarget', () => {
  it('keeps the name when there is no clash', () => {
    expect(resolveDatasetUploadTarget('new.csv', null, SIBLINGS, 'new'))
      .toEqual({ name: 'new.csv' })
  })

  it('overwrite reports the id it replaces, so nothing is deleted first', () => {
    // The bug this encodes: deleting the existing dataset dropped the analyses and
    // versioning marks keyed on its id. The path IS the identity, so replacing in
    // place is both correct and lossless.
    expect(resolveDatasetUploadTarget('cohort.csv', null, SIBLINGS, 'overwrite'))
      .toEqual({ name: 'cohort.csv', replacesId: 'cohort.csv' })
  })

  it('overwrite reuses the EXISTING casing, not the uploaded one', () => {
    // Otherwise "COHORT.CSV" would land beside "cohort.csv" instead of replacing it.
    expect(resolveDatasetUploadTarget('COHORT.CSV', null, SIBLINGS, 'overwrite'))
      .toEqual({ name: 'cohort.csv', replacesId: 'cohort.csv' })
  })

  it('copy takes the next free filename, counter before the extension', () => {
    expect(resolveDatasetUploadTarget('cohort.csv', null, SIBLINGS, 'copy'))
      .toEqual({ name: 'cohort-2.csv' })
  })

  it('copy skips the numbers already taken', () => {
    const taken = [...SIBLINGS, file('cohort-2.csv')]
    expect(resolveDatasetUploadTarget('cohort.csv', null, taken, 'copy'))
      .toEqual({ name: 'cohort-3.csv' })
  })

  it('renames rather than silently overwriting when the mode says new but a clash exists', () => {
    // Defensive: 'new' should not be reachable with a clash, but if it is, adding a
    // copy is recoverable while a silent overwrite is not.
    expect(resolveDatasetUploadTarget('cohort.csv', null, SIBLINGS, 'new'))
      .toEqual({ name: 'cohort-2.csv' })
  })

  it('overwrite with no clash behaves as a plain add', () => {
    expect(resolveDatasetUploadTarget('new.csv', null, SIBLINGS, 'overwrite'))
      .toEqual({ name: 'new.csv' })
  })

  it('counts only siblings of the SAME parent when suffixing', () => {
    const nested = [file('cohort.csv'), file('cohort-2.csv', 'raw')]
    // 'cohort-2.csv' lives in raw/, so it does not block the root-level copy.
    expect(resolveDatasetUploadTarget('cohort.csv', null, nested, 'copy'))
      .toEqual({ name: 'cohort-2.csv' })
  })
})
