import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api-client'
import { fsImportRefusalKey } from './fs-browser'

const refusal = (status: number, detail: unknown) => new ApiError(status, JSON.stringify({ detail }))

describe('fsImportRefusalKey', () => {
  it('names the key for each refusal the server words', () => {
    expect(fsImportRefusalKey(refusal(403, 'Importing from anywhere on the server requires code execution on this project. …')))
      .toBe('server_picker.import_needs_execution')
    expect(fsImportRefusalKey(refusal(403, 'System folders (/proc, /sys, /dev) cannot be imported from')))
      .toBe('server_picker.import_system_path')
    expect(fsImportRefusalKey(refusal(403, "Files inside Linkr's data folder cannot be imported")))
      .toBe('server_picker.import_data_dir')
  })

  it('leaves any other error alone', () => {
    expect(fsImportRefusalKey(refusal(403, 'Insufficient project permissions'))).toBeNull()
    expect(fsImportRefusalKey(refusal(400, 'System folders'))).toBeNull()
    expect(fsImportRefusalKey(new ApiError(403, 'not json'))).toBeNull()
    expect(fsImportRefusalKey(new Error('x'))).toBeNull()
  })
})
