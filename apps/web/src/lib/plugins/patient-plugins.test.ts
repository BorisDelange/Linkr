import { describe, it, expect, beforeAll } from 'vitest'
import { registerBuiltinWidgetPlugins } from './builtin-widget-plugins'
import { getPlugin, getWarehousePlugins } from './registry'
import { getPatientComponent } from './patient-component-registry'

// The three built-in patient widgets used to be inline TS manifests bound to widget
// types by a hard-coded map, which is what made a custom patient-data plugin
// impossible. They are now file-based manifests resolved through the registry like
// any other plugin — these tests pin that contract.

beforeAll(() => {
  registerBuiltinWidgetPlugins()
})

const BUILTIN_IDS = [
  'linkr-widget-patient-summary',
  'linkr-widget-timeline',
  'linkr-widget-notes',
]

describe('built-in patient-data plugins', () => {
  it('registers each one from its plugin.json', () => {
    for (const id of BUILTIN_IDS) {
      const plugin = getPlugin(id)
      expect(plugin, id).toBeTruthy()
      expect(plugin!.manifest.id).toBe(id)
    }
  })

  it('declares them in the warehouse scope so the patient picker lists them', () => {
    const ids = getWarehousePlugins().map((p) => p.manifest.id)
    for (const id of BUILTIN_IDS) expect(ids).toContain(id)
  })

  it('renders through the component runtime, not a script template', () => {
    for (const id of BUILTIN_IDS) {
      const plugin = getPlugin(id)!
      expect(plugin.manifest.runtime, id).toContain('component')
      expect(plugin.templates, id).toBeNull()
      // A componentId with no registered loader would render as "plugin not found".
      expect(plugin.componentId, id).toBeTruthy()
      expect(getPatientComponent(plugin.componentId!), id).toBeTruthy()
    }
  })

  it('keeps the timeline settings schema that drives the shared config panel', () => {
    const schema = getPlugin('linkr-widget-timeline')!.manifest.configSchema!
    expect(Object.keys(schema).sort()).toEqual([
      'conceptIds',
      'showPoints',
      'stepPlot',
      'strokeWidth',
      'syncTimeRange',
      'yAxisFromZero',
    ])
    // Concepts are the first field: GenericConfigPanel orders its sections by
    // field declaration, so this is what puts Data above Chart and Style.
    expect(Object.keys(schema)[0]).toBe('conceptIds')
    expect(schema.conceptIds.type).toBe('concept-select')
    // Labels must be bilingual — GenericConfigPanel renders them directly.
    for (const [key, field] of Object.entries(schema)) {
      expect(field.label.en, key).toBeTruthy()
      expect(field.label.fr, key).toBeTruthy()
    }
  })

  it('uses the same section vocabulary as the dashboard plugins', () => {
    const schema = getPlugin('linkr-widget-timeline')!.manifest.configSchema!
    const sections: string[] = []
    for (const field of Object.values(schema)) {
      const label = field.section?.en
      if (label && !sections.includes(label)) sections.push(label)
    }
    // Data / Chart / Style — the words map, plot-builder and sankey already use.
    // No "Axes" or "Appearance", which existed only here.
    expect(sections).toEqual(['Data', 'Chart', 'Style'])
    for (const field of Object.values(schema)) {
      if (field.section) expect(field.section.fr).toBeTruthy()
    }
  })

  it('flags only the timeline as needing the concept picker', () => {
    expect(getPlugin('linkr-widget-timeline')!.manifest.needsConceptPicker).toBe(true)
    expect(getPlugin('linkr-widget-notes')!.manifest.needsConceptPicker).toBeFalsy()
    expect(
      getPlugin('linkr-widget-patient-summary')!.manifest.needsConceptPicker,
    ).toBeFalsy()
  })

  it('carries a version, so widget drift detection has something to compare', () => {
    for (const id of BUILTIN_IDS) {
      expect(getPlugin(id)!.manifest.version, id).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

describe('patient component registry', () => {
  it('is separate from the lab one: unknown ids resolve to undefined', () => {
    // 'table1' is a LAB component; it must not be reachable from the patient
    // registry, whose props carry OMOP context instead of dataset columns/rows.
    expect(getPatientComponent('table1')).toBeUndefined()
  })

  it('returns the same lazy component instance for a repeated id', () => {
    // A fresh React.lazy on every render would reset the widget's state.
    expect(getPatientComponent('timeline')).toBe(getPatientComponent('timeline'))
  })
})
