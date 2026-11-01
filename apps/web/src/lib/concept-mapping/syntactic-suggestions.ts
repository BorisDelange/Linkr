export interface MethodScore {
  provider: string
  /** Raw method string from the scores file, e.g. "syntactic/jaro-winkler". */
  method: string
  score: number
  weight: number
  /** SKOS equivalence predicate (default: skos:exactMatch). */
  equivalence: string
  /** Free-text justification (AI rows only). */
  comment: string | null
  /** ISO 8601 UTC timestamp from the producing script. */
  createdAt: string | null
  /** uniqueId of the data-dictionary concept set this AI row aligned against. */
  conceptSetUid: string | null
  /** sourceRepo of that dictionary (for "import this dictionary" when absent). */
  conceptSetSourceRepo: string | null
}

export interface SuggestionCandidate {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  /** OMOP validity: NULL/undefined = valid, 'U' = upgraded, 'D' = deleted. */
  invalid_reason?: string | null
  /** Per-method scores. The combined score is the weighted average. */
  scores: MethodScore[]
  /** Weighted average of all method scores. */
  combined_score: number
  /** Strongest SKOS equivalence across methods (prefers more specific predicates). */
  equivalence: string
  /** First non-null comment across methods, if any. */
  comment: string | null
  /** Concept set (uniqueId + sourceRepo) the AI aligned this target against, if any. */
  conceptSetUid: string | null
  conceptSetSourceRepo: string | null
}

const EQUIVALENCE_RANK: Record<string, number> = {
  'skos:exactMatch':   5,
  'skos:narrowMatch':  4,
  'skos:broadMatch':   3,
  'skos:closeMatch':   2,
  'skos:relatedMatch': 1,
}

export function pickStrongestEquivalence(scores: MethodScore[]): string {
  if (scores.length === 0) return 'skos:exactMatch'
  return scores.reduce((best, s) => {
    const a = EQUIVALENCE_RANK[s.equivalence] ?? 0
    const b = EQUIVALENCE_RANK[best] ?? 0
    return a > b ? s.equivalence : best
  }, scores[0].equivalence)
}

export function pickFirstComment(scores: MethodScore[]): string | null {
  for (const s of scores) {
    if (s.comment) return s.comment
  }
  return null
}

/** First method score that carries a concept-set link (uid + repo), if any. */
export function pickFirstConceptSet(scores: MethodScore[]): { uid: string | null; sourceRepo: string | null } {
  for (const s of scores) {
    if (s.conceptSetUid) return { uid: s.conceptSetUid, sourceRepo: s.conceptSetSourceRepo }
  }
  return { uid: null, sourceRepo: null }
}

/** Method families. Stable ids, shown through `concept_mapping.suggestion_category_<id>`
 *  (see `providerLabel`); they also key the weights and the dot colours. */
export const ALL_PROVIDERS = ['syntactic', 'semantic', 'statistical', 'agentic'] as const
export type Provider = typeof ALL_PROVIDERS[number]

export const METHOD_DOT_COLORS: Record<string, string> = {
  syntactic:   'bg-amber-500',
  statistical: 'bg-emerald-500',
  semantic:    'bg-violet-500',
  agentic:     'bg-fuchsia-500',
}

/** Human-readable labels for raw method strings. */
export const METHOD_LABELS: Record<string, string> = {
  'syntactic/jaro-winkler': 'Jaro-Winkler',
  'syntactic/token-sort':   'Token Sort',
  'syntactic/ngram-idf':    'N-gram IDF',
  'semantic/biolord':       'BioLORD-2023-M',
}

const AI_METHOD_PREFIX = 'ai/'
const STATISTICAL_METHOD_PREFIX = 'statistical/'

/** Default per-provider weights for the combined score. */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  syntactic:   1,
  semantic:    2,
  statistical: 1,
  agentic:     3,
}

/** Map a raw `method` string to its family (excludes `data_dictionary`, which is
 *  orthogonal — keyed on the concept-set link, not the method). */
export function categoryForMethod(method: string): Provider | null {
  if (method.startsWith(AI_METHOD_PREFIX)) return 'agentic'
  if (method.startsWith(STATISTICAL_METHOD_PREFIX)) return 'statistical'
  if (method.startsWith('semantic/')) return 'semantic'
  if (method.startsWith('syntactic/')) return 'syntactic'
  return null
}

/** The family of a method, or the method itself when it belongs to none. */
export function getProviderForMethod(method: string): string {
  return categoryForMethod(method) ?? method
}

export function providerLabel(provider: string, t: (key: string) => string): string {
  return (ALL_PROVIDERS as readonly string[]).includes(provider)
    ? t(`concept_mapping.suggestion_category_${provider}`)
    : provider
}

export function getMethodLabel(method: string): string {
  if (method.startsWith(AI_METHOD_PREFIX)) return method.slice(AI_METHOD_PREFIX.length)
  if (method.startsWith(STATISTICAL_METHOD_PREFIX)) return method.slice(STATISTICAL_METHOD_PREFIX.length)
  return METHOD_LABELS[method] ?? method
}

export function computeCombinedScore(scores: MethodScore[], weights?: Record<string, number>): number {
  if (scores.length === 0) return 0
  const effectiveScores = scores.map((s) => ({
    ...s,
    weight: weights ? (weights[s.provider] ?? s.weight) : s.weight,
  }))
  const referenceWeights = weights ?? DEFAULT_WEIGHTS
  const maxWeight = Math.max(0, ...Object.values(referenceWeights))
  if (maxWeight === 0) return 0
  const sum = effectiveScores.reduce((acc, s) => acc + s.score * s.weight, 0) / maxWeight
  return Math.min(1, sum)
}
