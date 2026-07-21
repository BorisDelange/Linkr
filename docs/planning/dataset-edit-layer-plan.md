# Dataset edit layer — design (spreadsheet-style editing)

Status: **design only, not implemented.** Captures how to let users edit an
imported dataset (change cell values, delete/add rows, drop/rename/reorder
columns, change a column type) without ever mutating the original raw file.

## Principle: raw stays immutable, edits are a replayable layer

The raw file under `projects/<uid>/datasets/` is the single source of truth (see
`dataset_fs.py`). Editing must never alter it. Instead, edits are an **ordered
list of operations** stored beside the dataset and **replayed on top of the raw**
to produce the effective dataset (the Parquet cache). This is the
Dataiku/Trifacta "recipe" and OpenRefine "operation history" model, adapted to
Linkr's raw-is-king architecture.

Non-destructive, reversible (undo = drop the last op), versionable (the op list
is small JSON, git-friendly), and traceable.

### How the domain tools do it (for reference)

- **Grist / Airtable / NocoDB** — the editable table *is* the source of truth (a
  relational store); each edit is a row transaction. Grist additionally keeps an
  action log (`UpdateRecord`, `AddColumn`, …) enabling undo/redo, replay, and
  realtime sync. Model: "live table", not "raw file + cache".
- **Dataiku / Trifacta Wrangler** — raw file immutable; transformations are an
  ordered **recipe** replayed on every build to produce the output dataset.
- **OpenRefine** — an operation-history JSON (replayable, exportable) layered
  over the imported data.

Linkr already keeps the raw immutable, so the Dataiku/OpenRefine ordered-ops
model is the natural fit — not the live-table model.

## Current state (what already exists)

- `dataset-store.ts` already has `updateCell`, `addRow`, `removeRow`,
  `addColumn`, `removeColumn`, `renameColumn`, `reorderColumns` — but they are
  **local-only** (IndexedDB) and early-return in server mode
  (`if (isServerMode()) return`). So client-side editing exists; the missing
  piece is **server-side persistence + replay**.
- `parseOptions.columnTypes` (per-column type override) already ships and is
  applied at parse in `dataset_parser`. It is effectively the first edit
  operation of this layer (`setColumnType`) — the rest generalize it.

## Proposed model

### Operation shape

```ts
type DatasetEditOp =
  | { op: 'setCell'; rowKey: string; columnId: string; value: unknown }
  | { op: 'deleteRows'; rowKeys: string[] }
  | { op: 'addRow'; values: Record<string, unknown> }        // appended
  | { op: 'dropColumn'; columnId: string }
  | { op: 'addColumn'; columnId: string; name: string; type: DatasetColumn['type'] }
  | { op: 'renameColumn'; columnId: string; name: string }
  | { op: 'reorderColumns'; order: string[] }                // full columnId order
  | { op: 'setColumnType'; columnId: string; type: DatasetColumn['type'] }
```

Ordered, append-only. Undo = pop the last op. `setColumnType`/`reorderColumns`
already have store methods and can migrate into this list.

### Row identity — the hard part

`setCell`/`deleteRows` need a stable row key that survives re-parse. The raw file
has no natural key. Options:
- **Stable synthetic row id** assigned at parse from the raw row's ordinal
  (`__row = 0..N-1`) — simple, but shifts if the raw file itself changes (a new
  import). Acceptable: edits are tied to a given raw revision (tracked by the
  raw's (mtime,size) signature already used for cache invalidation); if the raw
  changes, warn that edits may not re-apply cleanly.
- A content hash of the row — stable across reorder but collides on duplicate
  rows. Rejected (ICU datasets have many identical rows).

Recommendation: ordinal-based `__row` id, edits scoped to the current raw
signature; surface a "raw changed, review edits" state when the signature moves.

### Storage — where

Beside the dataset, mirroring `columnTypes`:
- **Server mode**: in the cache meta sidecar (`_meta.json` via `dataset_fs`) OR a
  dedicated `edits.json` next to it. Keyed by the raw signature so a raw change
  is detectable. The op list is small; it is NOT the Parquet (that's the
  replayed output).
- **Local mode**: in IndexedDB alongside the dataset record.
- **Export/versioning**: the op list travels with the dataset metadata (small
  JSON), never the materialized rows — consistent with the existing export
  stripping rules.

### Application — where in the pipeline

In `dataset_fs.resolve_cache`, after parsing the raw and before writing the
Parquet cache, **replay the ops in order** as DuckDB SQL over the parsed
relation:
- `setCell` → `UPDATE`/`CASE WHEN __row = k THEN v`
- `deleteRows` → `WHERE __row NOT IN (...)`
- `dropColumn` → projection without the column
- `renameColumn` → aliased projection
- `reorderColumns` → SELECT column order
- `addColumn` → `SELECT *, NULL AS newcol`
- `setColumnType` → the existing `columnTypes` mechanism (try_cast)

Cache invalidation extends to include the ops' hash (re-materialize when either
the raw signature OR the edits change). Client (local) mode replays the same ops
in JS over the in-memory rows (the store methods already do most of this).

### UI

- Cell edit: double-click a cell in `DatasetTable` (guarded by `canEdit`).
- Row ops: row context menu (delete), toolbar (add row).
- Column ops: extend the existing column context menu (drop/rename/reorder are
  already partly there; reorder via drag of the header).
- An "Edits (n)" indicator + undo, and a "Revert all edits" that clears the op
  list and re-materializes from the pristine raw.

## Open questions

- Undo/redo depth and whether to compact ops (e.g. two `setCell` on the same
  cell collapse to one).
- Behaviour when the raw file is re-imported/changed under existing edits
  (warn + let the user re-apply or discard).
- Whether edited datasets become a distinct "derived" kind vs. staying the same
  dataset with an edit layer (recommended: same dataset + layer).
- Interaction with analyses/dashboards that reference the dataset (they read the
  effective/cached dataset, so they see edits transparently — verify column-id
  stability across `dropColumn`/`renameColumn`).
