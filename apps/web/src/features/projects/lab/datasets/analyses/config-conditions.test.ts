import { describe, it, expect } from 'vitest'
import type { PluginConfigField } from '@/types/plugin'
import { applyConfigDefaults, conditionsHold } from './config-conditions'

describe('conditionsHold', () => {
  const config = { type: 'bar', group: '', color: 'red' }

  it('matches a single value, a list of values, or a non-empty field', () => {
    expect(conditionsHold({ field: 'type', value: 'bar' }, config)).toBe(true)
    expect(conditionsHold({ field: 'type', values: ['line', 'bar'] }, config)).toBe(true)
    expect(conditionsHold({ field: 'group', notEmpty: true }, config)).toBe(false)
    expect(conditionsHold({ field: 'color', notEmpty: true }, config)).toBe(true)
  })

  it('requires every condition of a list', () => {
    expect(conditionsHold([{ field: 'type', value: 'bar' }, { field: 'color', value: 'red' }], config)).toBe(true)
    expect(conditionsHold([{ field: 'type', value: 'bar' }, { field: 'color', value: 'blue' }], config)).toBe(false)
  })

  it('holds an anyOf when one of its conditions does', () => {
    expect(conditionsHold({ anyOf: [{ field: 'type', value: 'pie' }, { field: 'color', value: 'red' }] }, config)).toBe(true)
    expect(conditionsHold({ anyOf: [{ field: 'type', value: 'pie' }] }, config)).toBe(false)
  })
})

describe('applyConfigDefaults', () => {
  const schema = {
    plotType: { type: 'select', default: 'bar' },
    order: {
      type: 'select',
      default: 'data',
      defaultWhen: [
        { when: { field: 'plotType', value: 'bar' }, value: 'value-desc' },
        { when: { field: 'plotType', value: 'pie' }, value: 'label-asc' },
      ],
    },
  } as unknown as Record<string, PluginConfigField>

  it('resolves a conditional default against the static defaults', () => {
    expect(applyConfigDefaults({}, schema)).toEqual({ plotType: 'bar', order: 'value-desc' })
  })

  it('follows the configured value of the field it depends on', () => {
    expect(applyConfigDefaults({ plotType: 'pie' }, schema).order).toBe('label-asc')
  })

  it('falls back to the static default when no condition matches', () => {
    expect(applyConfigDefaults({ plotType: 'line' }, schema).order).toBe('data')
  })

  it('never overrides a value the user set', () => {
    expect(applyConfigDefaults({ order: 'data' }, schema).order).toBe('data')
  })
})
