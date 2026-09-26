import { fieldRef } from '@/lib/schema-classes/spec'
import type { RelationSpec } from '@/types/schema-mapping'

/** The alias a relation created in the form reads its table under. Hidden: the
 *  form maps one table, and the alias only matters to the SQL it generates. */
export const FORM_ALIAS = 't'

/**
 * Whether the form can edit a relation: one table, each field one of its
 * columns or a constant, an optional filter. Anything richer — a join, an
 * expression — is SQL's job; such a relation (a v1 conversion, say) is shown
 * read-only and edited in the SQL dialog.
 */
export function formEditable(spec: RelationSpec): boolean {
  if (spec.customSql?.trim()) return false
  if (spec.joins?.length) return false
  const alias = (spec.from?.alias ?? FORM_ALIAS).toLowerCase()
  return Object.values(spec.fields ?? {}).every((f) => {
    if (f && typeof f === 'object' && 'value' in f) return true
    const ref = fieldRef(f)
    return !!ref && ref.alias.toLowerCase() === alias
  })
}
