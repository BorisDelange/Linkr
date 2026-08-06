# Reports — plan

Rich reports in the Lab: a **BlockNote** document that mixes prose with live Linkr widgets,
presentable as slides and exportable to md / HTML / DOCX / ODT / PDF / PPTX.

Route + permission + sidebar entry already exist (`lab/reports`, `ReportsPage.tsx` is a
"coming soon" stub).

## Arbitrated decisions (2026-08-05)

| Question | Decision |
|----------|----------|
| Editor engine | **BlockNote + XL exporters** (not a home-grown block model) |
| Formats | **One single document.** No `document` vs `deck` duality — slides are a *view* |
| Slide split | Content-derived: each `divider` (`---`) block cuts a slide |
| PPTX | **Option (b)**: one slide per divider, auto vertical layout, real editable text boxes |
| Filters | **Per widget**, frozen by the author. No shared runtime filter state |
| Tabs | **None** — structure comes from the content; the report list plays that role |
| Reimport | **Yes** — "import from a dashboard" copies `source` + dataset + freezes active filters |
| ODP / Keynote | Dropped. Keynote and LibreOffice both import PPTX correctly |

## Why BlockNote (and the prior art it comes from)

[suitenumerique/docs](https://github.com/suitenumerique/docs) (DINUM / ZenDiS) is the
reference implementation we studied. Three things we take from it:

1. **Presentation mode is an overlay, not a format.** `doc-presenter/useSlides.ts` splits the
   *same* block list on `divider` blocks; `useFitScale.ts` renders at a fixed design width
   (900 px) then `transform: scale(min(scaleW, scaleH))` clamped to `[0.7, 1.5]` — below the
   floor the slide scrolls instead of shrinking. No 16:9 canvas, no second data model.
2. **ODT / DOCX / PDF export runs fully client-side** through `@blocknote/xl-*-exporter`,
   with per-block-type mappings for custom blocks. This is what kills the need for a
   server-side pandoc endpoint (`pandoc-wasm` is 58 MB unpacked — unusable in the
   client-only WASM build).
3. **Custom blocks are React components** via `createReactBlockSpec` — which is exactly how a
   Linkr widget becomes a first-class citizen of the document flow.

### Licensing — the decisive constraint

| Package | License | Unpacked |
|---------|---------|----------|
| `@blocknote/core`, `/react`, `/shadcn` | MPL-2.0 | ~29 MB |
| `@blocknote/xl-docx-exporter` | **GPL-3.0 OR PROPRIETARY** | 3.4 MB |
| `@blocknote/xl-odt-exporter` | **GPL-3.0 OR PROPRIETARY** | 3.3 MB |
| `@blocknote/xl-pdf-exporter` | **GPL-3.0 OR PROPRIETARY** | 8.3 MB |
| `pptxgenjs` | MIT | 2.6 MB |

The `xl-*` packages are dual-licensed: free under copyleft, paid for proprietary use.
**Linkr is GPL-3.0**, so they are usable with no commercial license. This consciously
**locks these modules to GPL** — acceptable since that is already the project license, but
it must not be forgotten if the license is ever revisited.

Also: porting `useSlides` / `useFitScale` logic from Docs is GPL→GPL, and requires
attribution in the file header.

## Data model

One report = one JSON document. **No block table** — this is the main simplification over
the dashboard model (no tabs, no `filterConfig`, no runtime filter state).

```ts
export interface Report extends Seedable, Authored {
  id: string
  projectUid: string
  name: LocalizedString
  description?: LocalizedString
  /** Serialized BlockNote document (Block[]). The slide structure is derived from it. */
  content: unknown
  /** User-facing semver (default '0.1.0'), like Dashboard. */
  version?: string
  createdAt: string
  updatedAt: string
}
```

A widget is a custom block, so widget state lives in the document:

```ts
const widgetBlock = createReactBlockSpec({
  type: 'linkrWidget',
  propSchema: {
    source: { default: '' },          // DashboardWidgetSource, JSON-serialized
    datasetFileId: { default: '' },
    filters: { default: '' },         // Record<columnId, FilterValue>, FROZEN by the author
    frozenBlobId: { default: '' },    // captured figure; empty = live
    frozenAt: { default: '' },
    frozenFormat: { default: '' },    // 'png' | 'svg'
    height: { default: 360 },
  },
  content: 'none',
}, { render: ({ block }) => <ReportWidgetBlock block={block} /> })
```

`ReportWidgetBlock` wraps the **existing** `DashboardDataProvider` + `PluginWidgetRenderer` /
`InlineCodeWidgetRenderer`. Plugins, drift detection and `remapWidgetColumns` are reused
unchanged — `DashboardWidgetSource` is deliberately the same type.

BlockNote props are flat scalars only, hence the JSON-in-string for `source` / `filters`.
Parsing must be tolerant (see the "no complex backcompat" rule): a malformed prop renders an
error placeholder, never crashes the document.

## Filters — per widget

Frozen author-side choices, not reader-side interactivity. That is what distinguishes a
report from a dashboard, and it makes the model *simpler*: no `DashboardFilter[]`, no
`scope`, no cross-dataset propagation, no `activeFilters` store.

- Stored as `Record<columnId, FilterValue>` in the block's own props.
- Edited through a popover on the block, reusing the input controls extracted from
  `DashboardFilterSidebar.tsx` (which is 63 KB today — extraction is a prerequisite, not a
  rewrite).
- Applied by the existing `applyFilters()` from `DashboardDataProvider.tsx` (unchanged).
- A badge on the block summarizes them via the existing `buildFilterChips()`.

`resolveBlockFilters` (parse + validate against the dataset's columns) is pure logic →
**unit tests required** (CLAUDE.md rule).

## Freezing figures

Two explicit levels, surfaced in the UI:

1. **Live** (default) — the block re-runs its code on open with its frozen filters. What you
   want while writing.
2. **Frozen** — capture to SVG (preferred: crisp vector, `serializeInlineSvg` already handles
   recharts) or PNG at high DPI when the widget is a Leaflet map / HTML table. The block then
   renders the stored image and never executes code again. Badge "frozen on <date>" +
   Refresh button. A "Freeze whole report" action finalizes everything before export.

Reuses `figure-export.ts` (`nodeToBlob`, `findWidgetNode`, DPI → pixelRatio) and
`OffscreenWidgetCapture.tsx` (mounts widgets off-viewport so charts paint before capture).
Blobs go to the existing blob store / attachment service.

Rationale: a thesis figure or a regulatory deliverable must be reproducible and immutable —
if the dataset moves, an already-rendered PDF must not. It also makes read mode instant
(no Pyodide/webR boot).

## Presentation mode

Port of the Docs approach, adapted:

- `splitBlocksIntoSlides(blocks)` — cut on `divider`. Drop empty paragraphs adjacent to a
  divider (habitual spacing shouldn't offset slides); keep a divider that has children as the
  structural parent of the next slide; never return an empty array.
- `computeFitScale(naturalHeight, frameW, frameH)` — pure, unit-testable, no DOM.
- Window of 3 mounted slides (prev / current / next), keyboard shortcuts, browser fullscreen,
  short cross-fade.
- The slide renderer mounts `BlockNoteView` with `editable={false}`, toolbars hidden via CSS,
  and strips `role="textbox"` / `contenteditable` from the ProseMirror node (accessibility:
  this is presentation, not a form field).

Both pure functions get unit tests. Shortcut handling follows the project's keyboard rules
(`event.key`, no Alt — see the keyboard-shortcuts memory).

## Exports

All client-side, all lazy-loaded.

| Format | How | Notes |
|--------|-----|-------|
| Markdown | `blocksToMarkdownLossy` + widget → `![](figures/x.png)` | lossy by design |
| HTML | BlockNote HTML + figures inlined as data-URI | best archival format |
| DOCX | `@blocknote/xl-docx-exporter` + custom widget mapping | |
| ODT | `@blocknote/xl-odt-exporter` + custom widget mapping | |
| PDF | `@blocknote/xl-pdf-exporter` (`@react-pdf/renderer`) | vector text |
| PPTX | **own mapping** `Block[]` → `pptxgenjs` | one slide per divider |

Each format needs a **`linkrWidget` mapping** — exactly how Docs maps its `callout` / `image`
/ `pdf` blocks. The widget resolves to its frozen blob, or is captured on the fly if live.
SVG → PNG conversion where a format handles SVG poorly (Docs uses Canvg for this; we already
have `nodeToBlob`, so prefer reusing ours).

PPTX mapping (~300 lines): group blocks per slide, then within a slide stack vertically —
heading → title placeholder, paragraphs/lists → real text boxes (editable in
PowerPoint/Keynote), widgets → PNG images. Auto-layout, no free-form positioning. That
trade-off is the whole point of decision (b).

## Integration costs (known frictions)

- **Bundle weight** — ~45 MB unpacked across BlockNote + 3 exporters + pptxgenjs. Mandatory
  mitigation: **dynamic `import()`** for the Reports page and for each exporter, so the
  initial bundle is untouched. Same pattern the app already uses for Pyodide/webR. Impact on
  the static WASM build (linkr-portal) must be measured.
- **shadcn variant exists** — use `@blocknote/shadcn` (MPL-2.0, 0.5 MB), not the Mantine
  build, and pass our own components via `shadCNComponents`. Two caveats:
  - **Our components must not use Portals** in the ones passed to BlockNote (DropdownMenu,
    Popover, Select). Needs verification against `components/ui/`.
  - **`form` and `toggle` are missing** from `components/ui/` — add them per the shadcn-first
    rule (copy from `../shadcn-ui/`, adapt colors to `var(--color-*)`).
  - Tailwind v4 needs `@source "../node_modules/@blocknote/shadcn"` in `index.css`.
- **i18n** — BlockNote ships `@blocknote/core/locales` (en + fr both present). Merge with our
  `dictionary` following the Docs pattern, guarding on `i18n.resolvedLanguage in locales`.
  Our own strings stay in `locales/en.json` + `fr.json`.

## Steps

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Model + persistence: `Report` type, `report-store.ts`, SQLAlchemy model + Alembic + `report_service.py` + routes, project-export/versioning wiring | M |
| 🔜 | 2. BlockNote editor: `@blocknote/shadcn` integration, dynamic import, i18n dictionary, debounced save, read mode, missing `form`/`toggle` components, Portal audit | M |
| 🔜 | 3. `linkrWidget` custom block: `createReactBlockSpec` + existing renderers, slash-menu insert, "import from a dashboard" | M |
| 🔜 | 4. Per-widget filters: extract `DashboardFilterSidebar` controls, block popover, badge, `resolveBlockFilters` + tests | M |
| 🔜 | 5. Freeze figures: reuse `figure-export` + `OffscreenWidgetCapture`, blob storage, badge + refresh, "freeze all" | M |
| 🔜 | 6. Presentation mode: port `splitBlocksIntoSlides` + `computeFitScale` (+ tests, GPL attribution), overlay, shortcuts, fullscreen | M |
| 🔜 | 7. Exports: md/HTML, then DOCX/ODT/PDF via XL + widget mappings, then PPTX via `pptxgenjs` | L |

Steps 1–5 already ship a usable product (rich report with filtered, frozen widgets).
6 and 7 are independent of each other.

## Open points

- Measure the real lazy-loaded bundle cost on the static WASM build before committing step 7.
- Confirm no Portal usage in the `components/ui/` components handed to `shadCNComponents`.
- Whether the report list page reuses `LabDashboardsPage`'s card layout (likely yes).
