import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { queryErrorMessage } from './query-error'

const t = ((key: string, opts?: Record<string, unknown>) => `${key}${opts?.name ? `:${opts.name}` : ''}`) as unknown as TFunction

describe('queryErrorMessage', () => {
  it('says a missing database file in plain words', () => {
    const err = new Error('{"detail":"the server path holds no readable database file; check it still exists"}')
    expect(queryErrorMessage(err, t, 'EHR')).toBe('databases.error_file_missing:EHR')
  })

  it("unwraps the server's detail and keeps other errors as they are", () => {
    expect(queryErrorMessage(new Error('{"detail":"Binder Error: column x not found"}'), t, 'EHR')).toBe('Binder Error: column x not found')
    expect(queryErrorMessage(new Error('Parser Error: syntax error at "FROM"'), t, 'EHR')).toBe('Parser Error: syntax error at "FROM"')
  })
})
