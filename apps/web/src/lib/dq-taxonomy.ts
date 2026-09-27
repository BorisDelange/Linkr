/**
 * Data-quality taxonomy: the harmonized framework of Kahn et al. (2016), "A
 * Harmonized Data Quality Assessment Terminology and Framework for the Secondary
 * Use of Electronic Health Record Data" (eGEMs 4(1):1244) — the one OHDSI's Data
 * Quality Dashboard uses. Completeness has no subcategory in the framework.
 */

export type DqCategory = 'conformance' | 'completeness' | 'plausibility'
export type DqSubcategory = 'value' | 'relational' | 'computational' | 'uniqueness' | 'atemporal' | 'temporal'
export type DqSeverity = 'error' | 'warning' | 'notice'
export type DqCheckOrigin = 'ddl' | 'mapping' | 'manual'

export const DQ_CATEGORIES: readonly DqCategory[] = ['conformance', 'completeness', 'plausibility']
export const DQ_SEVERITIES: readonly DqSeverity[] = ['error', 'warning', 'notice']

export const DQ_SUBCATEGORIES: Record<DqCategory, readonly DqSubcategory[]> = {
  conformance: ['value', 'relational', 'computational'],
  completeness: [],
  plausibility: ['uniqueness', 'atemporal', 'temporal'],
}

/** A subcategory that belongs to `category`, else null. */
export function subcategoryFor(category: DqCategory, subcategory: string | null | undefined): DqSubcategory | null {
  return DQ_SUBCATEGORIES[category].find((s) => s === subcategory) ?? null
}

// The five categories used before the Kahn taxonomy, mapped onto it.
const LEGACY: Record<string, { category: DqCategory; subcategory: DqSubcategory | null }> = {
  validity: { category: 'conformance', subcategory: 'value' },
  consistency: { category: 'conformance', subcategory: 'relational' },
  uniqueness: { category: 'plausibility', subcategory: 'uniqueness' },
}

/** Reads a stored or imported check's category, tolerating the pre-Kahn names
 *  and the `info` severity older exports carry. */
export function normalizeDqCheck<T extends { category: string; subcategory?: string | null; severity: string }>(check: T): T {
  const legacy = LEGACY[check.category]
  const category = legacy?.category ?? (DQ_CATEGORIES.includes(check.category as DqCategory) ? check.category as DqCategory : 'plausibility')
  const subcategory = legacy?.subcategory ?? subcategoryFor(category, check.subcategory)
  const severity = check.severity === 'info' ? 'notice' : check.severity
  if (category === check.category && subcategory === (check.subcategory ?? null) && severity === check.severity) return check
  return { ...check, category, subcategory, severity }
}
