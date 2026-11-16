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

  it('keeps numbers and booleans out', () => {
    const base = { expr: 'same', bins: 10, log: false, col: 'c1', kind: 'bar' }
    const accepted = acceptanceSource(TEMPLATE, base, columns, schema)
    expect(acceptanceSource(TEMPLATE, { ...base, bins: 99, log: true }, columns, schema)).toBe(accepted)
    expect(acceptanceSource(TEMPLATE, { ...base, expr: '' }, columns, schema)).not.toBe(accepted)
  })

  it('is the same for the same template, settings and columns', () => {
    const base = { expr: 'x', bins: 10, log: false, col: 'c1', kind: 'bar', extra: { b: '1', a: '2' } }
    const template = `${TEMPLATE}\n{{extra}}`
    const accepted = acceptanceSource(template, base, columns, schema)
    expect(acceptanceSource(template, structuredClone(base), [...columns], { ...schema })).toBe(accepted)
    expect(acceptanceSource(template, { ...base, extra: { a: '2', b: '1' } }, columns, schema)).toBe(accepted)
  })

  it('covers the name a picked column puts in the code, not its id', () => {
    const multi = { ...schema, cols: field('column-select', { multi: true }) }
    const template = `${TEMPLATE}\nfit({{cols}})`
    const config = { col: 'c1', cols: ['c1', 'c2'], kind: 'bar' }
    const before = [{ id: 'c1', name: 'age' }, { id: 'c2', name: 'sex' }] as DatasetColumn[]
    const accepted = acceptanceSource(template, config, before, multi)
    const renamed = (i: number) => before.map((c, j) => (j === i ? { ...c, name: `${c.name}_2` } : c))
    expect(acceptanceSource(template, config, renamed(0), multi)).not.toBe(accepted)
    expect(acceptanceSource(template, config, renamed(1), multi)).not.toBe(accepted)
    expect(acceptanceSource(template, config, before.map((c) => ({ ...c })), multi)).toBe(accepted)
  })

  it('covers the columns a multi pick takes by default, as the dataset names them', () => {
    const all = { cols: field('column-select', { multi: true, defaultAll: true }) }
    const before = [{ id: 'c1', name: 'age' }] as DatasetColumn[]
    const accepted = acceptanceSource('fit({{cols}})', {}, before, all)
    expect(acceptanceSource('fit({{cols}})', {}, [{ id: 'c1', name: 'weight' }] as DatasetColumn[], all)).not.toBe(accepted)
    expect(acceptanceSource('fit({{cols}})', {}, [...before, { id: 'c2', name: 'sex' }] as DatasetColumn[], all)).not.toBe(accepted)
  })

  it('covers the value a select puts in the code, whatever options the manifest declares', () => {
    const accepted = acceptanceSource(TEMPLATE, { col: 'c1', kind: 'bar' }, columns, schema)
    const optionsEdited = { ...schema, kind: field('select', { options: [{ value: 'line', label: { en: '', fr: '' } }] }) }
    expect(acceptanceSource(TEMPLATE, { col: 'c1', kind: 'line' }, columns, optionsEdited)).not.toBe(accepted)
    const defaultEdited = { ...schema, kind: field('select', { default: 'line', options: [{ value: 'line', label: { en: '', fr: '' } }] }) }
    const byDefault = { ...schema, kind: field('select', { default: 'bar', options: schema.kind.options }) }
    expect(acceptanceSource(TEMPLATE, { col: 'c1' }, columns, defaultEdited))
      .not.toBe(acceptanceSource(TEMPLATE, { col: 'c1' }, columns, byDefault))
  })

  it('covers every placeholder the template names, whatever its name', () => {
    const plain = acceptanceSource('run({{constructor}}, {{__proto__}})', {}, columns, schema)
    const config = JSON.parse('{"constructor": "a", "__proto__": "b"}') as Record<string, unknown>
    expect(acceptanceSource('run({{constructor}}, {{__proto__}})', config, columns, schema)).not.toBe(plain)
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
