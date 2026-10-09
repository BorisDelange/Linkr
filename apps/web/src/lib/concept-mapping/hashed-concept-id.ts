/**
 * The id a dictionary with no id column gives a concept: an integer hash of its
 * code (or name). Mapping projects store these ids, so the expression must not
 * change.
 */
// TODO(concept-mapping): DuckDB hashes by type (hash('123') ≠ hash(123)), so an
// event column typed unlike the dictionary's code column never meets its
// concepts. Detect it like findConceptIdTypeMismatches and surface it; a cast
// would change the ids stored for integer-typed codes.
export function hashedConceptId(column: string): string {
  return `(hash(${column}) % 2147483647)::INTEGER`
}
