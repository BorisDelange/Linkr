/**
 * The default data — one curated catalog entry, not a mechanism of its own.
 *
 * "Install the default data" means "install the `demo-workspace` entry from the
 * community catalog", through the very same prepare/commit pair every other entry
 * goes through. There is deliberately no second install path, no `bundled` flag and
 * no server-side job: the catalog install already resolves identity by lineage,
 * clones each git-linked child and reports the ones that arrived empty.
 *
 * What lives here is only what the catalog itself cannot answer:
 *   - WHICH entry is the default data (an id, overridable for a fork or a mirror),
 *   - whether THIS INSTANCE has been offered it already — a question `localStorage`
 *     cannot answer, since a second user on a second machine has an empty one.
 *
 * Client-only (WASM) builds never come through here: there is no git client in the
 * browser, so their default data is baked into `public/data/seed/` at build time
 * from the same published workspace. See `docs/planning/default-data-repos-plan.md` §0.
 */

import { apiRequest, isServerMode } from '@/lib/api-client'
import type { CatalogEntry } from './types'

/**
 * Catalog id of the entry that IS the default data.
 *
 * Overridable at build time so a fork or an internal mirror can ship its own
 * curated workspace without patching the source. The id is resolved against
 * whichever catalog the instance reads (Settings → Catalog), so pointing that at
 * a mirror and setting this to a matching id is the whole customisation story.
 */
export const DEFAULT_DATA_ENTRY_ID =
  import.meta.env.VITE_DEFAULT_DATA_ENTRY_ID || 'demo-workspace'

/** What this instance decided about the default data, as the server records it. */
export interface DefaultDataState {
  entryId: string | null
  decidedAt: string | null
  /** False for a decision of "start empty" — which is still a decision. */
  installed: boolean
  workspaceId: string | null
}

/** The entry the wizard offers, or null when this catalog does not publish one. */
export function findDefaultDataEntry(entries: CatalogEntry[]): CatalogEntry | null {
  return entries.find((e) => e.id === DEFAULT_DATA_ENTRY_ID) ?? null
}

/**
 * Whether this instance has already been asked about its default data.
 *
 * `null` means "never asked" and is the honest answer for an instance created
 * before this existed — the wizard only runs on a userless instance, so those are
 * never re-offered the question anyway.
 *
 * Front-only mode has no server to ask: it returns null, and the browser seed
 * (which that mode still owns) is left alone.
 */
export async function fetchDefaultDataState(): Promise<DefaultDataState | null> {
  if (!isServerMode()) return null
  try {
    const res = await apiRequest<{
      entry_id: string | null
      decided_at: string | null
      installed: boolean
      workspace_id: string | null
    }>('/setup/default-data')
    return {
      entryId: res.entry_id,
      decidedAt: res.decided_at,
      installed: res.installed,
      workspaceId: res.workspace_id,
    }
  } catch {
    // Unreachable or unauthenticated: treat as unknown rather than as "never
    // asked". The callers all degrade to doing nothing, which is the safe side —
    // never to re-seeding over instance data.
    return null
  }
}

/**
 * Record the decision. Best-effort: the install (or the choice not to) already
 * happened, and failing to write the note must not fail the wizard. The cost of a
 * lost note is that a fresh instance offers the step again, which is recoverable;
 * blocking setup on it would not be.
 */
export async function recordDefaultDataDecision(
  entryId: string,
  installed: boolean,
  workspaceId?: string,
): Promise<void> {
  if (!isServerMode()) return
  try {
    await apiRequest('/setup/default-data', {
      method: 'POST',
      body: JSON.stringify({ entry_id: entryId, installed, workspace_id: workspaceId ?? null }),
    })
  } catch {
    /* see above — the decision stands even if the note did not land */
  }
}
