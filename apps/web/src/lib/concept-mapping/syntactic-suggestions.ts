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
}

export interface SuggestionCandidate {
  concept_id: number
  concept_name: string
  concept_code: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  /** Per-method scores. The combined score is the weighted average. */
  scores: MethodScore[]
  /** Weighted average of all method scores. */
  combined_score: number
  /** Strongest SKOS equivalence across methods (prefers more specific predicates). */
  equivalence: string
  /** First non-null comment across methods, if any. */
  comment: string | null
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

export const METHOD_COLORS: Record<string, string> = {
  Syntaxique:  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  Statistique: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  Sémantique:  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400',
  IA:          'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-400',
}

export const METHOD_DOT_COLORS: Record<string, string> = {
  Syntaxique:  'bg-amber-500',
  Statistique: 'bg-emerald-500',
  Sémantique:  'bg-violet-500',
  IA:          'bg-fuchsia-500',
}

/** Map raw method strings (from scores file) to display provider names + colors. */
export const METHOD_PROVIDER_MAP: Record<string, string> = {
  'syntactic/jaro-winkler': 'Syntaxique',
  'syntactic/token-sort':   'Syntaxique',
  'syntactic/ngram-idf':    'Syntaxique',
  'semantic/biolord':       'Sémantique',
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
  Syntaxique:  1,
  Sémantique:  2,
  Statistique: 1,
  IA:          3,
}

export const ALL_PROVIDERS = ['Syntaxique', 'Sémantique', 'Statistique', 'IA'] as const
export type Provider = typeof ALL_PROVIDERS[number]

export function getProviderForMethod(method: string): string {
  if (method.startsWith(AI_METHOD_PREFIX)) return 'IA'
  if (method.startsWith(STATISTICAL_METHOD_PREFIX)) return 'Statistique'
  return METHOD_PROVIDER_MAP[method] ?? method
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
