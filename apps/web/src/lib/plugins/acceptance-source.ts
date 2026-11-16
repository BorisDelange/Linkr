import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

/** The text a setting puts in the code that no list bounds: a picked column or a
 *  declared option is not free text, a number or a boolean holds none. */
function freeText(field: PluginConfigField | undefined, value: unknown, columns: readonly DatasetColumn[]): string[] {
  const strings = stringsIn(value)
  if (field?.type === 'column-select') return strings.filter((s) => !columns.some((c) => c.id === s))
  if (field?.type === 'select') {
    const options = new Set((field.options ?? []).map((o) => o.value))
    return strings.filter((s) => !options.has(s))
  }
  return strings
}

/**
 * What accepting a plugin's code from its template covers: the template, and the
 * free text its settings put in the code. A template may hand a setting to
 * eval, parse or a SQL call, so a changed text asks again; what cannot carry code
 * (numbers, booleans, picked columns, declared options) stays out, so ordinary
 * use is not asked twice. The patient context reaches the run apart and is never
 * part of it. Accepted as the `source` of a CodeReview.
 */
export function acceptanceSource(
  template: string,
  config: Record<string, unknown>,
  columns: readonly DatasetColumn[],
  schema: Record<string, PluginConfigField> | undefined,
): string {
  const settings: Record<string, string[]> = {}
  for (const [, key] of template.matchAll(PLACEHOLDER)) {
    if (key in settings) continue
    const field = schema?.[key]
    const text = freeText(field, config[key] ?? field?.default, columns)
    if (text.length > 0) settings[key] = text
  }
  const keys = Object.keys(settings).sort()
  if (keys.length === 0) return template
  return `${template}\n# Linkr settings: ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, settings[k]])))}`
}

/** `acceptanceSource` of a plugin's template in `language`, if it has one. */
export function templateSource(
  plugin: { templates: Record<string, string> | null; manifest: { configSchema?: Record<string, PluginConfigField> } } | null | undefined,
  language: string,
  config: Record<string, unknown>,
  columns: readonly DatasetColumn[],
): string | undefined {
  const template = plugin?.templates?.[language]
  return template ? acceptanceSource(template, config, columns, plugin?.manifest.configSchema) : undefined
}
