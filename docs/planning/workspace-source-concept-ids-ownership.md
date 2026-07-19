# Plan — Source-concept-id ownership in workspace versioning

Status: **proposed** (awaiting validation before implementation)
Author: (assistant) — 2026-07-19

## Problem

A workspace export currently versions the source-concept-id registry **twice**:

1. **Root** `source-concept-ids/{ranges,entries}.json` — the *whole* workspace
   registry (all badges, all projects). This is the ONLY copy read on
   workspace import (`parseWorkspaceZip`) and by the portal seed loader
   (`seed-loader.ts`).
2. **Per mapping-project subfolder** `mapping-projects/{slug}/source-concept-ids/…`
   — a per-project scoped copy, written by `buildProjectSourceConceptIds` (only
   for the *full-export* branch; git-linked projects write just a pointer, so
   their scoped copy lives in the project's own repo instead).

The root `entries.json` duplicates data that already belongs to each project.
Worse, it goes **stale**: if a project's ids advance in its own repo but the
workspace isn't re-exported, the root copy is behind — and on import it would be
authoritative, so the allocation counter (`nextId`) could regress and later
re-hand-out ids already consumed → **id collisions**.

## Ownership model (target)

Each datum gets exactly one owner:

| Datum | Owner | File |
| --- | --- | --- |
| **entries** (concept → id) | the **project** (they describe its concepts) | `mapping-projects/{slug}/source-concept-ids/entries.json` |
| **ranges** (badge allocation: rangeStart/rangeEnd/**nextId**) | the **workspace** (cross-project, shared by projects on the same badge) | root `source-concept-ids/ranges.json` |

Standalone mapping-project versioning is **unchanged**: a project's own repo keeps
BOTH its `entries.json` (full, scoped to the project) and `ranges.json` (the
badges it uses). Only the *workspace-level* layout changes.

### Resulting workspace layout

```
workspace/
  source-concept-ids/
    ranges.json                 ← KEEP (whole-workspace badge allocation)
    entries.json                ← REMOVED
  mapping-projects/{slug}/
    source-concept-ids/
      entries.json              ← the project's entries (source of truth)
      ranges.json               ← the project's badge ranges (used as a nextId floor on import; see below)
```

For a **git-linked** project the subfolder still holds only `project.json` + the
git pointer at *export* time; its `source-concept-ids/` arrives when the linked
repo is cloned (portal submodule) or when the project itself is imported. This is
the same semantics `mappings.json` / `source-concepts.csv` already follow for
git-linked projects — entries now follow that same rule, which is the point.

## Import / seed reconstruction

Registry after importing a workspace =

- **ranges** = merge of the root `ranges.json` with every project subfolder's
  `ranges.json`, per badge, taking **`nextId = max`** and the widest
  rangeStart/rangeEnd window — reusing the existing monotone rule
  `resolveImportedRange` (source-concept-ids-io.ts). This is what makes the
  "project updated, workspace stale" case safe: the freshest project `nextId`
  wins over a stale root value, so the counter never regresses.
- **entries** = union of every project subfolder's `entries.json`.

Order is irrelevant because the range merge is a commutative `max`; entries are a
plain union keyed by `(badge, vocab, code)`.

### Robustness note (must `log`/surface, not hide)

For a git-linked project imported as a bare workspace ZIP (no portal clone, no
project import), the subfolder has no `entries.json`. Then that project's entries
are simply absent until the project is imported/cloned — exactly like its
mappings are absent today. This is intended, but we must not present it as
"complete". The portal path (submodules cloned) yields full entries. No silent
truncation: where we drop/So skip, we keep the behaviour observable.

## Files to change

1. **`apps/web/src/lib/entity-io.ts` (`buildWorkspaceZip`)**
   - Root block: write `source-concept-ids/ranges.json` only; STOP writing root
     `entries.json`.
   - Full-export branch already calls `buildMappingProjectFolder`, which writes
     the subfolder `source-concept-ids/` — keep it (entries now needed there).
   - Git-linked / metadata-only branches unchanged (pointer only; entries ride in
     via the linked repo).

2. **`apps/web/src/lib/concept-mapping/export.ts` (`buildMappingProjectFolder`)**
   - No change to the standalone path. (It already writes scoped
     `source-concept-ids/` via `buildProjectSourceConceptIds`.)
   - PRE-EXISTING BUG to fix here or note: `buildProjectSourceConceptIds` scopes
     entries by **whole badge** (`getByWorkspaceAndBadge`), not by the project's
     (vocab, code) universe. The server scoper (`source_concept_id_scope.py`)
     already does the correct project-scoping. To make the per-project entries
     truly own only their concepts (and match server bytes), align the client to
     project-scope too. Decision needed: fix now (in this chantier) or track
     separately. Recommended: fix now, since the whole model relies on
     per-project entries being genuinely per-project.

3. **`apps/web/src/lib/entity-io.ts` (`parseWorkspaceZip`)**
   - Read each `mapping-projects/{slug}/source-concept-ids/{ranges,entries}.json`
     and attach them to the parsed project (extend
     `ParsedWorkspaceZip.mappingProjects[]` with optional `sourceIdRanges` /
     `sourceIdEntries`, or aggregate into the existing top-level arrays).
   - Root read keeps `ranges.json`; root `entries.json` becomes optional
     (back-compat: still read it if an old ZIP has it, to not lose data).

4. **`apps/web/src/features/workspaces/WorkspacesPage.tsx` (`doImport`)**
   - After importing mapping projects, build the registry:
     - ranges = `resolveImportedRange`-merge(root ranges ∪ per-project ranges) per badge.
     - entries = union(per-project entries) [∪ legacy root entries if present].
   - Preserve the existing `duplicate` badge-relabel + id-rewrite logic.

5. **`apps/web/src/lib/seed-loader.ts`**
   - Same reconstruction as import: read root `ranges.json`, then per mapping
     project read its subfolder `entries.json` (+ `ranges.json` for the nextId
     floor), merge, save. Keep reading root `entries.json` if present (legacy).

6. **`../linkr-portal`** — no script change expected: `sync-git-links.sh` +
   `build.sh` already inject the linked project's full folder (including its
   `source-concept-ids/`). Verify the seed loader change consumes the subfolder
   entries. Note in the portal repo if the root `entries.json` disappearing needs
   a docs touch.

## Tests

- `source-concept-ids-io` (unit): range merge across N sources keeps `nextId`
  monotone (root stale + project ahead → project wins); entries union dedups by
  `(badge, vocab, code)`.
- `entity-io.test.ts` (`buildWorkspaceZip`): workspace export writes root
  `ranges.json` but NOT root `entries.json`; a full-export project subfolder DOES
  carry `source-concept-ids/entries.json`.
- `parseWorkspaceZip` round-trip: a workspace ZIP with per-project entries
  reconstructs the same registry as before (superset when the old root copy was
  stale).
- If the per-project entry-scoping fix (item 2) lands: extend the golden parity
  (client `buildProjectSourceConceptIds` vs server `scoped_source_concept_ids`).

## Rollout / back-compat

- Reading: keep tolerating a root `entries.json` (old ZIPs / mid-migration repos)
  so no data is lost; new exports stop writing it.
- One-time diff on the first workspace re-export (root `entries.json` deleted,
  per-project `entries.json` added/kept). Expected and self-settling, like the
  earlier code-point sort migration.
- Per user preference: no back-compat *layers*; the tolerant read above is a
  simple optional-file read, not a compat shim.

## Decisions (validated)

1. **Defer the exact client per-project entry scoping.** Aligning the client
   `buildProjectSourceConceptIds` to the server's project-scoping would require a
   heavy per-project dictionary read (mount + query the 177k-row DuckDB
   `source_concepts` view) *during export* — and the workspace export always runs
   client-side, even in fullstack mode (`serverBuildsZip` is true only for
   `mapping-projects`). That browser cost is exactly what we're avoiding. So keep
   the current **whole-badge** client scoping for now (correct, just slightly
   wide: a project may carry sibling-project entries sharing its badge). The exact
   scope becomes free once the workspace export moves server-side (a later
   chantier), where `scoped_source_concept_ids` already does it. The ownership
   model below does NOT depend on perfect scoping — it delivers the real win
   (no root-entries duplication, monotone nextId anti-regression) regardless.
2. **Prefer per-project entries on import.** A project that ships its own
   `entries.json` owns its entries; the root `entries.json` is only a fallback
   for projects (badges) that have no per-project entries in the ZIP — e.g. a
   legacy export, or a git-linked project not yet cloned. Concretely: seed the
   registry from the union of per-project entries first, then fill in from the
   root `entries.json` only the (badge, vocab, code) keys not already present.
   Ranges are always the monotone merge (root ∪ per-project, nextId = max).
