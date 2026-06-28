/**
 * Short ids in URLs — git-style. Entities keep their full UUID everywhere internally; URLs only
 * carry a short prefix (the first segment of the UUID, 8 hex chars), resolved back to the full
 * entity by prefix match. A full UUID is a prefix of itself, so existing full-length links keep
 * working unchanged.
 */

/** Default short prefix length. A UUID's first dash-segment is 8 hex chars. */
const SHORT_ID_LENGTH = 8

/** Canonical UUID shape (8-4-4-4-12 hex). Only these are shortened; human-readable slugs aren't. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shorten a UUID for display in a URL. Non-UUID ids (e.g. projectId slugs) pass through. */
export function shortenId(id: string): string {
  return UUID_RE.test(id) ? id.slice(0, SHORT_ID_LENGTH) : id
}

/**
 * Shorten an id to the SHORTEST prefix (>= SHORT_ID_LENGTH) that is unique among `siblings` —
 * git-style. Use this when emitting a URL where the id must round-trip via resolveByIdPrefix:
 * if the default 8-char prefix collides with another sibling (e.g. the seed's sequential
 * 00000000-… uuids), the prefix is grown just enough to disambiguate. Non-UUID slugs and ids
 * shorter than the prefix pass through unchanged.
 */
export function shortenIdAmong(id: string, siblings: readonly string[]): string {
  if (!UUID_RE.test(id)) return id
  const others = siblings.filter((s) => s !== id)
  for (let len = SHORT_ID_LENGTH; len < id.length; len++) {
    const prefix = id.slice(0, len)
    if (!others.some((o) => o.startsWith(prefix))) return prefix
  }
  return id // fully ambiguous (duplicate id) — fall back to the whole thing
}

/**
 * Resolve a URL id param (which may be a short prefix or a full id) to exactly one entity.
 * Returns the entity, or undefined if there's no match OR the prefix is ambiguous (>1 match) —
 * the caller treats both as "not found", same as a bad full id.
 */
export function resolveByIdPrefix<T>(
  items: readonly T[],
  param: string | undefined,
  getId: (item: T) => string,
): T | undefined {
  if (!param) return undefined
  // Exact match wins outright (and is unambiguous by construction).
  const exact = items.find((it) => getId(it) === param)
  if (exact) return exact

  const matches = items.filter((it) => getId(it).startsWith(param))
  return matches.length === 1 ? matches[0] : undefined
}
