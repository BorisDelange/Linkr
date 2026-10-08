import type { PluginConfigField, VisibleCondition } from '@/types/plugin'

/** Every condition holds against `config`; `{ anyOf }` holds when one of its own does. */
export function conditionsHold(when: VisibleCondition | VisibleCondition[], config: Record<string, unknown>): boolean {
  const holds = (cond: { field: string; value?: unknown; values?: unknown[]; notEmpty?: boolean }) => {
    const depValue = config[cond.field]
    if (cond.notEmpty) return depValue != null && depValue !== ''
    if (cond.values) return cond.values.includes(depValue)
    return depValue === cond.value
  }
  const conditions = Array.isArray(when) ? when : [when]
  return conditions.every(cond => ('anyOf' in cond ? cond.anyOf.some(holds) : holds(cond)))
}

/** `config` with every unset field filled from its `default`, then from its first matching `defaultWhen`. */
export function applyConfigDefaults(config: Record<string, unknown>, schema: Record<string, PluginConfigField>): Record<string, unknown> {
  const result = { ...config }
  for (const [key, field] of Object.entries(schema)) {
    if (result[key] === undefined && field.default !== undefined) {
      result[key] = field.default
    }
  }
  // Conditional defaults read the static ones (e.g. the default plot type), so
  // they resolve in a second pass.
  const base = { ...result }
  for (const [key, field] of Object.entries(schema)) {
    if (config[key] !== undefined || !field.defaultWhen) continue
    const match = field.defaultWhen.find(d => conditionsHold(d.when, base))
    if (match) result[key] = match.value
  }
  return result
}
