/**
 * A multi-select filter value standing for every option whose label matches a
 * search — what a server-searched dropdown selects when its matches are too many
 * to list one by one. It sits in the same value array as exact values, and a row
 * passes when it holds one of them OR matches the search.
 */
const MATCH_PREFIX = '__match__:'

export function matchFilterValue(term: string): string {
  return `${MATCH_PREFIX}${term.trim()}`
}

/** The search a match value stands for, or null for an exact value. */
export function matchFilterTerm(value: string): string | null {
  return value.startsWith(MATCH_PREFIX) ? value.slice(MATCH_PREFIX.length) : null
}
