/** Pure helpers several tool families share. */

/** Cut long text for the model, saying how much was left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`
}

/** A node and everything under it, deepest first (children deleted before their folder). */
export function subtreeIds(nodes: { id: string; parentId?: string | null }[], rootId: string): string[] {
  const out: string[] = []
  const walk = (id: string) => {
    for (const child of nodes.filter((n) => (n.parentId ?? null) === id)) walk(child.id)
    out.push(id)
  }
  walk(rootId)
  return out
}

/** Databases as `buildPointer` reads them: null identity fields dropped. */
export const pointerRows = <N>(dbs: { id: string; entityId?: string | null; lineageId?: string | null; name: N }[]) =>
  dbs.map((d) => ({ id: d.id, lineageId: d.lineageId ?? undefined, entityId: d.entityId ?? undefined, name: d.name }))
