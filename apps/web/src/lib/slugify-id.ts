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
    let candidate = slugifyId(getName(e)) || 'entity'
    if (candidate.length < 2) candidate = `entity-${candidate}`
    let id = candidate
    let suffix = 2
    while (usedIds.has(id)) { id = `${candidate}-${suffix++}` }
    e.entityId = id
    usedIds.add(id)
    mutated.push(e)
  }
  return mutated
}
