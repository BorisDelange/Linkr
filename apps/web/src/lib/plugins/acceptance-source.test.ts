import { describe, expect, it } from 'vitest'
import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import { acceptanceSource } from './acceptance-source'

const field = (type: PluginConfigField['type'], extra: Partial<PluginConfigField> = {}): PluginConfigField =>
  ({ type, label: { en: '', fr: '' }, ...extra })
const schema: Record<string, PluginConfigField> = {
  expr: field('string'),
  bins: field('number'),
  log: field('boolean'),
  col: field('column-select'),
  kind: field('select', { options: [{ value: 'bar', label: { en: '', fr: '' } }] }),
}
const columns = [{ id: 'c1', name: 'age' }] as DatasetColumn[]
const TEMPLATE = 'x = eval({{expr}})\nplot({{col}}, bins={{bins}}, log={{log}}, kind={{kind}})'

describe('acceptanceSource', () => {
  it('asks again when a free-text setting the template uses changes', () => {
    const base = { expr: '1 + 1', bins: 10, log: false, col: 'c1', kind: 'bar' }
    const accepted = acceptanceSource(TEMPLATE, base, columns, schema)
    expect(accepted).not.toBe(TEMPLATE)
    expect(acceptanceSource(TEMPLATE, { ...base, expr: '__import__("os")' }, columns, schema)).not.toBe(accepted)
  })

  it('keeps numbers, booleans, picked columns and declared options out', () => {
    const base = { expr: 'same', bins: 10, log: false, col: 'c1', kind: 'bar' }
    const accepted = acceptanceSource(TEMPLATE, base, columns, schema)
    expect(acceptanceSource(TEMPLATE, { ...base, bins: 99, log: true }, columns, schema)).toBe(accepted)
    expect(acceptanceSource(TEMPLATE, { ...base, expr: '' }, columns, schema)).not.toBe(accepted)
  })

  it('counts text that no list bounds: an unknown column or an undeclared option', () => {
    const plain = acceptanceSource(TEMPLATE, { col: 'c1', kind: 'bar' }, columns, schema)
    expect(acceptanceSource(TEMPLATE, { col: 'os.system("x")', kind: 'bar' }, columns, schema)).not.toBe(plain)
    expect(acceptanceSource(TEMPLATE, { col: 'c1', kind: 'bar"); evil("' }, columns, schema)).not.toBe(plain)
  })

  it('is the template itself when its settings hold no free text, and ignores settings it does not use', () => {
    expect(acceptanceSource('plot({{bins}})', { bins: 3, unused: 'text' }, columns, schema)).toBe('plot({{bins}})')
  })
})
