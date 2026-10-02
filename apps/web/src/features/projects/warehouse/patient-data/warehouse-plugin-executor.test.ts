import { describe, it, expect } from 'vitest'
import { idLiteral } from './warehouse-plugin-executor'

describe('idLiteral', () => {
  it('keeps a numeric id a number', () => {
    expect(idLiteral('10002495', 'None')).toBe('10002495')
  })

  it('quotes any other id, so it cannot run as code', () => {
    expect(idLiteral('P-12', 'None')).toBe('"P-12"')
    expect(idLiteral('1; import os; os.system("x")', 'None')).toBe('"1; import os; os.system(\\"x\\")"')
    expect(idLiteral('a\nb', 'NULL')).toBe('"a\\nb"')
  })

  it('quotes a number too long to stay exact', () => {
    expect(idLiteral('12345678901234567890', 'NULL')).toBe('"12345678901234567890"')
  })

  it('writes each language\'s null', () => {
    expect(idLiteral(null, 'None')).toBe('None')
    expect(idLiteral(null, 'NULL')).toBe('NULL')
  })
})
