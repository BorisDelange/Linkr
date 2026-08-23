/**
 * Generate a URL-safe identifier from a human-readable name.
 * Rules: lowercase, [a-z0-9-], no leading/trailing hyphens, max 50 chars.
 */
export function slugifyId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/, '') || ''
}

/**
 * First id in the "foo", "foo-2", "foo-3"… series that is not taken.
 *
 * `base` is expected to be a slug already; an empty or 1-char one falls back to
 * "entity", since an identifier must be at least 2 characters.
 */
export function uniqueEntityId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let candidate = base || 'entity'
  if (candidate.length < 2) candidate = `entity-${candidate}`
  let id = candidate
  for (let n = 2; used.has(id); n++) id = `${candidate}-${n}`
  return id
}

/**
 * Assign entityId to entities that don't have one yet.
 * Deduplicates by appending -2, -3, etc.
 * Returns the list of entities that were mutated (for persistence).
 */
export function migrateEntityIds<T extends { entityId?: string }>(
  entities: T[],
  getName: (e: T) => string,
): T[] {
  const usedIds = new Set(entities.filter(e => e.entityId).map(e => e.entityId!))
  const mutated: T[] = []
  for (const e of entities) {
    if (e.entityId) continue
    const id = uniqueEntityId(slugifyId(getName(e)), usedIds)
    e.entityId = id
    usedIds.add(id)
    mutated.push(e)
  }
  return mutated
}
