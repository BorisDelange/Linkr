# Linkr — Performance roadmap

This file tracks the performance work on the concept-mapping feature: what's been
shipped, and what remains as Phase 2 (the lazy-seed architecture).

## Status as of last update

- **Phase 1 (RAM quick wins)** — shipped (`99f68454`)
- **Round 3 (UX polish + vocab dedup + bulk import)** — shipped (`7bfc39d7`, `cba15834`, `53c60c40`)
- **Surgical paging in MappingsTab** — shipped (this commit)
- **Phase 2 (lazy seed)** — not started, see below

When the user reports lag in mapping pages (especially on a linkr-portal deployment with
many projects or large mappings.json files), suggest starting Phase 2.

---

## Phase 1 — Quick wins (shipped)

In-memory and IDB pressure reduction. No change to the seed contract.

1. **`loadProjectMappings`** ([apps/web/src/stores/concept-mapping-store.ts](../apps/web/src/stores/concept-mapping-store.ts)): `mappingsLoaded` guard avoids a reload when the same project is re-opened. Legacy migration loop runs only when at least one row needs it (`needsMigration` quick scan). `{ force: true }` flag for callers that must reload (post-import).
2. **Cheap/heavy split for cross-project loaders**: `loadOtherProjectsMappedKeys` (just a `Set<string>`, ~1 MB) vs `loadOtherProjectsDetails` (full `Map<key, ExternalMappingInfo[]>`, heavier). Cache markers `_otherKeysLoadedFor` / `_otherDetailsLoadedFor` invalidated on relevant mutations.
3. **`MappingEditorTab`** calls the cheap version immediately, the heavy one after a 500 ms delay (page paints first).
4. **`MappingsTab`** calls the heavy version directly, deduped via cache.
5. **Removed `Promise.all(projects.map(recomputeProjectStats))` on ListPage mount**: stats now come from the persisted `MappingProject.stats`, refreshed in fire-and-forget after each mutation.
6. **DuckDB unmount**: `MappingProjectPage` cleanup calls `unmountFileSource(projectId)` → frees ~200 MB DuckDB-WASM memory per project switch.

## Round 3 — UX polish + vocab dedup + bulk import (shipped)

- "Vocabulaires OHDSI" tab rename, accepted vocab files trimmed to CONCEPT (required) + CONCEPT_ANCESTOR / CONCEPT_RELATIONSHIP (optional).
- Vocab files dedup by SHA-256 in IDB (DB v30 + `by-content-hash` index, `dedupRef` chain).
- Vocab search switched to ranked SQL (multi-tier Jaro-Winkler) like the Mapping Editor's target search.
- TargetConceptPanel split into 2 rows so the toggle no longer overlaps action buttons.
- `importExternalMapping` preserves status / reviews / comments (no longer wipes them).
- Bulk-import button in MappingsTab with multi-select project picker.
- ConceptSetsTab search: Filters popover + explicit Search button + warning AlertDialog when running a text search with no filter applied. Stops querying on every keystroke.

## Surgical paging in MappingsTab (shipped)

The store keeps a `mappings: ConceptMapping[]` array but adds in parallel:

- `mappingsById: Map<string, ConceptMapping>` — O(1) index, mutated in place by `updateMapping`
- `mappingsVersion: number` — bumped on every per-row mutation (vote, comment, …)
- `mappingsStructureVersion: number` — bumped only when set membership or aggregated fields (status, vocab, domain, equivalence) change

`updateMapping` patches the index + replaces `mappings[idx]` in place, **without** swapping the array reference. The hot-path optimization: a vote (only changes `reviews` + bookkeeping) bumps `mappingsVersion` only — memos depending on `mappingsStructureVersion` (`projectMappings.filter`, `externalMappings`, `allDisplayMappings`, `filterOptions`, `statusCounts`) keep their cached value. Memos depending on `mappingsVersion` (`rowDerived`, `filtered`, `sorted`, `columns`) re-derive but with O(1) `mappingsById.get(id)` lookups.

Net win: a vote on a row with 10k mappings goes from rebuilding ~9 memos × 10k items to rebuilding ~4 memos × 10k items, with cheaper per-row work.

---

## Phase 2 — Lazy seed architecture (not started)

**The real blocker for 100+ projects of 200k concepts.** Splits the data lifecycle: the seed (under `data/seed/<ws>/…`) stays on the static CDN and is fetched on demand; IndexedDB only holds the user's diffs (overlay).

```
[ Seed = read-only CDN ]   →  fetched on demand, never copied to IDB
[ IDB = user changes ]     →  overlay: only diffs from seed
```

IDB becomes a cache of the user's modifications, not a complete mirror. Read pattern is OverlayFS-style: `IDB.has(id) ? IDB : fetch(seed)`.

### 2.1 — New manifests generated at portal build (`linkr-portal-*/scripts/build.sh`)

For each `mapping-projects/<x>/`:

- **`_summary.json`** — `{ id, name, description, badges, stats, totalSourceConcepts, contentHash }`. ~5 KB. Enough to render the project list.
- **`_stats.json`** — pre-computed from `mappings.json` at build time → `recomputeProjectStats` becomes a no-op at runtime.
- **`_keys.json`** — `string[]` of `"vocab:code"` for non-ignored mappings. ~50× smaller than `mappings.json`.

For each workspace:

- **`_cross-project-keys.json`** — `Record<vocab:code, projectId[]>`. Replaces the per-project scan in `loadOtherProjectsMappedKeys`.

### 2.2 — Dual-mode seed loader

[apps/web/src/lib/seed-loader.ts](../apps/web/src/lib/seed-loader.ts) — the `mapping-projects/` block (around line 497).

**Detection**: probe `_summary.json`. If 404 → legacy mode (current behavior, copy everything to IDB). If present → lazy mode.

**Lazy mode**:

- Read `_summary.json` only → create a stub `MappingProject` in IDB with a `_seedRef: { workspace, folder }` marker
- **Do NOT** copy `mappings.json` to IDB
- **Do NOT** copy `source-concepts.csv` to IDB
- Stats come from `_stats.json` (no compute needed)

One ~5 KB fetch per project at workspace open instead of multiple MB.

### 2.3 — Overlay storage layer

[apps/web/src/lib/storage/idb-storage.ts](../apps/web/src/lib/storage/idb-storage.ts) — `IDBConceptMappingStorage`.

Overlay-aware reader:

- **`getByProject(projectId)`**:
  1. Fetch `mappings.json` from `data/seed/<ws>/mapping-projects/<folder>/` (HTTP cache handles repeats)
  2. Read all `concept_mappings` rows for `projectId` from IDB → user-added or user-modified
  3. Merge: IDB wins on collision (by `id`)
  4. Return merged list

- **Tombstones**: when the user deletes a seed-backed mapping, write `{ id, _deleted: true }` in IDB to mask the seed entry.
- **`update(id, changes)`**: if no IDB row exists, fetch the seed entry, apply changes, write the full result to IDB (copy-on-write).
- **`create(mapping)`**: write to IDB as today (purely local).
- **`delete(id)`**: if seed-backed → write tombstone; else → remove from IDB.

API surface preserved → most callers don't notice. New "Reset project to seed" button clears the IDB rows for a project, returning to the pristine seed.

### 2.4 — DuckDB CSV mounting via fetch URL

[apps/web/src/lib/duckdb/engine.ts](../apps/web/src/lib/duckdb/engine.ts) — `mountFileSourceIntoDuckDB`.

For seed-backed projects (`_seedRef` present), instead of `db.registerFileBuffer(...)` with the buffer copied from IDB:

```ts
await db.registerFileURL(fileName, seedUrl, DuckDBDataProtocol.HTTP, false)
```

DuckDB-WASM fetches the CSV directly over HTTP (range requests for partial reads). The CSV never enters IDB. Browser HTTP cache makes repeat opens free.

For locally-imported projects (no `_seedRef`), keep the current `registerFileBuffer` path.

### 2.5 — Cross-project keys via static manifest

[apps/web/src/stores/concept-mapping-store.ts](../apps/web/src/stores/concept-mapping-store.ts).

When `_cross-project-keys.json` is available (Phase 2 portals):

- Fetch it (~1 MB for 100 projects)
- Build `otherProjectsMappedKeys: Set<string>` directly from its keys
- Skip the per-project IDB scan entirely

Falls back to the Phase 1 in-memory scan for legacy portals without the manifest.

### Verification

1. In `linkr-portal-ricdc`: update `scripts/build.sh`, run it, verify `_cross-project-keys.json` and `_summary.json` exist under `dist/data/seed/…`.
2. In Linkr: open the IDB inspector → `concept_mappings` table should be **empty** for seed-backed projects until the user edits something. Modify a mapping → one row appears. Reload → edit persists. "Reset to seed" → row removed, seed reappears.
3. Network tab: `mappings.json` fetched once with `from disk cache` on the second open.
4. Backwards compat: test against a portal build without the new manifests → legacy mode must still work.
5. Scale test: synthetic workspace of 50 projects × 50k mappings → ListPage <1s, navigation instant, heap <500 MB.

### Suggested order of attack

1. Branch `perf/lazy-seed`
2. Step A: `build.sh` manifests in `linkr-portal-ricdc` (script-only, low risk)
3. Step B: seed-loader dual-mode (100% backwards compatible)
4. Step C: overlay storage (behavior change, test carefully)
5. Step D: DuckDB `registerFileURL`
6. Step E: cross-project keys manifest
7. Manual test on a dev portal at every step before push

---

## Out of scope (deferred)

### Server-side fuzzy search in MappingEditorTab
Today the fuzzy search loads all mappings and filters client-side. Push to DuckDB SQL. Not critical until projects exceed 100k mappings.

### Splitting `mappings.json` into chunks
HTTP/2 already multiplexes well. Keep in reserve if TTFB on very large files becomes an issue.

### Service Worker for offline seed cache
Enables full offline mode after the first visit. Adds complexity (SW lifecycle, invalidation). Consider when offline is an explicit user request.

### Workspace-shared vocabulary (alternative to hash dedup)
Instead of content-hash dedup (Round 3, step 3), promote vocabularies to first-class workspace resources. More UX (a "Vocabularies" page in the workspace), but conceptually cleaner. Hash dedup is a pragmatic shortcut that gets 90% of the gain for 10% of the effort.

### Sticky HTTP cache on seed manifests
With `Cache-Control: max-age=31536000, immutable` + content-hash in the URL (`mappings.<hash>.json`). Requires changing the `_index.json` schema to expose hashes. Phase 2.5 if cold-start optimization becomes important.

---

## Mental model — clear separation

| Layer | Location | When populated | When cleared |
|---|---|---|---|
| **Seed** | CDN (`/data/seed/<ws>/...`) | Portal CI build | Never (immutable per release) |
| **IDB user-edits** | IndexedDB | When the user creates/modifies/deletes | "Reset workspace data" or clear browser data |
| **DuckDB working set** | RAM (Web Worker) | Mounted on demand (open project) | Unmounted on project switch (Phase 1.6) |

Hash dedup (Round 3) applies only to the **IDB user-edits** layer for local vocab imports. The seed doesn't need dedup because it's never copied.
