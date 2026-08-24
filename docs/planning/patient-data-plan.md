# Patient data — dashboards, widgets, storage & plugin harmonisation

Bring the Patient data page onto the same footing as Dashboards: **several patient-data
dashboards per project** (as the Lab has several dashboards), persisted server-side,
carried by the project export, versionable in git, with the same edit-mode/widget
affordances, and patient-data plugins stored as files like lab ones.

Status legend as in [README.md](README.md): 🔜 ready · 🤔 needs a decision · 💤 later.

---

## 1. Where we stand

The page already has the right *shape* — and almost none of the plumbing.

**Already there.** `PatientChartTab` (`projectUid`, `displayOrder`, `LocalizedString`
name) and `PatientChartWidget` (`tabId`, `layout {x,y,w,h}`, `config`) with full CRUD
and dnd-kit reordering (`PatientChartTabBar`), a 48-col `react-grid-layout` grid
(`PatientChartGrid`), `editMode` as local page state gated on `patient-data:write`,
and — importantly — `GenericConfigPanel` **already shared** with dashboards and
analyses, driven by the plugin manifest's `configSchema`. A Python/R warehouse
plugin executor exists (`warehouse-plugin-executor.ts`), injecting `person_id` /
`visit_occurrence_id` / `visit_detail_id` and enabling the `sql_query()` bridge.

**Missing above the tabs.** Tabs hang straight off `projectUid`, so a project has
exactly **one** patient-data surface. The Lab lets a project hold several dashboards;
patient data has no equivalent container, hence no way to keep (say) a haemodynamics
board and a neuro board side by side. That container is the first thing Step 1 adds.

**The structural gap.** Everything persists to **`localStorage`** under a single
global key:

```ts
const STORAGE_KEY = 'linkr-patient-chart'   // stores/patient-chart-store.ts
```

Grepped both ends — `entity-io.ts`, `lib/storage/`, all of `apps/api/app/`: **zero
occurrences**. Patient-data tabs, widget layouts and configs are browser-local. They
are not exported, not imported, not persisted server-side, not versioned. They are
lost on a browser change, a localStorage clear, or a portal deployment. Every other
comparable entity (dashboards, cohorts) is a first-class persisted entity.

This is why storage comes first below: aligning the widget UI on data that does not
survive a machine change would be building on sand.

**The plugin asymmetry** — real, and already *documented as the target* elsewhere in
the repo, which is what makes it a bug rather than a design choice:

- `docs/conventions.md` mandates the path `packages/default-plugins/<scope>/<name>/`.
- `.claude/skills/create-plugin/SKILL.md` states "Warehouse plugins go in
  `packages/default-plugins/warehouse/`", with id `linkr-warehouse-<name>` and
  `needsConceptPicker`.
- `docs/vision-roadmap.md` §6 makes the file-based `plugin.json` model the right
  abstraction, hard-coded features becoming "core plugins".

But `packages/default-plugins/` holds only `analyses/`. **The documented convention
is unfollowable.** Note the folder to create is `patient-data/` (matching the feature,
as `analyses/` matches its own) — so those two documents, which both say `warehouse/`,
must be corrected in the same change or the written convention keeps pointing at a
folder that still will not exist.

The three built-in patient widgets live as inline TS manifests in
`lib/plugins/builtin-widget-plugins.ts` (`templates: null`), bound to widget types by
a hard-coded table:

```ts
export const SYSTEM_WIDGET_TYPE_MAP: Record<string, PatientWidgetType> = {
  'linkr-widget-patient-summary': 'patient_summary',
  'linkr-widget-timeline': 'timeline',
  'linkr-widget-notes': 'notes',
}
```

That map is the thing that makes a custom patient-data plugin impossible: a new plugin
has no `PatientWidgetType` to map to. The same skill records the consequence —
"patient-data widgets aren't seedable via a project ZIP".

**There are three plugin models, not two.** Besides script plugins (`.py/.R.template`)
and the inline-TS warehouse manifests, `runtime: ["component"]` plugins (e.g. `table1`)
are file-based manifests whose renderer is a React component registered lazily in
`component-registry.ts`.

**How far to harmonise — arbitrated: storage, not the props contract.** What must
converge is *where a plugin lives and how it is declared*: a folder with a
`plugin.json`, a `version`, a `configSchema`, discoverable and seedable like any other.
What must **not** converge is the component's input contract. `ComponentPluginProps` is
dataset-shaped by design:

```ts
export interface ComponentPluginProps {
  config: Record<string, unknown>
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  compact?: boolean
  datasetFileId?: string | null
  datasetFilters?: unknown[]
}
```

A patient widget wants `personId` / `visitOccurrenceId` / `visitDetailId` /
`dataSourceId` / `schemaMapping` and has no use for `columns`/`rows`. Folding both into
one interface would leave every lab plugin carrying OMOP fields it never reads, and
every patient widget carrying dataset fields that are always empty — a union that is
wrong for both sides. So: **a separate `PatientComponentPluginProps`**, with the two
kept apart at the type level and the registry holding both (its `loaderMap` is already
keyed by id; the value type becomes a discriminated union). Shared: the manifest
format, the file layout, `configSchema` + `GenericConfigPanel`, versioning, lazy
loading. Not shared: the props. See §5.

---

## 2. Reference architecture (Dashboards)

The five load-bearing decisions to mirror:

1. **Flat, id-linked entities** — `Dashboard` / `DashboardTab` / `DashboardWidget`,
   `LocalizedString` names, tabs nesting via `parentTabId`, binding on the leaf widget.
2. **One Zustand store, no `persist` middleware** — three flat arrays; every action is
   an optimistic `set()` then fire-and-forget
   `getStorage().x.y().catch(e => console.warn(...))`. The storage facade hides IDB vs
   API; the store never knows which. `createDashboard` is the one action that *awaits*,
   because the tab's FK would 404 if it raced the parent.
3. **`editMode` as local page state**, threaded down as a prop, gating grid
   drag/resize and the destructive half of the kebab menu.
4. **Plugin referenced by id string only**, resolved against a module-level registry
   `Map` at render time; `configSchema` drives a fully generic config panel, so no
   per-plugin UI is ever written.
5. **Export strips UUIDs in favour of derived content keys**, with a byte-parity
   Python twin and a golden fixture — this is what makes delete+reimport and git diffs
   stable.

---

## 3. Step 1 — Model & persistence (🔜, L)

Promote patient-data boards to project-scoped entities, on the dashboard pattern exactly.

**Types** move from the store file into `types/index.ts` next to the dashboard block:
`PatientDashboard` (the container — a *patient-data dashboard*, several per project),
`PatientDashboardTab`, `PatientDashboardWidget`.

The container is what buys several patient-data dashboards per project, exactly as the
Lab has several dashboards. It also gives dashboard-level settings a home
(`showWidgetTitles` is per-*project* today, which is why it cannot vary per board) and
mirrors `Dashboard` one-for-one, so the export/key machinery ports across instead of
being invented. A picker above the tab bar selects the active board.

- Storage interfaces `PatientDashboardStorage` / `PatientDashboardTabStorage` /
  `PatientDashboardWidgetStorage` in `lib/storage/index.ts`, added to the `Storage`
  facade.
- IDB: three object stores + a version bump, indexes `by-project` / `by-dashboard` /
  `by-tab`.
- API: `lib/api/patient-dashboards.ts`, wired into `api-storage.ts`.
- Server: SQLAlchemy models, Alembic migration, service + routes
  (`/patient-dashboards`, `/patient-dashboards/{id}/tabs`,
  `/patient-dashboards/tabs/{id}/widgets`), guarded by the existing
  `patient-data:read/write` permissions. **Server persistence is the point of this
  step** — it is what makes a board survive a browser or machine change.
- Store rewrite: `loadProjectPatientDashboards(projectUid)` with the `activeProjectUid
  && loaded` guard, optimistic write-through, and the same localized-name backfill.
  Mirror the one action dashboards deliberately `await`: creating the board before its
  first tab, or the tab's FK 404s in server mode.

**One-shot migration from `localStorage`.** On first load, if the key
`linkr-patient-chart` holds tabs for this project and the backend has none, import
them into a default board, then mark the key consumed (do not delete it until the
migration has shipped for a while — a stale-but-present key is recoverable, a deleted
one is not).

**Perf, while we are in there.** `PatientDataPage` does a bare
`usePatientChartStore()` destructure; `WidgetGrid` carries an explicit comment that
the same pattern cost ~1s of freeze on tab switch. Narrow to per-field selectors —
we already hit and fixed this exact class of bug on the Concepts page.

**Fix the seeded defaults.** `ensureDefaults` creates a timeline hard-coded to
`conceptIds: [3027018]` (a LOINC heart-rate concept absent from many databases). Seed
an empty timeline, or none at all.

---

## 4. Step 2 — Export, import, versioning (🔜, M)

ZIP layout, mirroring `dashboards/{slug}.json` — one file per board:

```
patient-dashboards/{slug}.json     — board + its tabs + widgets
```

Reuse the derived-key scheme verbatim: `boardKey = slugify(name)`, tab key
`` `${parentKey ?? boardKey}/${slug}` ``, widget key
`` `${tabKey}/${slug}@${layout.y},${layout.x}` ``, collisions suffixed. Strip
`id`/`projectUid`/`patientDashboardId`/`tabId`, keep `createdAt`/`createdBy`, sort by
key with `compareCodePoints` for byte stability. Import re-derives ids via `keyId(key)`
**namespaced by the local `projectUid`** — the dashboard comment records that using
the lineage instead collided on `UNIQUE` and surfaced as a 500.

Then, in the same change: the Python twin in `project_export.py`
(`_patient_dashboard_key`, `_build_tab_key_map`, `_build_widget_key_map`,
`_build_patient_dashboard_json`) + assembler entry, a `'patient-dashboards'` entry in
the selective-import entity-kind union, the deletion cascade, and a golden fixture under
`__fixtures__/export-golden/project/expected/patient-dashboards/`.

**Front/back parity is the risk here**, not the format: the two must emit the same
bytes or git shows phantom diffs. The golden test is the guard and is not optional.

⚠️ **Concept references.** Widget configs hold bare `conceptIds: number[]`, with no
link to the project's concept sets/lists. Exported as-is they are meaningless in an
instance mapped to a different vocabulary. Worth deciding (see §7) whether a widget
should reference a **concept list** instead — which is exactly what the concept-list
work just built.

---

## 5. Step 3 — Widget affordances (🔜, M)

Align on `WidgetCard`'s kebab, which already encodes the rule we want: structural and
destructive actions (rename / edit / configure / duplicate / move / delete) are
**edit-mode only**; only Export and accept-plugin-version remain outside it, and the
button is suppressed entirely when nothing applies.

Bring to patient widgets, in this order: **Configure** (already possible — the sheet
exists), **Duplicate**, **Move** (to another tab/board — needs a `MoveWidgetDialog`
equivalent, valid targets = leaf tabs), **Edit** name+description (patient widgets have
no description field today; adding one aligns them with the dashboard's
`DashboardItemEditDialog`, which is already shared between tabs and widgets), Delete
behind the same `AlertDialog`.

Reuse `WidgetCard` itself rather than cloning it — it already supports both `onRename`
(inline, used by patient widgets) and `onEdit` (dialog, used by dashboards), so the
component is *already* dual-purpose. Also port `plugin-drift.ts` (stamp
`pluginVersion` on the widget source, amber badge + "accept") once warehouse plugins
have real versions, which Step 4 provides.

---

## 6. Step 4 — Plugin harmonisation (🔜, M)

Goal: a patient-data plugin is a folder, like a lab plugin, and a custom one is
possible. **Scope: storage and declaration only** — the props contract stays separate
(see §1).

1. Create `packages/default-plugins/patient-data/`, sibling of `analyses/`. Fix the
   two documents that currently say `warehouse/` (`docs/conventions.md`,
   `.claude/skills/create-plugin/SKILL.md`) so the written convention matches.
2. Move the three inline manifests there as `plugin.json` (keeping ids and
   `configSchema` verbatim — the timeline's schema is non-trivial and already drives
   the shared config panel), `runtime: ["component"]`, each with a `componentId`.
3. Register the existing React widgets through `component-registry.ts` lazy loaders,
   as `plot-builder` does — same registry, same `React.lazy` memoisation, same
   `Suspense` plumbing.
4. **Keep the props contracts separate.** Add `PatientComponentPluginProps`
   (`config`, `compact`, `personId`, `visitOccurrenceId`, `visitDetailId`,
   `dataSourceId`, `schemaMapping`) alongside `ComponentPluginProps`; the registry's
   loader value type becomes a discriminated union keyed on scope, so a lab renderer
   can never be handed patient props or vice versa. No optional OMOP fields bolted onto
   the dataset contract.
5. **Delete `SYSTEM_WIDGET_TYPE_MAP`.** Widgets become `type: 'plugin'` +
   `pluginId`, resolved through the registry like dashboards. Keep a narrow read-time
   shim mapping the three legacy `PatientWidgetType` values to their plugin ids, so
   boards already persisted keep rendering. Per the standing preference, this stays a
   *simple tolerant read*, not a compat layer.
6. Update `docs/architecture.md` §Plugin System — it is stale independently of this
   work: it lists `ui.tsx` / `server.py` / `translations.json`, which no shipped plugin
   uses, and describes neither the component model nor the patient-data one.
7. Make patient-data plugins seedable via project ZIP, retiring the caveat in
   `create-plugin/SKILL.md`.

---

## 7. Step 5 — Concept selection (🤔, M)

`ConceptPickerDialog.tsx` is 929 lines and predates the recent concept-table work.
It already shares `GenericConfigPanel` and `useConcepts`, so the divergence is in the
table UI, not the data path — the same harmonisation just applied to the cohort
concept picker (`concept-cells.tsx`, shared renderers) applies here.

Open question, tied to §4: should a widget reference a **concept list** rather than
raw `conceptIds: number[]`? That would make exports portable across instances and
reuse the concept-list entity instead of duplicating ids per widget. It is the right
model, but it touches the just-shipped concept-list work — worth arbitrating before
building.

---

## 8. Order & rationale

| St | Step | Effort | Depends on |
|----|------|--------|-----------|
| ✅ | 1. Model + persistence (+ localStorage migration, perf, seed fix) | L | — |
| ✅ | 2. Export / import / versioning (+ Python twin + golden) | M | 1 |
| ✅ | 3. Widget affordances (kebab, duplicate, move, edit) | M | 1 |
| ✅ | 4. Plugin harmonisation (`default-plugins/patient-data/`) | M | 1 |
| ✅ | 5. Concept picker aligned on the shared cell renderers | M | 2, 4 |

**Shipped 2026-08-17**, needs manual testing (see §10). Remaining follow-ups:

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pull group for patient boards — a selective pull currently carries them through unfiltered instead of offering them as a group | S |
| 🤔 | Concept references: `conceptIds` kept as the portable key (see §7). Revisit only if a cross-instance export shows drift on local (2-billion) concepts | S |
| 💤 | `ConceptPickerDialog` is still ~950 lines with its own `useReactTable` (server-side paging, like the cohort picker); only the cell renderers are shared | M |

Storage is first because every later step persists something: the kebab's Duplicate
and Move write widgets, and file-based plugins change what a widget config holds.
Doing the UI first would mean redoing it once entities land.

Step 3 is the only one that could be pulled forward if visible progress matters more
than sequencing — it is additive UI over the existing store, low risk, and would be
re-pointed at the new store in Step 1 with modest rework.

---

## 9. Decisions taken

1. **Scope** — patient-data boards are *project* entities, like cohorts and dashboards:
   they travel with the project, in a single `patient-dashboards/` folder. (Arbitrated
   2026-08-17.)
2. **Concept references** — widgets keep `conceptIds`. For OMOP standard concepts the id
   is registry-wide rather than instance-local, and the concept-mapping side already
   derives ids deterministically from `(vocabularyId, conceptCode)` when a local concept
   needs one — the same denormalisation `ConceptListItem` uses to stay readable after the
   source database is detached.

## 10. Widget follow-ups (captured 2026-08-22, not arbitrated)

### 10.1 "Data overview" — expose an editable SQL (🤔, M)

The widget's queries are already fully `schemaMapping`-driven — the header of
`lib/duckdb/patient-overview-queries.ts:10-14` states it, and the inventory query
iterates `Object.entries(mapping.eventTables)` (l.56-64) rather than naming OMOP
tables. So the "must not hardcode OMOP" requirement is **already met**; what is
missing is that the generated SQL is invisible and not editable.

The other three patient widgets do surface it: `widget-sql.ts` switches on
`TIMELINE_PLUGIN_ID` / `NOTES_PLUGIN_ID` / `PATIENT_SUMMARY_PLUGIN_ID` (l.8-12) and
the overview plugin is simply absent from that switch.

Why it is harder than adding a fourth case: the widget runs **six** builders
(`buildOverviewInventoryQuery`, `…Density`, `…Events`, `…UnitStays`, `…StayWindow`,
`…Death`), not one, and the layout logic in `widgets/overview-layout.ts` consumes
their results in a specific shape. Categories, concept classes and concepts are
derived across several of them.

To arbitrate:

- **Read-only first.** Surface the six statements in the SQL tab, labelled, so a user
  can see and copy what runs. Cheap, and already most of the value.
- **Editable then.** An edited statement has to keep returning the columns the layout
  expects, so an override needs either a documented result contract per statement, or
  a "custom SQL replaces this section" escape hatch that degrades the section rather
  than the widget. The cohort builder's criteria/SQL toggle is the precedent: switching
  to SQL is a one-way door out of the structured editor, which is honest.

Do read-only unless the editable case has a concrete demand behind it.

### 10.2 Timeline — points and bars, not only continuous signal (🤔, M)

The timeline renders with **dygraphs** (`TimelineWidget.tsx:3-4`), which is the right
choice for the signal case: it is fast on dense time series, and the zoom/pan sync
across widgets is already built on it (`patient-data/timeline-sync.ts`).

But Data overview shows three mark types — continuous signal, discrete points, and
bars/intervals — and the timeline only does the first. Users want the same three here.

Options, to evaluate:

- **Stay on dygraphs.** It supports `drawPoints` / `strokeWidth: 0` for point series
  and per-series styling; interval bars are the awkward case (custom plotters, or
  underlays drawn on the canvas). Keeps one library, keeps the sync, keeps the perf.
- **Two libraries, chosen per series type.** A second renderer for point/bar series
  layered over the same time axis. Buys expressiveness, but the axis and the
  zoom/pan sync now have to be kept coherent across two canvases — that is the real
  cost, not the bundle size.
- **Reuse whatever Data overview already draws** for its point/bar marks
  (`PatientOverviewWidget.tsx`) rather than introducing a third rendering path.

The last one is worth checking first: if the overview's mark rendering is already
generic enough, the timeline gains two mark types without a new dependency.

Whatever is chosen, the config schema gains a per-series `markType`
(`line | points | bars`), which is a `configSchema` change on
`packages/default-plugins/patient-data/timeline/plugin.json` and therefore a
`version` bump + plugin-drift badge for existing widgets.

| St | Item | Effort |
|----|------|--------|
| 🤔 | 10.1 Data overview: read-only SQL tab (six labelled statements); editable only on demand | M |
| 🤔 | 10.2 Timeline: evaluate dygraphs-only vs a second renderer vs reusing the overview marks | S (spike) |
| 🔜 | 10.2 then: per-series `markType` in the timeline `configSchema` + version bump | M |

---

## 11. Manual testing

Not covered by the automated suites, worth checking once against real data:

- A project holding tabs in the old `localStorage` store: opening the page should import
  them into a first board (the legacy key is kept, not deleted).
- Server mode: create a board, add widgets, reload — everything should come back.
- Export a project with a board, re-import it, export again: the two ZIPs' JSON should be
  identical (that is what the derived keys buy).
- The widget kebab in edit mode: configure, duplicate, move, edit name/description, delete.
