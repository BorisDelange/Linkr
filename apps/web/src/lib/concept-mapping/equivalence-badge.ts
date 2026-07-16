import type { MappingEquivalence } from '@/types/concept-mapping'

/** Coerce a suggestion/score equivalence (which may be a legacy alias like `equal`
 *  or `wider`, or an unknown value) to a canonical SKOS predicate the mapping UI
 *  understands, falling back to exactMatch. */
export function normalizeEquivalence(value: string | undefined | null): MappingEquivalence {
  switch (value) {
    case 'skos:closeMatch':
    case 'equivalent':
      return 'skos:closeMatch'
    case 'skos:broadMatch':
    case 'wider':
      return 'skos:broadMatch'
    case 'skos:narrowMatch':
    case 'narrower':
      return 'skos:narrowMatch'
    case 'skos:relatedMatch':
    case 'inexact':
      return 'skos:relatedMatch'
    case 'skos:exactMatch':
    case 'equal':
    default:
      return 'skos:exactMatch'
  }
}

export const EQUIV_BADGE: Record<string, { label: string; className: string }> = {
  'skos:exactMatch':   { label: 'Exact',    className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' },
  'skos:closeMatch':   { label: 'Close',    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
  'skos:broadMatch':   { label: 'Broad',    className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400' },
  'skos:narrowMatch':  { label: 'Narrow',   className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400' },
  'skos:relatedMatch': { label: 'Related',  className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  equal:      { label: 'Exact',    className: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' },
  equivalent: { label: 'Close',   className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' },
  wider:      { label: 'Broad',   className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400' },
  narrower:   { label: 'Narrow',  className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400' },
  inexact:    { label: 'Related', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}
