import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import { pickedColumnNames } from './template-resolver'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0)

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') {
    return Object.entries(value).sort(byKey).flatMap(([k, v]) => [k, ...stringsIn(v)])
  }
  return []
}

/** The text a setting puts in the code: a picked column puts its name, which the
 *  dataset may rename; a select its value, whose options the manifest may change.
 *  A number or a boolean holds none. */
function textInCode(field: PluginConfigField | undefined, value: unknown, columns: readonly DatasetColumn[]): string[] {
  if (field?.type === 'column-select') return stringsIn(pickedColumnNames(field, value, columns))
  return stringsIn(value)
}

/**
 * What accepting a plugin's code from its template covers: the template, and the
 * text its settings put in the code. A template may hand a setting to eval, parse
 * or a SQL call, so any changed text asks again, whoever changed it (a column
 * renamed, a manifest's options edited); numbers and booleans carry no code and
 * stay out, so ordinary use is not asked twice. The patient context reaches the
 * run apart and is never part of it. Accepted as the `source` of a CodeReview.
 */
export function acceptanceSource(
  template: string,
  config: Record<string, unknown>,
  columns: readonly DatasetColumn[],
  schema: Record<string, PluginConfigField> | undefined,
): string {
  const settings = new Map<string, string[]>()
  for (const [, key] of template.matchAll(PLACEHOLDER)) {
    if (settings.has(key)) continue
    const field = schema?.[key]
    const text = textInCode(field, config[key] ?? field?.default, columns)
    if (text.length > 0) settings.set(key, text)
  }
  if (settings.size === 0) return template
  const sorted = [...settings].sort(byKey)
  return `${template}\n# Linkr settings: ${JSON.stringify(Object.fromEntries(sorted))}`
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
