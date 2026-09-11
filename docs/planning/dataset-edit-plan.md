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
| ✅ | 1. Stable row key `__row_ord` (raw ordinal, materialised in the Parquet cache; added rows take negative ordinals) | M |
| ✅ | 2. Op types + inverses in `packages/linkr-format` and its Python twin: `setCell`, `addRow`, `removeRow`, `reorderRows`, `addColumn`, `removeColumn`, `reorderColumns`, `renameColumn` | M |
| ✅ | 3. Persistence: `ops` section of the sidecar + `POST /dataset-files/ops` in **append** semantics (`replace` for compaction / reset-to-raw), modelled on `/columns/meta` | M |
| ✅ | 4. Replay engine, TS + Python, under a shared parity fixture — replay cases plus the canonical wire form and its digest | L |
| ✅ | 5. Compaction + cache invalidation on the ops digest (`resolve_cache` now keys on raw sig **and** `opsSig`) | S |
| ✅ | 6. Rename repairs downstream references (live-state twin of `rekey.ts`), refusing a slug collision | M |
| ✅ | 7. Client store + API adapter: WASM replays in the browser, server mode posts ops | M |
| ✅ | 8. Export: the journal travels as `datasets/<dataset>/<name>.edits.json`, from both builders, written and gitignored on the same mark as the data file. (Was inline in `datasets/_tree.json` — that leaked typed patient values whenever the CSV itself was left unversioned, since one tree covers every dataset and cannot be excluded per-dataset.) | S |

Built 2026-09-06/07 (commits `f43f89bb`, `cde0f88a`): 61 tests across both languages,
plus 12 end-to-end persistence tests. Two invariants are pinned byte-for-byte — the
raw file is never written to (CSV **and** Parquet), and an *edited* `.parquet` stops
aliasing its own raw, since replay would otherwise have to write the raw file.

### Lot B — Editing in the Datasets page

| St | Item | Effort |
|----|------|--------|
| ✅ | 7. Cell selection + in-place editing in `DatasetTable` (click, double-click, arrows/Tab/Enter, Delete, type-to-edit) | L |
| ✅ | 8. Add/remove rows and columns from a footer toolbar | M |
| ✅ | 9. Undo derived from the log, by op GROUP so one user action reverses as a whole | M |
| ✅ | 10. History dialog: every op, human-readable, with compaction and reset-to-raw | M |
| 🔜 | Column drag-reorder in the header (the `reorderColumns` op exists; the table has no DnD yet) | S |

Editing is opt-in per dataset and gated on `datasets:write`. Building it surfaced a
real defect in Lot A: `write_parquet` projects only the declared columns, so the row
key was dropped from the cache and server-mode editing could not have worked. The
cache now carries it — only for a dataset that has a log, and never as a column the
UI, stats or exports can see.

**Undo truncates the log; it does not append an inverse.** The first design computed
each op's inverse and appended it. That was wrong twice over. Practically, the log
grew with every undo, "undo of an undo" showed up as history, and undoing was
endless — the log became a record of the user's hesitation rather than of the
dataset's content. Fundamentally, an inverse is computed against the state its op
saw, and neither mode holds anything but the ALREADY-replayed rows: the first
overwrite of a raw cell destroys the only copy of the original, so the inverse of
`setCell 'new'` came out as `setCell 'new'` — an undo that ran, recorded an op, and
changed nothing.

Dropping the last group and re-deriving is both simpler and strictly more capable:
`raw → parse → replay(ops)` with an immutable raw means a shorter log *is* the
earlier state, so nothing has to be reconstructed and nothing can be unrecoverable —
including a removed column's data, which no inverse could have restored. Server mode
gets this for free (the route already supports a replace, and `resolve_cache`
re-derives from the raw).

Front-only has one constraint left: it holds no raw, so the baseline is reconstructed
by rewinding the log, and that is exact **only while the log is empty**. `recordOps`
therefore captures it before the first op is added. Reopening a file that already
carries a log in a fresh front-only session cannot recover a raw cell's original
value; `unreplay` then leaves the cell as it stands rather than blanking it, which is
what the "baseline derived late" test pins.

**Export/import carries the log, and the validator had to be taught its own
vocabulary.** Two round-trip defects, both found by exporting a project and
re-importing it. The format validator's allowed column types omitted `unknown` — a
type the parser assigns to a column it cannot type and the one an added column
starts as — so a project reported errors on its own export. And the server-mode
import uploaded the raw file but never replayed the ops, silently returning an
edited dataset to its unedited state; the log is now replayed after upload, with
column ids remapped through the same bridge widget configs use.

**Entry constraints belong to the column, and stay advisory.** `required`,
`allowedValues`, `min`/`max` and `withTime` are declared on `DatasetColumn` and shape
DATA ENTRY only: a violation is shown beside the field and never blocks the write,
and import validation ignores them entirely. A constraint authored today cannot make
yesterday's data invalid, and a value out of range is usually a typo but occasionally
the real measurement — refusing it would leave the collector no way to record what
happened. `withTime` rides on the `date` type rather than adding a fifth type,
because the app already distinguishes the two by sniffing values; only an empty
collection column has nothing to sniff, so the distinction has to be declared there.

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
| ✅ | 16. Toolbar button in `PatientDataPage`, beside Settings | S |
| ✅ | 17. Collection sheet: fields typed from the dataset's own columns, written on blur | L |
| ✅ | 18. Create a dataset pre-seeded with the identity columns **named as the active database names them** (`subject_id`/`hadm_id` on MIMIC, not a generic `person_id`) | M |
| ✅ | 19. Collection status block at the foot of the patient sidebar: status + variables filled | M |
| ✅ | 20. Entry writes through the ops log, so collection inherits undo and provenance | M |
| ✅ | 21. The setup itself persists: `patient_dashboards.collection` (JSONB, migration `d2e3f4a5b6c7`) | S |
| ✅ | 22. Column label/description are multilingual (`LocalizedString`), front + validator + sidecar | M |
| ✅ | 23. Categories: variables grouped into collapsible sections, with expand/collapse all | M |
| 🔜 | Per-variable column picker (today every non-identity column is offered; `variableColumns` is modelled but has no UI) | S |

One row per (patient, visit, stay) as the config declares: filling a field for a
patient who already has a row updates it rather than appending a second — a
collection is a form, not a journal. The first value entered creates the row and
its identity cells in ONE op group, so an undo removes the whole row rather than
blanking a cell in a row that should never have existed.

**The setup is board state, not client state.** It lived only in the store at first,
so a refresh lost it. It is board-level rather than project-level because two boards
of the same project can collect into different datasets. Adding a field to the config
means touching all four of: the SQLAlchemy model, the three Pydantic schemas, a
migration, and `PatientCollectionConfig` on the front — `patient_dashboard_service.update`
copies fields generically, so it needs no change.

**Categories are headings, not columns.** A category groups variables in the panel
and reaches neither the dataset nor the ops log, so deleting one leaves every
variable it held intact and merely ungrouped — re-organising a form can never cost
data. `groupVariables` therefore tolerates a `categoryId` naming a category that is
gone, rendering it ungrouped rather than hiding it behind a heading nothing draws.
Ungrouped variables render FIRST, so adding a form's first category does not push
what it already held below a heading those variables were never filed under.

**Three names, two of them typed.** A variable's *name* is its column name in the CSV,
its *label* is what a collector reads, and its *id* is derived from the name
(`col_<slug>`) and only ever displayed. This is the same split the Datasets page uses;
offering the id as an input asked the same question twice.

## 5. What to test in the app

Everything below is covered by automated tests except where the app itself is the only
check — a running UI, and the two modes behaving alike.

**Editing (Datasets page).** Open a dataset → *Edit data*. Click a cell, type, Enter.
Arrows/Tab move, Delete clears, Escape leaves. Add a row and a column, undo them. Open the
history: each entry should read as a sentence. *Compact* should leave the table identical
while shortening the list; *Discard all changes* should return the raw file exactly.

**The invariant worth checking by hand:** the file on disk under
`projects/<uid>/datasets/` must be byte-identical before and after all of it. Everything
you changed lives in `projects/<uid>/dataset-meta/<hash>.json`.

**Both modes.** The same dataset edited in server mode and in a client-only build must end
up identical — that is what the parity fixture asserts in the small, and what the app
confirms in the large.

**Export round-trip.** Export the project, re-import it, and confirm the edits are still
there and the diff is stable on a second export.

**Timeline.** Add a Timeline widget, pick concepts, then a dataset with its patient and
date columns; both should appear on one axis. Then a dataset-only timeline, with no
concepts at all. A dataset with an end-date column draws blocks.

**Collection.** *Collection* in the Patient data toolbar → set it up, creating a dataset
from the dialog: check the identity columns are named as your database names them
(`subject_id`/`hadm_id` on MIMIC). Fill a field; the row should appear in the Datasets
page. Switch patient and back; the value should still be there. The sidebar's status block
should track what is filled.

**The join worth verifying on real data:** the collection's `person_id` values must match
the ids Patient data selects by, or the sidebar will look empty while the dataset has rows.

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
