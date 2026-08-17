import { describe, it, expect } from 'vitest'
import { resolveLegacyPluginId } from './patient-chart-store'

// Patient-data boards used to persist widgets with a `type` discriminator instead
// of a plugin id, in two shapes: a built-in type, or `type: 'plugin'` with the real
// id buried in the config. Both must still resolve, or a migrated board renders as
// a grid of "plugin not found".
describe('resolveLegacyPluginId', () => {
  it('maps each built-in widget type to its plugin id', () => {
    expect(resolveLegacyPluginId({ type: 'patient_summary' })).toBe(
      'linkr-widget-patient-summary',
    )
    expect(resolveLegacyPluginId({ type: 'timeline' })).toBe('linkr-widget-timeline')
    expect(resolveLegacyPluginId({ type: 'notes' })).toBe('linkr-widget-notes')
  })

  it('reads the nested plugin id for a custom plugin widget', () => {
    expect(
      resolveLegacyPluginId({ type: 'plugin', config: { pluginId: 'linkr-warehouse-x' } }),
    ).toBe('linkr-warehouse-x')
  })

  it('prefers an explicit pluginId over the legacy type', () => {
    expect(resolveLegacyPluginId({ pluginId: 'new-id', type: 'timeline' })).toBe('new-id')
  })

  it('returns empty for an unknown type, so the caller can drop the widget', () => {
    expect(resolveLegacyPluginId({ type: 'something_else' })).toBe('')
    expect(resolveLegacyPluginId({})).toBe('')
    // `type: 'plugin'` with no nested id is the same dead end.
    expect(resolveLegacyPluginId({ type: 'plugin' })).toBe('')
  })
})
