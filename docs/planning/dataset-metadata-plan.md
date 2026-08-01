# Dataset column metadata — design (labels, descriptions, value labels, parse options)

Status: **design, ready to implement.** Captures how a dataset's *editorial*
column metadata — display **label**, **description**, categorical **value
labels** (code→label), plus the **parse options** (column types, filter mode,
delimiter…) — is persisted so it **survives an app restart** and **travels with
the dataset** on project export (ZIP) and git-sync, in **server mode**.

Local (IndexedDB) mode already persists all of this inside the `DatasetFile`
record; this plan is about closing the **server-mode** gap. It also unifies the
scattered storage into a single source of truth per dataset.

## Why this exists (the bug + the incoherence)

Server-mode datasets are **disk-source-of-truth**: the raw file under
`projects/<uid>/datasets/` is the truth; a Parquet cache under `.cache/` powers
pagination/stats. There is **no DB row** per dataset in server mode (import writes
disk + cache only — no `db.add`; the `DatasetFile` DB model and its `columns` /
`parse_options` columns are unused legacy in this mode). Consequences today:

- **label / description / valueLabels** — nowhere to persist → lost on restart.
  This is the reported bug. (`updateColumnMeta` / `renameColumn` post a
  `{columns}` patch that `apiDatasetFileStorage.update` silently drops.)
- **columnTypes / delimiter / encoding** — survive restart *only* because the
  Parquet cache freezes the parse result (keyed by the raw's `{mtime,size}`).
  **Fragile**: if the raw file changes (e.g. a `git pull` updating the CSV),
  `/meta` reparses with `parse_options=None` → custom types silently lost.
  They travel on export only because they're baked into the exported `columns`.
- **columnFilterMode (list/text)** — front-only; never sent to the server in
  server mode → **does not even survive a restart**.

So server mode has **no durable, versioned home** for a dataset's editorial
metadata. One sidecar fixes all four at once.

## Principle: one disk sidecar per dataset, merged at read time

Store all editorial metadata in **one JSON sidecar per dataset on disk**, under
the **project root** (not in `.cache/`, so it is git-tracked). Merge it onto the
freshly-derived columns inside `resolve_cache`, so **every consumer** — `/meta`,
rows, stats, and the export/git-sync tree builder (which all go through
`resolve_cache`) — sees it, with **no extra export code**.

This mirrors the existing `DatasetAnalysis` precedent (dataset metadata keyed by
`(project_uid, dataset_path)`, reconciled on scan) — but as a **disk sidecar**,
because the export/git-sync path reads the **disk**, never the DB. Disk storage
is the only choice that travels with the dataset for free; a DB table would need
extra DB→disk injection at build time and would not reach a colleague who clones
the repo. Decision: **disk sidecar, not DB.**

## Storage — where and what

### Path — under the project root, NOT under the re-bindable `datasets/`

```
projects/<uid>/dataset-meta/<hash>.json
```

**Critical**: the sidecar must live under `project_dir()` (the project root),
**not** under `datasets/`. The datasets directory is **re-bindable**
(`datasets_binding` — a project can point `datasets/` at an arbitrary external
folder: a network mount, a dir outside the project git, possibly read-only; see
the IDE/datasets-path binding feature). A sidecar under `datasets/.meta/` would
then (a) fall outside the project git → **not travel**, defeating the whole goal,
or (b) fail to write if the bound dir is read-only.

This is exactly the problem `environments/` already solved: it lives under
`project_dir()`, **not** under the re-bindable `scripts_dir`, precisely "so it
travels with the project regardless of the IDE binding" (`project_fs.env_spec_dir`
docstring). The column-metadata sidecar follows the same rule: a sibling
`dataset-meta/` directory under the project root.

- `<hash>` = same key as the cache meta (`sha1(rel_path)[:16]`, `dataset_fs._key`,
  where `rel` is the logical `datasets/<path>`), so a dataset and its sidecar
  share a key **regardless of where `datasets/` is bound**.
- No change to `project_fs._IGNORE` needed: the sidecar is not under `datasets/`,
  so the dataset tree scan never sees it. It is a project-root dir like
  `environments/`, git-tracked and exported.

### File shape

Keyed by stable column id (`col_<slug>`, identical front/back), plus a
dataset-level `parseOptions` block:

```json
{
  "parseOptions": {
    "columnTypes":      { "col_age": "number" },
    "columnFilterMode": { "col_sex": "list" },
    "delimiter": ",", "encoding": "utf-8", "skipRows": 0, "hasHeader": true, "sheet": null
  },
  "columns": {
    "col_sex": { "label": "Sexe", "description": "…", "valueLabels": { "m": "Homme", "f": "Femme" } },
    "col_age": { "label": "Âge",  "description": "Âge à l'inclusion" }
  }
}
```

Only touched columns / set options appear (minimal, no noise). A dataset with no
edits has no sidecar.

## Application — merge in `resolve_cache`

`dataset_fs.resolve_cache` already returns `{parquet, columns, rowCount, native}`.
Change:

1. **Read the sidecar** (independent of the cache-meta `{sig,columns,rowCount}` —
   the sidecar is *not* invalidated by a reparse; it is the durable truth).
2. On a **cache miss/reparse**, feed `parseOptions` from the sidecar into the
   parser instead of the caller's arg — this fixes the "raw changed → types lost"
   failure: types come from the sidecar, not from a now-stale cache.
3. **Overlay** `columns[*].{label,description,valueLabels}` onto the derived
   `{id,name,type,order}` columns, matched by `col.id`.
4. Return the merged columns.

Because `_dataset_node` (export) and `/meta` both call `resolve_cache`, the
labels + types appear in `_tree.json` and in the live UI through this **single**
change. `columnFilterMode` now also round-trips (it rides in `parseOptions`).

### Write path (new endpoint)

`POST /dataset-files/columns/meta` — body `{ projectUid, path, columns?, parseOptions? }`.
Merges the given fields into the sidecar (read-modify-write), creating
`datasets/.meta/` on demand. Permission: `datasets:write`.

`setColumnType` / `setColumnFilterMode` migrate to also write the sidecar (types
still trigger a `/reimport` to rebuild the Parquet; the sidecar records the
intent durably so a later raw-change reparse re-applies it).

## Export / git-sync — drop `_columns.json`, keep `_tree.json` as the sole source

Today each dataset emits **both** `datasets/_tree.json` (columns inline — the
source of truth, relied on at import) **and** `datasets/<path>/_columns.json` (a
duplicate, **never read back** on import — decorative). Per the "one source of
truth" decision:

- **Remove `_columns.json`** from `buildProjectZip` (`entity-io.ts`) and the
  Python twin (`project_export.py`). `_tree.json` remains the single carrier;
  its `columns` already include the new fields (merged via `resolve_cache`).
- Import already ignores `_columns.json` (`entity-io.ts:1300,1325`), so removing
  it is backward-safe for reading older ZIPs (absent file → skip).
- **parseOptions in `_tree.json`**: the server `_dataset_node` must now emit
  `parseOptions` (from the sidecar) so it travels too. (Local/TS export already
  keeps `parseOptions` in `_tree.json`.)

### Round-trip

| Step | What happens |
|------|--------------|
| Edit label / type | `POST …/columns/meta` → writes `dataset-meta/<hash>.json` |
| Open dataset (`/meta`) | `resolve_cache` re-derives columns + **merges sidecar** → survives restart |
| Export / git-sync | `_dataset_node` → `resolve_cache` (same merge) → labels+types+parseOptions in `_tree.json` |
| Colleague imports ZIP | `_tree.json` read verbatim → columns + parseOptions reinjected |
| Raw file removed | `purge_orphans` deletes `dataset-meta/<hash>.json` too |

## Migration of existing datasets

No data migration: absence of a sidecar = a dataset with no editorial metadata
(the common case). Columns keep being derived as `{id,name,type,order}`; types
keep working via the frozen Parquet cache exactly as before until the user first
edits, which writes the sidecar. Nothing breaks for pre-existing datasets.

## Edge cases

- **Raw file changed under a sidecar** — the sidecar is keyed by stable
  `col_<slug>` ids, not by content; on reparse, overlay by id. A column that
  disappeared from the raw simply has no target (its sidecar entry is inert,
  kept — not dropped — so a transient raw change doesn't destroy labels).
- **Column renamed in the raw → new id** — new `col_<slug>` ⇒ no overlay match;
  the old entry becomes inert. Acceptable (same behavior as a genuinely new col).
- **Sidecar vs. cache-meta divergence** — cache-meta stays purely derived
  (`sig,columns,rowCount`); the sidecar is the editorial truth. They never write
  each other. A stale cache is rebuilt from raw + sidecar.
- **Concurrent edits** — read-modify-write the small JSON under the same
  project-scoped path; last write wins (consistent with the rest of server mode).

## Blocking prerequisite — portal must not read `_columns.json`

**Before** removing `_columns.json`, verify `../linkr-portal` (`scripts/build.sh`,
`sync-git-links.sh`) and `apps/web/src/lib/seed-loader.ts` do **not** read it. If
either does, removal breaks pre-seeded deployments. This is a **gate**, not a
post-hoc check: if it reads `_columns.json`, either keep the file (Open Question 1)
or migrate the reader to `_tree.json` first. Keep the export layout in sync (per
CLAUDE.md "Related repos").

## Impact on tests

- **Golden export tests** (`project-export-golden.test.ts`, Python twin): dropping
  `_columns.json` and adding `parseOptions` to `_tree.json` **changes the golden
  tree** → regenerate (`GOLDEN_UPDATE=1 …`) and re-verify TS + Python byte-parity.
  Extend the fixture `input.json` so a dataset carries `parseOptions` +
  label/description/valueLabels (partly done already for the column fields).
- **Unit test** for the sidecar merge (pure): `merge_column_meta(derived, sidecar)`
  overlays by id, leaves untouched columns intact, ignores unknown ids.

## Work breakdown — deliver in two phases

The safe scope (labels) and the risky scope (parseOptions + format change) are
**decoupled**. Ship Phase 1, verify it in your running app, then do Phase 2 — a
single diff that touches parsing *and* changes the export format *and* removes
`_columns.json` is exactly the kind that breaks something subtle.

### Phase 1 — labels only (fixes the reported bug, additive, low risk)

Sidecar carries **only** the `columns` section (label/description/valueLabels);
`parseOptions` untouched; `_columns.json` untouched; export format unchanged.

**Backend**
1. `dataset_fs`: sidecar read/write under `dataset-meta/` + `merge_column_meta`.
2. `resolve_cache`: read sidecar → overlay `label/description/valueLabels` by id.
3. `purge_orphans`: delete the sidecar alongside the cache.
4. `POST /dataset-files/columns/meta` (read-modify-write, `columns` only for now).
5. `DsNodeResponse` + `_dataset_node`: carry the new column fields.

**Frontend**
6. `apiDatasetFileStorage.update`: when `changes.columns` present → `POST …/columns/meta`.
7. `DsNode.columns` type += `label/description/valueLabels`.

**Tests**
8. Sidecar-merge unit test; regenerate + verify golden (TS + Python).

### Phase 2 — parseOptions + drop `_columns.json` (after Phase 1 verified)

Depends on the **blocking portal check** above.

9. Sidecar `parseOptions` section; `resolve_cache` feeds it on reparse (fixes the
   "raw changed → types lost" failure); `_dataset_node` + `DsNodeResponse` carry
   `parseOptions`; `dsNodeToFile` carries it back.
10. `setColumnFilterMode`: add the server branch (write the sidecar).
11. `setColumnType`: also write the sidecar (durable intent, not just the reimport).
12. Stop writing `_columns.json` (`project_export.py` + `entity-io.ts`);
    `_tree.json` is the sole carrier. Regenerate + verify golden (TS + Python).

## Open questions

- Keep `_columns.json` as a **read-only human-friendly** view (git diffs) while
  making `_tree.json` authoritative, instead of removing it? (Plan assumes
  removal for a single source of truth; revisit if the diff readability matters.)
- Should `columnFilterMode` (pure UI concern) really travel on export, or stay a
  per-user front preference? (Plan lets it travel for simplicity/consistency.)
