# Dataset edit layer, manual collection & dataset-backed timeline

Four features that share one foundation: a dataset stops being a read-only import and
becomes something a clinician edits, fills in patient by patient, and plots next to OMOP
data. The foundation is an **ordered, replayable operations log over an immutable raw
file** — the Dataiku/OpenRefine model.

Arbitrated 2026-09-06. Supersedes the 💤 backlog line *"Dataset edit layer:
spreadsheet-style edits over the immutable raw"*, which had never been arbitrated
against pipeline-only transforms.

## 1. Why an ops log, and where its boundary with the Pipeline sits

`docs/architecture.md` states the product's philosophy: *"Pipeline = Transforms. Source
never modified. Each transform produces a new output dataset."* An edit layer on the
dataset itself looks like a second mechanism for the same thing. It is not, and the line
is **the nature of the intent, not the nature of the operation**:

- **Ops log** — manual, one-off corrections and human data entry. Irreducible to a rule:
  *"this value is wrong, the real one is 4.2"*. Manual collection is this by nature.
- **Pipeline** — anything expressible as a rule and replayable over new data.

The question that decides: *"if the source data changes tomorrow, do I want this
operation to re-apply by itself?"* Yes → pipeline. No → ops log.

The raw file stays immutable — that is an architectural invariant, stated in
`dataset_fs.py`'s module docstring and in `docs/architecture.md` § Datasets, not an
accident. The ops log is the only sanctioned way to mutate a dataset, and the Parquet
cache is derived and disposable, so it can be rebuilt as:

```
raw → parse(parseOptions) → replay(ops) → parquet cache
```

`resolve_cache` already performs the first, second and fourth steps with `(mtime, size)`
invalidation. Step three inserts before the Parquet write, and the cache signature gains
the ops-log hash.

### Why this is state of the art, and what it costs

The model is OpenRefine's, Dataiku's, Trifacta's. It buys undo for free, reproducibility,
provenance, and a readable git diff. It holds only while the log stays modest — replaying
N ops on every read is linear. Two guardrails, in from the start:

- **Compaction** — cell ops on the same `(row, column)` collapse to the last one. The log
  grows with the number of *cells touched*, not the number of clicks.
- **Materialisation** — the replay result *is* the Parquet cache. Replay happens on edit,
  never on read.

## 2. The three obstacles the code imposes

**Row identity does not exist.** `updateCell`/`removeRow` in `dataset-store.ts` key on
`rowIndex`. In server mode the client only ever sees one sorted, filtered page, so a
positional op is not replayable there at all. We need a stable key: **the ordinal in the
raw file**, which works precisely because the raw is immutable. Rows added by an op take
decreasing negative ordinals — they can never collide with raw ordinals.

**Column ids are derived from names.** `columnId(name) = col_<slug>`, with a Python twin
under a parity test. A rename is therefore a *rekey*: it changes the physical row key and
every downstream reference. `packages/linkr-format/src/rekey.ts` already repairs widget
configs and filters for exactly this case (matching by value, never by key name) — reuse
it, do not rewrite it. Reordering columns is by contrast harmless: it is an `order` field,
not a key.

**Server mode has no rows-write route,** and the six store mutators (`updateCell`,
`addRow`, `removeRow`, `addColumn`, `removeColumn`, `reorderColumns`) are dead code behind
`if (isServerMode()) return`. This is the "unused groundwork" the backlog referred to. Its
persistence — a debounced whole-rows rewrite plus a `JSON.stringify` of the entire dataset
for dirty-checking — does not scale. The log replaces it rather than building on it.

A fourth, smaller one: the existing `UndoAction` is closure-based (`undo: () => void`), so
it is neither serialisable nor replayable, and only covers tree operations. Undo here is a
different mechanism, derived from the log — not an extension of that one.

## 3. Decisions taken

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Client *and* server from the start** | Manual collection is intrinsically a server feature (multi-user, data that persists). Shipping WASM-only would hollow out Lot D. |
| 2 | **The log lives in the `dataset-meta/<hash>.json` sidecar**, as an `ops` section | Already multi-section (`columns`, `parseOptions`, a declared-unused `survey`), already git-tracked, already canonicalised for front/back byte parity, already travels on export. |
| 3 | **The write route appends ops, never replaces the log** | See below. |

### Why append rather than replace

The sidecar's existing writers are "authoritative replace" — the client sends the full
desired state. Applied to the ops log that would lose data silently: two people collecting
on *different patients* each hold their own in-memory copy of the log, and the second to
write drops the first's ops, even though they touched no common cell.

Since ops are independent and ordered, the fix is cheap and belongs in Lot A rather than
retrofitted: `POST /dataset-files/ops` takes *"append these ops"*, and the server
concatenates. Two clients on different patients never collide; two on the same cell give
last-writer-wins, which is the expected behaviour. Compaction and reset-to-raw remain
whole-log replacements.

Single-user and WASM modes are unaffected either way.

## 4. Lots

Lot A is a prerequisite for B and D. C is independent of A.

### Lot A — Ops-log foundation

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Stable row key `__row_ord` (raw ordinal, materialised in the Parquet cache; added rows take negative ordinals) | M |
| 🔜 | 2. Op types + inverses in `packages/linkr-format` and its Python twin: `setCell`, `addRow`, `removeRow`, `reorderRows`, `addColumn`, `removeColumn`, `reorderColumns`, `renameColumn` | M |
| 🔜 | 3. Persistence: `ops` section of the sidecar (canonicalised like `parseOptions`) + `POST /dataset-files/ops` in **append** semantics, modelled on `/columns/meta` | M |
| 🔜 | 4. Replay engine, TS + Python, under a parity test (the discipline already in place for `column_id` and the export builders) | L |
| 🔜 | 5. Compaction + cache invalidation on the ops-log hash (extends `resolve_cache`'s `sig`) | S |
| 🔜 | 6. `renameColumn` routed through `rekey.ts` so downstream widget/filter references are repaired | M |

### Lot B — Editing in the Datasets page

| St | Item | Effort |
|----|------|--------|
| 🔜 | 7. Cell selection model + in-place editing in `DatasetTable.tsx` (today plain read-only `<td>`s; hand-rolled table, so no TanStack to fight, but focus/keyboard/clipboard is greenfield) | L |
| 🔜 | 8. Add/remove/reorder rows; header drag for columns (`reorderColumns` exists in the store, the table has no DnD) | M |
| 🔜 | 9. Undo/redo derived from the log — persistent across sessions, unlike today's closure stack | M |
| 🔜 | 10. History panel: list of ops, targeted revert, reset to raw | M |

### Lot C — Dataset-backed timeline

| St | Item | Effort |
|----|------|--------|
| 🔜 | 11. `dataset-select` field type + `renderDatasetField` host prop on `GenericConfigPanel`, mirroring the existing `renderConceptField` seam | S |
| 🔜 | 12. Dataset channel on `PatientComponentPluginProps` (it has none today, unlike the Lab's `ComponentPluginProps`) | S |
| 🔜 | 13. Column → `TimelineRow` mapping (`event_date`/`end_date`/`value`/`concept_name`), joined on `mapping.patientTable.idColumn` | M |
| 🤔 | 14. Explicit visit join column — `buildVisitFilter` assumes an event table's visit FK is named like the visit table's PK; a dataset has no reason to comply | S |
| 🤔 | 15. Server mode: is `queryDatasetRows` enough, or is a `render/timeline.py` needed? No timeline render exists today (client-only) | S then M |

### Lot D — Manual collection

| St | Item | Effort |
|----|------|--------|
| 🔜 | 16. Toolbar button in `PatientDataPage.tsx` beside Settings, gated on `canWrite` | S |
| 🔜 | 17. Collection sidebar: pick the dataset, map the three identity columns, add typed columns (reusing `TypeBadge` + the type menu from `DatasetTable`) | L |
| 🔜 | 18. Create a dataset pre-seeded with the **real** identity column names from the active `schemaMapping` (`patientTable.idColumn`, `visitTable.idColumn`, `visitDetailTable.idColumn`) | M |
| 🔜 | 19. "Recueil manuel" block at the bottom of `PatientDataSidebar.tsx`, after the demographics block: status, number of variables filled | M |
| 🔜 | 20. Entry writes **through the ops log** — which is what makes D depend on A, and what gives collection undo and provenance for free | M |

## 5. Open questions

- **Lot C/14** — the visit join. Either the dataset declares its join column explicitly in
  the widget config (simple, explicit, one more field) or we infer it by name and fall
  back. Leaning explicit.
- **Lot C/15** — a `render/timeline.py`. Only needed if a dataset-backed timeline must
  work server-side without shipping rows to the browser. `queryDatasetRows` may well be
  enough; decide when 13 is working.
- **Export** — the sidecar travels as a plain project file while `_tree.json` carries the
  merged columns. Confirm the ops log rides the export the way `parseOptions` does, and
  extend `DATASET_SIDECARS` in `packages/linkr-format/src/seed-manifest.ts`.
- **Volume ceiling** — no measurement yet of where replay cost becomes visible. Worth a
  benchmark on a realistic dataset once Lot A/4 lands.

## 6. Key files

Datasets: `apps/web/src/stores/dataset-store.ts` (the dead mutators),
`apps/web/src/features/projects/lab/datasets/DatasetTable.tsx`,
`apps/api/app/services/data/dataset_fs.py` (sidecar + `resolve_cache`),
`apps/api/app/services/data/dataset_rows.py` (DuckDB paging),
`apps/api/app/api/v1/routes/dataset_files.py` (`/columns/meta` is the route template),
`apps/web/src/lib/column-id.ts` + `apps/api/app/services/data/column_id.py` (parity twins),
`packages/linkr-format/src/rekey.ts` (reference repair).

Patient data: `apps/web/src/features/projects/warehouse/PatientDataPage.tsx` (toolbar),
`.../patient-data/PatientDataSidebar.tsx` (the demographics block ends the bottom pane),
`.../patient-data/PatientChartGrid.tsx` (prop dispatch),
`.../patient-data/PatientWidgetEditorSheet.tsx` (the `renderConceptField` host),
`apps/web/src/lib/plugins/patient-component-registry.ts` (the props contract),
`apps/web/src/features/projects/lab/datasets/analyses/GenericConfigPanel.tsx`,
`packages/default-plugins/patient-data/timeline/plugin.json`,
`apps/web/src/lib/duckdb/patient-data-queries.ts` (`buildTimelineQuery`, `buildVisitFilter`).
