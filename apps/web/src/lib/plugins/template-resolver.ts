import type { DatasetColumn } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

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
    const value = config[key] ?? field?.default
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
      if (field.multi) {
        const arr = Array.isArray(value) ? (value as string[]) : []
        const items = arr.map(v => JSON.stringify(v)).join(', ')
        return language === 'r' ? `c(${items})` : `[${items}]`
      }
      return serialiseString(value, language)
    case 'string':
      return serialiseString(value, language)
    default:
      return serialise(value, language)
  }
}

/** What a column-select puts in the code: the picked columns' names (a multi field
 *  with none picked and `defaultAll` takes every column its filter allows), or for
 *  a single pick the column's name, else the value as given. */
export function pickedColumnNames(
  field: PluginConfigField,
  value: unknown,
  columns: readonly DatasetColumn[],
): unknown {
  if (field.multi) {
    let ids = Array.isArray(value) ? (value as string[]) : []
    if (ids.length === 0 && field.defaultAll) {
      const filtered = field.filter
        ? columns.filter(c => (field.filter === 'numeric' ? c.type === 'number' : c.type === 'string'))
        : columns
      ids = filtered.map(c => c.id)
    }
    return ids
      .map(id => columns.find(c => c.id === id)?.name)
      .filter((n): n is string => n != null)
  }
  if (value == null) return null
  return columns.find(c => c.id === (value as string))?.name ?? value
}

function serialiseColumnSelect(
  field: PluginConfigField,
  value: unknown,
  columns: DatasetColumn[],
  language: 'python' | 'r',
): string {
  const picked = pickedColumnNames(field, value, columns)
  if (field.multi) {
    const names = picked as string[]
    return language === 'r'
      ? `c(${names.map(n => JSON.stringify(n)).join(', ')})`
      : JSON.stringify(names)
  }
  if (picked == null) return language === 'r' ? 'NULL' : 'None'
  return JSON.stringify(picked)
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
