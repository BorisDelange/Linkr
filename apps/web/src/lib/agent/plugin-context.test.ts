import { describe, expect, it } from 'vitest'
import type { PluginManifest } from '@/types/plugin'
import { pluginDoc, pluginSummary } from './plugin-context'

function manifest(configSchema: PluginManifest['configSchema']): PluginManifest {
  return {
    id: 'test-plugin',
    name: { en: 'Test Plugin', fr: 'Plugin de test' },
    description: { en: 'Does a thing.', fr: 'Fait un truc.' },
    version: '1.0.0',
    configSchema,
  } as PluginManifest
}

describe('pluginSummary', () => {
  it('is one line with id, name and description', () => {
    expect(pluginSummary(manifest({}))).toBe(
      '- test-plugin — Test Plugin: Does a thing.'
    )
  })
})

describe('pluginDoc', () => {
  it('drops cosmetic field types', () => {
    const doc = pluginDoc(
      manifest({
        xColumn: { type: 'column-select', label: { en: 'X', fr: 'X' } },
        cardColor: { type: 'color-select', label: { en: 'Color', fr: 'Couleur' } },
        cardIcon: { type: 'icon-select', label: { en: 'Icon', fr: 'Icône' } },
        customPalette: { type: 'palette-editor', label: { en: 'Palette', fr: 'Palette' } },
      })
    )
    expect(doc).toContain('xColumn')
    expect(doc).not.toContain('cardColor')
    expect(doc).not.toContain('cardIcon')
    expect(doc).not.toContain('customPalette')
  })

  it('drops cosmetic fields that are plain numbers or booleans', () => {
    const doc = pluginDoc(
      manifest({
        bins: { type: 'number', label: { en: 'Bins', fr: 'Bins' }, default: 20 },
        opacity: { type: 'number', label: { en: 'Opacity', fr: 'Opacité' }, default: 70 },
        showGrid: { type: 'boolean', label: { en: 'Grid', fr: 'Grille' }, default: true },
      })
    )
    expect(doc).toContain('bins')
    expect(doc).not.toContain('opacity')
    expect(doc).not.toContain('showGrid')
  })

  it('marks a column field and its numeric/categorical restriction', () => {
    const doc = pluginDoc(
      manifest({
        yColumn: {
          type: 'column-select',
          label: { en: 'Y', fr: 'Y' },
          filter: 'numeric',
          optional: true,
        },
        groups: {
          type: 'column-select',
          label: { en: 'Groups', fr: 'Groupes' },
          multi: true,
        },
      })
    )
    expect(doc).toContain('yColumn (column, numeric only, optional)')
    expect(doc).toContain('groups (columns)')
  })

  it('lists select options and numeric ranges', () => {
    const doc = pluginDoc(
      manifest({
        plotType: {
          type: 'select',
          label: { en: 'Type', fr: 'Type' },
          default: 'scatter',
          options: [
            { value: 'scatter', label: { en: 'Scatter', fr: 'Nuage' } },
            { value: 'histogram', label: { en: 'Histogram', fr: 'Histogramme' } },
          ],
        },
        bins: {
          type: 'number',
          label: { en: 'Bins', fr: 'Bins' },
          default: 20,
          min: 2,
          max: 200,
        },
      })
    )
    expect(doc).toContain('one of: scatter|histogram')
    expect(doc).toContain('default "scatter"')
    expect(doc).toContain('range 2..200')
  })

  it('surfaces conditional requirements from hintWhen', () => {
    // The whole point: `optional: true` alone would tell the model nothing, while
    // hintWhen records that the field is required for one plot type and unused
    // for another.
    const doc = pluginDoc(
      manifest({
        yColumn: {
          type: 'column-select',
          label: { en: 'Y', fr: 'Y' },
          optional: true,
          hintWhen: {
            field: 'plotType',
            values: {
              scatter: { en: 'required', fr: 'requis' },
              histogram: { en: 'not used', fr: 'non utilisé' },
            },
          },
        },
      })
    )
    expect(doc).toContain('[by plotType → scatter: required; histogram: not used]')
  })

  it('includes the field description when present', () => {
    const doc = pluginDoc(
      manifest({
        uniquePer: {
          type: 'column-select',
          label: { en: 'Unique per', fr: 'Unique par' },
          description: { en: 'One value per entity.', fr: 'Une valeur par entité.' },
        },
      })
    )
    expect(doc).toContain('— One value per entity.')
  })

  it('tolerates a manifest with no config schema', () => {
    const bare = { ...manifest({}), configSchema: undefined } as unknown as PluginManifest
    expect(() => pluginDoc(bare)).not.toThrow()
  })
})
