/**
 * Which existing row an import overwrites.
 *
 * Exports no longer carry the writing instance's `id` — it was that instance's
 * local primary key, and every import path either mints its own or keeps the row
 * it already has. What identifies an entity ACROSS instances is `lineageId`, the
 * value `isSameEntity` already trusts. So a re-import of the same published
 * entity is recognised by lineage, and lands on the row it wrote last time
 * instead of piling up a fresh copy per round trip.
 *
 * Extracted from WorkspacesPage.doImport so the rule can be tested on its own:
 * it decides whether user data is overwritten or duplicated, which is too
 * load-bearing to live only inside a component.
 */

/** Anything an importer can land on: a stored row with a local key. */
export interface ImportTarget {
  id: string
  lineageId?: string
  workspaceId?: string
}

/** The identity fields an import candidate carries. `id` is the local key some
 *  callers still hand us; it is deliberately NOT used to match. */
export interface ImportCandidate {
  id?: string
  lineageId?: string
}

/**
 * Where an imported entity should land.
 *
 * `id` is the key to write under. `replaces` is the row being overwritten — non-
 * null only when an existing row is being replaced, so the caller knows to clear
 * it (and its children) first. Callers must branch on `replaces`, never on
 * `id === candidate.id`: that test only worked while the ZIP carried the writing
 * instance's key, and would now silently never fire.
 */
export interface Resolution {
  id: string
  replaces: string | null
}

/** A fresh local key. Injectable so tests get deterministic ids. */
export type MintId = () => string

const defaultMint: MintId = () => crypto.randomUUID()

/**
 * Resolve a lineage-bearing child (SQL collection, ETL pipeline, DQ rule set,
 * mapping project, data catalog) against the rows already stored.
 *
 * A duplicate always mints — that is what "duplicate" means. A candidate with no
 * lineage at all (a tree published before lineage existed) also mints: there is
 * nothing to match on, and guessing would risk clobbering an unrelated row.
 *
 * The match is scoped to `workspaceId`: the same published entity installed into
 * two workspaces is two independent rows, and overwriting across that boundary
 * would silently move one workspace's entity into another.
 */
export function resolveByLineage(
  rows: ImportTarget[],
  candidate: ImportCandidate,
  targetWorkspaceId: string,
  duplicate: boolean,
  mint: MintId = defaultMint,
): Resolution {
  if (duplicate) return { id: mint(), replaces: null }
  const match = findLineageMatch(rows, candidate, targetWorkspaceId)
  return match ? { id: match.id, replaces: match.id } : { id: mint(), replaces: null }
}

/**
 * Where a git-linked database lands when its pointer carries no lineage.
 *
 * Databases are the one type that cannot simply mint here. A git-linked database
 * exports as a pointer holding an `entityId` and no `id`, and the clone that
 * follows the import writes to that `entityId` (see `collectGitLinkedEntities`):
 * land anywhere else and the row is orphaned, so the clone creates a SECOND one —
 * two databases with the same name, one of them empty.
 *
 * But `entityId` is a readable slug, unique only within a workspace: two
 * workspaces may both publish a `mimic-iv-demo`. So the key is taken only when
 * free, or already held by the target workspace; otherwise this import mints its
 * own id like every other type. That is the same boundary `findLineageMatch`
 * enforces — crossing it would silently overwrite another workspace's database.
 *
 * `holder` is the row currently stored under `key`, if any.
 */
export function resolveSlugLanding(
  key: string,
  holder: { workspaceId?: string } | null | undefined,
  targetWorkspaceId: string,
  mint: MintId = defaultMint,
): string {
  if (!holder) return key
  return holder.workspaceId === targetWorkspaceId ? key : mint()
}

/**
 * The stored row an import would land on, or undefined for a fresh one.
 *
 * The same rule `resolveByLineage` decides with, exposed on its own so an
 * importer can ask the question BEFORE it commits — the standalone list pages
 * need it to raise the overwrite-or-duplicate prompt. They used to ask
 * `getById(manifest.id)`, which since exports stopped carrying `id` matched
 * nothing, so every re-import silently piled up a new copy.
 */
export function findLineageMatch<T extends ImportTarget>(
  rows: T[],
  candidate: ImportCandidate,
  targetWorkspaceId: string,
): T | undefined {
  if (!candidate.lineageId) return undefined
  return rows.find(
    (r) => r.lineageId === candidate.lineageId && r.workspaceId === targetWorkspaceId,
  )
}

/**
 * Resolve the workspace an import lands in.
 *
 * A re-import is recognised by lineage and updates that workspace in place. With
 * no lineage match the caller's minted id is used — `parseWorkspaceZip` already
 * mints one when the manifest has none, so this is always a real key.
 */
export function resolveWorkspaceId(
  rows: ImportTarget[],
  candidate: ImportCandidate & { id: string },
  duplicate: boolean,
  mint: MintId = defaultMint,
): Resolution {
  if (duplicate) return { id: mint(), replaces: null }
  const match = candidate.lineageId
    ? rows.find((w) => w.lineageId && w.lineageId === candidate.lineageId)
    : undefined
  return match ? { id: match.id, replaces: match.id } : { id: candidate.id, replaces: null }
}

/**
 * The key an entity read out of an export tree is addressed by.
 *
 * An export carries **no primary key**: `uid`/`id` are the writing instance's
 * local keys and are stripped, which is the premise this whole module is built
 * on. What survives is `entityId` — the readable slug — and `lineageId`. Yet
 * several readers still opened with `if (!project.uid) continue`, written when a
 * tree did carry one. Against a published repo that guard is simply always true,
 * so the entity was skipped in silence: workspace import dropped every project of
 * a git-published workspace, and the seed loader dropped all of them plus its
 * mapping projects.
 *
 * `folder` is the entity's directory in the tree, which IS its slug there — the
 * last resort for a tree so old it has neither key nor slug.
 *
 * This answers "what is this entity called", not "which row does it land on":
 * `resolveByLineage` and `resolveSlugLanding` still decide that, and take this
 * as their input.
 */
export function entityKey(
  meta: { uid?: string; id?: string; entityId?: string } | null | undefined,
  folder: string,
): string {
  return meta?.uid || meta?.id || meta?.entityId || folder
}

/**
 * Resolve a child addressed by its stored id rather than by lineage (the types
 * that carry no lineage of their own).
 *
 * Keeps the ZIP's id so a git round trip overwrites in place — EXCEPT when that
 * id already belongs to a child in ANOTHER workspace, where a delete-then-create
 * would drag that row across the boundary. Then it mints instead.
 */
export function resolveChildId(
  existing: { workspaceId?: string } | undefined,
  originalId: string,
  targetWorkspaceId: string,
  duplicate: boolean,
  mint: MintId = defaultMint,
): string {
  if (duplicate) return mint()
  return existing && existing.workspaceId !== targetWorkspaceId ? mint() : originalId
}
