import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/analysis-plugin'

/**
 * Resolve a plugin template by replacing `{{placeholder}}` tokens
 * with values from the analysis config, serialised for the target language.
 */
export function resolveTemplate(
  template: string,
  config: Record<string, unknown>,
  columns: DatasetColumn[],
  schema: Record<string, PluginConfigField>,
  language: 'python' | 'r',
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const field = schema[key]
    const value = config[key]
    if (!field) return serialise(value, language)
    return serialiseField(field, value, columns, language)
  })
}

/** Serialise a single config field value for the target language. */
function serialiseField(
  field: PluginConfigField,
  value: unknown,
  columns: DatasetColumn[],
  language: 'python' | 'r',
): string {
  switch (field.type) {
    case 'column-select':
      return serialiseColumnSelect(field, value, columns, language)
    case 'boolean':
      return serialiseBool(value, language)
    case 'number':
      return serialiseNumber(value, field)
    case 'select':
    case 'string':
      return serialiseString(value, language)
    default:
      return serialise(value, language)
  }
}

/** column-select: resolve IDs → names, then format as list or single string. */
function serialiseColumnSelect(
  field: PluginConfigField,
  value: unknown,
  columns: DatasetColumn[],
  language: 'python' | 'r',
): string {
  if (field.multi) {
    let ids = Array.isArray(value) ? (value as string[]) : []
    // If no columns selected and defaultAll is true, use all columns
    // (optionally filtered by the field's type filter)
    if (ids.length === 0 && field.defaultAll) {
      const filtered = field.filter
        ? columns.filter(c => (field.filter === 'numeric' ? c.type === 'number' : c.type === 'string'))
        : columns
      ids = filtered.map(c => c.id)
    }
    const names = ids
      .map(id => columns.find(c => c.id === id)?.name)
      .filter((n): n is string => n != null)
    return language === 'r'
      ? `c(${names.map(n => JSON.stringify(n)).join(', ')})`
      : JSON.stringify(names)
  }
  // single
  if (value == null) return language === 'r' ? 'NULL' : 'None'
  const name = columns.find(c => c.id === (value as string))?.name ?? (value as string)
  return JSON.stringify(name)
}

function serialiseBool(value: unknown, language: 'python' | 'r'): string {
  if (value == null) return language === 'r' ? 'NULL' : 'None'
  const b = Boolean(value)
  return language === 'r' ? (b ? 'TRUE' : 'FALSE') : (b ? 'True' : 'False')
}

function serialiseNumber(value: unknown, field: PluginConfigField): string {
  if (value == null) return String(field.default ?? 0)
  return String(Number(value))
}

function serialiseString(value: unknown, language: 'python' | 'r'): string {
  if (value == null) return language === 'r' ? 'NULL' : 'None'
  return JSON.stringify(String(value))
}

/** Generic fallback serialisation. */
function serialise(value: unknown, language: 'python' | 'r'): string {
  if (value == null) return language === 'r' ? 'NULL' : 'None'
  if (typeof value === 'boolean') return serialiseBool(value, language)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const items = value.map(v => serialise(v, language)).join(', ')
    return language === 'r' ? `c(${items})` : `[${items}]`
  }
  return JSON.stringify(value)
}
