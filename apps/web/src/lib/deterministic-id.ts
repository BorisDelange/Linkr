/**
 * Deterministic id derivation for import remapping.
 *
 * On import we can't keep the source ids verbatim (two projects sharing seed ids
 * would collide on primary keys), but a fresh random UUID each time makes an
 * export→import→export round-trip non-idempotent — every commit shows phantom id
 * churn. Deriving the new id from (projectUid + originalId) gives the best of
 * both: stable across re-imports into the same project, distinct across projects.
 *
 * Output is a canonical UUID string so it drops into the same columns/types as
 * crypto.randomUUID(). Not cryptographic — a fast, well-mixed 128-bit hash is
 * enough for collision avoidance within a project.
 */

// FNV-1a over the string, producing 32 bits per call with a seed offset so we
// can assemble 128 bits from four rounds.
function fnv1a(input: string, seed: number): number {
  let h = 0x811c9dc5 ^ seed
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0')
}

/**
 * A UUID-shaped id deterministically derived from `namespace` (the project uid)
 * and `key` (the original entity id). Same inputs → same id, always.
 */
export function deterministicId(namespace: string, key: string): string {
  const s = `${namespace}:${key}`
  const a = hex8(fnv1a(s, 0))
  const b = hex8(fnv1a(s, 0x9e3779b9))
  const c = hex8(fnv1a(s, 0x7f4a7c15))
  const d = hex8(fnv1a(s, 0x2545f491))
  const raw = a + b + c + d // 32 hex chars = 128 bits
  // Format as a canonical UUID; stamp version (4) and variant (8) nibbles so it
  // is a well-formed UUID, without pretending to be a real random/hashed UUID.
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    '4' + raw.slice(13, 16),
    '8' + raw.slice(17, 20),
    raw.slice(20, 32),
  ].join('-')
}
