/**
 * Derive the portable pointer of every cross-entity link configured before
 * pointers existed (IndexedDB v42; twin of the server migration a9b0c1d2e3f4).
 *
 * A link exports as a `*Ref` pointer with its local id blanked, and the pointer
 * is stamped when the user picks the target. A link chosen before that therefore
 * exports with no pointer at all, losing the reference on the next round trip —
 * exactly the bug pointers exist to prevent. What this instance CAN do is read
 * its own rows: an id that still resolves names a real entity, and that entity's
 * `lineageId` / `entityId` / `name` are what the pointer holds.
 */

/** The identity fields a pointer is built from. */
interface PointerSource {
  id?: string
  uid?: string
  entityId?: string
  lineageId?: string
  name?: unknown
}

/** One link to repair: which id names the target, and where its pointer goes. */
interface LinkSpec {
  store: string
  idField: string
  refField: string
  targets: string
}

/** The stores whose rows this migration walks, and the links each one carries. */
const LINKS: LinkSpec[] = [
  { store: 'etl_pipelines', idField: 'sourceDataSourceId', refField: 'sourceDataSourceRef', targets: 'data_sources' },
  { store: 'etl_pipelines', idField: 'targetDataSourceId', refField: 'targetDataSourceRef', targets: 'data_sources' },
  { store: 'etl_pipelines', idField: 'mappingProjectId', refField: 'mappingProjectRef', targets: 'mapping_projects' },
  { store: 'dq_rule_sets', idField: 'dataSourceId', refField: 'dataSourceRef', targets: 'data_sources' },
  { store: 'sql_script_collections', idField: 'defaultDataSourceId', refField: 'defaultDataSourceRef', targets: 'data_sources' },
  { store: 'data_catalogs', idField: 'dataSourceId', refField: 'dataSourceRef', targets: 'data_sources' },
  { store: 'mapping_projects', idField: 'dataSourceId', refField: 'dataSourceRef', targets: 'data_sources' },
  { store: 'mapping_projects', idField: 'vocabularyDataSourceId', refField: 'vocabularyDataSourceRef', targets: 'data_sources' },
]

/**
 * The pointer for a resolved target, or undefined when it carries no identity to
 * point at — neither lineage nor slug is something the other end could resolve.
 */
export function pointerFor(row: PointerSource | undefined): Record<string, unknown> | undefined {
  if (!row) return undefined
  if (!row.lineageId && !row.entityId) return undefined
  return {
    ...(row.lineageId ? { lineageId: row.lineageId } : {}),
    ...(row.entityId ? { entityId: row.entityId } : {}),
    ...(row.name !== undefined && row.name !== null ? { label: row.name } : {}),
  }
}

/**
 * The rows of `store` that gained a pointer, as {row, ref} pairs.
 *
 * Pure so the rule can be tested without IndexedDB: only a link that HAS an id,
 * LACKS a pointer, and whose id resolves to a row with an identity is repaired.
 */
export function backfillRows(
  rows: Record<string, unknown>[],
  specs: LinkSpec[],
  targetsByStore: Record<string, PointerSource[]>,
): Record<string, unknown>[] {
  const byId: Record<string, Map<string, PointerSource>> = {}
  for (const [store, list] of Object.entries(targetsByStore)) {
    byId[store] = new Map(list.map((r) => [(r.id ?? r.uid) as string, r]))
  }
  const changed: Record<string, unknown>[] = []
  for (const row of rows) {
    let touched = false
    for (const spec of specs) {
      if (row[spec.refField] !== undefined && row[spec.refField] !== null) continue
      const id = row[spec.idField]
      if (typeof id !== 'string' || !id) continue
      const ref = pointerFor(byId[spec.targets]?.get(id))
      if (!ref) continue
      row[spec.refField] = ref
      touched = true
    }
    if (touched) changed.push(row)
  }
  return changed
}

/**
 * A project's pointers, index-aligned with `linkedDataSourceIds`.
 *
 * An entry whose database no longer resolves keeps an empty placeholder rather
 * than being dropped: shortening the list would shift every later pointer onto
 * the wrong database. Returns undefined when not one entry resolved, so a
 * project with nothing to say keeps no pointer array at all.
 */
export function linkedRefsFor(
  ids: unknown,
  databases: PointerSource[],
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(ids) || ids.length === 0) return undefined
  const byId = new Map(databases.map((d) => [d.id as string, d]))
  const refs = ids.map((id) => pointerFor(byId.get(id as string)) ?? {})
  return refs.some((r) => Object.keys(r).length > 0) ? refs : undefined
}

/** The idb upgrade transaction, narrowed to what this migration uses. */
export interface IdbUpgradeTransaction {
  objectStoreNames: { contains(name: string): boolean }
  objectStore(name: string): {
    getAll(): Promise<unknown[]>
    put(value: unknown): unknown
  }
}

/** Run the backfill inside a live upgrade transaction. */
export function backfillPortableRefs(transaction: IdbUpgradeTransaction): void {
  const stores = [...new Set([...LINKS.map((l) => l.store), ...LINKS.map((l) => l.targets), 'projects'])]
  if (stores.some((s) => !transaction.objectStoreNames.contains(s))) return

  const read = (name: string) => transaction.objectStore(name).getAll() as Promise<PointerSource[]>
  // Reads are started synchronously — the upgrade transaction must still be live
  // when they are issued — and the writes follow in the callback, as v41 does.
  Promise.all([read('data_sources'), read('mapping_projects')]).then(
    ([databases, mappingProjects]) => {
      const targets = { data_sources: databases, mapping_projects: mappingProjects }
      for (const store of new Set(LINKS.map((l) => l.store))) {
        const specs = LINKS.filter((l) => l.store === store)
        const os = transaction.objectStore(store)
        void (os.getAll() as Promise<Record<string, unknown>[]>).then((rows) => {
          for (const row of backfillRows(rows, specs, targets)) os.put(row)
        })
      }
      const projects = transaction.objectStore('projects')
      void (projects.getAll() as Promise<Record<string, unknown>[]>).then((rows) => {
        for (const row of rows) {
          if (row.linkedDataSourceRefs) continue
          const refs = linkedRefsFor(row.linkedDataSourceIds, databases)
          if (!refs) continue
          row.linkedDataSourceRefs = refs
          projects.put(row)
        }
      })
    },
  )
}
