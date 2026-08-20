# UI Patterns

How composed UI is built in this app: which shared component to reach for, and
the exact styling each pattern uses. **Read this before writing any screen.**

Scope split with the two neighbouring docs:

| Doc | Answers |
|---|---|
| `docs/shadcn-components.md` | *Which shadcn primitives exist / are installed?* (upstream catalogue) |
| **this file** | *Which of OUR composed components do I reuse, and how does it look?* |
| `docs/conventions.md` | Code style: naming, imports, hooks, errors, tests |

> The recurring failure this file exists to prevent: building a new modal, table
> or page header from scratch when a richer shared one already exists — and
> sizing its text by eye, so two screens with the same function don't match.

**Before building any UI, in order:**
1. Does a composed component here already do it? → use it.
2. Does a shadcn primitive in `components/ui/` do it? → use it.
3. Only then build — and if it's reusable, put it in `components/ui/` and add it here.

---

## 1. The type scale

Nine text sizes are in use today (`text-[10px]` 635×, `text-[11px]` 226×,
`text-xs` 1736×, `text-sm` 407×, plus `base`/`lg`/`xl`/`2xl`/`3xl`). That is the
single biggest source of "same function, different size". **Only these four are
allowed in new code:**

| Class | Use for | Never for |
|---|---|---|
| `text-2xl font-bold` | Page title (one per screen) | Anything inside a card or dialog |
| `text-base font-semibold` | Dialog / sheet titles — set by the primitive, don't type it | Body copy |
| `text-sm` | Body copy, card titles, list rows | Dense table cells |
| `text-xs` | Dense contexts: table cells + headers, form labels, buttons, badges, dialog descriptions | Page-level prose |
| `text-[10px]` | Micro-chrome only: inline column filters, result counters, pagination | Anything a user reads as content |

`text-[11px]` is **deprecated** — it exists in ~226 places and is visually
indistinguishable from `text-xs` (12px). Use `text-xs`. `text-lg`, `text-xl` and
`text-3xl` are not part of the scale (11 stray uses total); `text-base` is
reserved for dialog titles and comes from the primitive, so you never type it.

### The primitives now carry the scale

The drift was mechanical, not a discipline problem: several primitives shipped a
default the app rejected, so every call site fixed it by hand. Those defaults
have been recalibrated to the value the codebase had already voted for:

| Primitive | Was | Now | Evidence |
|---|---|---|---|
| `Label` | `text-sm` | `text-xs font-medium` | 143 of 147 styled labels shrank it; `Input` is `text-[13px]` with **zero** overrides |
| `Badge` | `text-xs` | `text-[10px]` (+ `size="xs"` → 9px) | 78 of 146 uses overrode it |
| `DialogTitle` / `AlertDialogTitle` / `SheetTitle` | `text-lg` | `text-base` | 24 call sites had forced `text-sm`, but those were mostly workbench dialogs; `text-base` keeps a form title above its body |
| `DialogDescription` / `SheetDescription` | `text-sm` | `text-xs` | matches the dense body |
| `Button` | — | added `sm-tight` (h-7) | 36 buttons hand-rolled `className="h-7"` |

**Consequence: write `<Label>`, `<Badge>`, `<DialogTitle>` with no size class.**
Adding one now means deliberately departing from the scale.

Because `cn()` runs `twMerge`, a leftover override still wins over the new
default — which is why recalibrating was safe, and why the redundant ones are
being removed rather than left to rot.

**Colours** — use theme tokens (`text-muted-foreground`, `text-primary`,
`text-destructive`, `bg-accent`). Raw palette classes (`text-green-600`,
`text-blue-500`…) are used 799× today and several break dark mode. Do not add
more; semantic domain colours (teal = warehouse, rose = lab) are the exception.

---

## 2. Data tables

### The canonical component

**`components/ui/concept-data-table.tsx` → `ConceptDataTable<T>`.** Use it for
every tabular list. It is declarative — you pass columns, not JSX:

```tsx
import { ConceptDataTable, type ConceptColumn } from '@/components/ui/concept-data-table'

const columns: ConceptColumn<Row>[] = [
  { id: 'name',   header: t('common.name'),  accessor: (r) => r.name, filter: 'text' },
  { id: 'domain', header: t('concepts.domain'), accessor: (r) => r.domain, filter: 'select' },
  { id: 'count',  header: t('common.count'), accessor: (r) => r.count, filter: 'number' },
]

<ConceptDataTable
  data={rows}
  columns={columns}
  rowKey={(r) => r.id}
  pageSize={100}                                  // omit to render every row
  initialSorting={{ columnId: 'count', desc: true }}
  emptyMessage={t('common.no_results')}
/>
```

It already gives you: **per-column sort** (tri-state desc → asc → off),
**column resize** (drag, double-click to reset), **inline filters** under each
header (text / number / multi-select), **column visibility** menu, **client
pagination**, and **truncation tooltips**. Pass `reorderable` to let users drag
columns into a different order — off by default, since the drag grip is noise on
a three-column table. `ConceptColumn` also supports `cell` (custom renderer),
`sortable`, `hidden`, `center`, `size`/`minSize`, `selectOptionLabel` and
`tooltip`.

**Do not hand-roll a `useReactTable`** to get sorting or resizing. 14 files do
today; the resize handle alone is copy-pasted verbatim in 11 of them.

Multi-selection is opt-in too — pass `selectedRowKeys` + `onSelectedRowKeysChange`
for file-explorer behaviour (plain click replaces, Ctrl/Cmd toggles, Shift
extends from the anchor). Ranges follow the *filtered, sorted* order, so a
Shift-click selects what the user sees. The maths is `nextSelection()`, unit
tested in `concept-data-table.test.ts`.

### When a bespoke table is still legitimate

`ConceptDataTable` does not (yet) cover: column pinning, server-side pagination,
sticky headers, virtualisation. If you need one of those, the rule is **extend
the shared component**, not fork it — reorder and multi-selection both moved in
that way.

**Known debt (do not extend, help retire):** roughly ten files still hand-roll a
table with `useReactTable`, most of them in `features/warehouse/concept-mapping/`.
`ConceptTable.tsx` carries its own copies of reorder, multi-selection and the
visibility menu that now all live in the shared component.
`ConceptPickerDialog` / `CohortConceptPickerDialog` and `PullConceptsDialog` /
`PullMappingsTable` are near-duplicate pairs — migrate one and the other follows.

### Table styling — exact classes

Copy these; they are what `ConceptDataTable` renders.

| Part | Class |
|---|---|
| Header cell | `relative select-none overflow-hidden text-xs` |
| Body cell | `overflow-hidden truncate px-2 py-1 text-xs` |
| Inline filter input | `h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px]` |
| Empty state row | `h-16 text-center text-xs text-muted-foreground` |
| Footer bar | `border-t px-3 py-1.5`, counter `text-[10px]` |
| Sticky header (when needed) | `sticky top-0 z-10 bg-muted` |

Two traps seen in the wild: omitting `px-2 py-1` on the cell silently inherits
`TableCell`'s `p-2` and makes rows visibly taller; and `Table` defaults to
`text-sm`, so a dense table must set `text-xs` on cells.

### Supporting components

| Component | Use for |
|---|---|
| `MultiSelectFilter` | Any multi-value filter. Caps rendering at 200 options; Enter selects all matches. |
| `ColumnVisibilityMenu` | Column toggling with search + select all/none. `ConceptDataTable` uses it, so you only reach for it directly in a bespoke table. |
| `TruncatedText` / `TruncatedHeader` | Text that may overflow. Shows a tooltip *only* when actually truncated. Needs a width-bounded parent. |
| `DebouncedInput` | Any search box over a large set (300 ms). |

---

## 3. Dialogs

### Use `DialogShell`, not raw Dialog parts

**`components/ui/dialog-shell.tsx`** is the entry point for every dialog. Pick a
`kind`; it decides width, header typography, body spacing and footer button
order, so two dialogs of the same purpose are identical *by construction*:

```tsx
<DialogShell
  open={open}
  onOpenChange={onOpenChange}
  title={t('etl.create_title')}
  description={t('etl.create_description')}
  onConfirm={handleSubmit}
  confirmLabel={t('common.create')}
  confirmDisabled={!name.trim()}
  busy={saving}
>
  …fields…
</DialogShell>
```

| `kind` | Width | For |
|---|---|---|
| `form` (default) | `sm:max-w-md` | create / add / edit / rename — one column of fields |
| `settings` | `sm:max-w-lg` | configuration, usually tabbed |
| `workbench` | `h-[85vh] sm:max-w-5xl` | pickers, diffs, viewers — body scrolls, header/footer pinned |

Other props: `destructive` (red primary), `footerExtra` (tertiary action),
`hideFooter` (viewers), `cancelLabel`, and `className`/`contentClassName` as
escape hatches. Omit `onConfirm` and the footer becomes a single Close button.

Assemble `Dialog` + `DialogContent` + `DialogHeader` + `DialogFooter` by hand
only when a dialog genuinely doesn't fit the three kinds — and say why in a
comment. Never invent a pixel width (`max-w-[1400px]`), and never write bare
`max-w-md` without the `sm:` prefix.

### Reference implementations

`CreateEtlDialog` (form), `DashboardSettingsDialog` (settings/tabs).
`conventions.md` used to cite `CreateMappingProjectDialog` as a co-reference,
but it disagreed with the other on label sizing — that's the contradiction that
sent ~35 files off-pattern. It's now a reference for *multi-page dialog flow only*.

### Remaining rules

- **Never put a size class on `DialogTitle`/`DialogDescription`/`SheetTitle`** —
  the primitives now carry the right size. `sr-only` is still fine.
- **Hints are `text-xs text-muted-foreground`** (no `mt-1.5`, no `/60` opacity
  variants — those were 15 spellings of one rule).
- **Footer buttons take `size="sm"`**, cancel `variant="outline"` first, confirm
  second. `DialogShell` does this for you. Never `size="default"` explicitly,
  never a text-size class on a footer button.
- **Tabs fill the width**: `TabsList className="w-full"` +
  `TabsTrigger className="flex-1"`. Never add `text-xs` to a trigger.
  The one sanctioned alternative is `variant="line"` for *detail* panels
  (`entity-docs-dialog`, the detail sheets) — consistent among themselves.
- **Destructive actions go through an `AlertDialog`.** This one is well held
  (63 uses, consistent styling) — keep it that way.

### Shared dialogs — check call sites before restyling

`ImportConflictDialog` (10 call sites), `ImportSourceDialog` (5),
`EntityDocsDialog` (4), `ImportErrorDialog` (3), `EntityVersioningDialog` (2).
Editing one changes every caller. If only the wording differs, take a mode prop
and switch i18n keys (see `ImportConceptSetDialog`'s `dictionaryMode`) rather
than touching styling.

`components/ui/export-dialog.tsx` has **zero call sites** — likely superseded by
`EntityExportContent`. Don't build on it without checking.

---

## 4. Page shells

### List pages: use `ListPageTemplate`

**`features/warehouse/ListPageTemplate.tsx`** already composes the whole list
screen — page header, `ListPageToolbar`, cards with `EntityActionsMenu` +
`CardMetaFooter` + `BadgeStrip`, and the empty state. 7 pages use it. If you're
building an entity list, start here, not from a blank page.

### Page header

Use **`PageHeader`** + **`PageContainer`** (`components/ui/page-header.tsx`):

```tsx
<PageContainer>            {/* width="4xl" default; 3xl / 5xl available */}
  <PageHeader
    title={t('...')}
    description={t('...')}
    actions={<Button size="sm">…</Button>}
  />
  …
</PageContainer>
```

Don't hand-roll `<h1 className="text-2xl font-bold">` — 20 pages did, which is
why the title drifted. `ListPageTemplate` already consumes both.

Two known gaps: `text-2xl` doubles as *page title* (27×) **and** *KPI number*
(14×), so a metric looks like a heading; and 4 detail pages
(`EtlPipelinePage`, `MappingProjectPage`, `DqRuleSetDetailPage`,
`SqlScriptsEditorPage`) render **no title at all** — they open straight on a
`<Tabs>`, so the user never sees the name of what they opened.

### Search bars

Use **`ListPageToolbar`** for search + filter + sort above a card list. For a
standalone search box use **`SearchInput`** (`components/ui/search-input.tsx`) —
`size="page"` above a list, `size="dense"` inside a panel or toolbar. It is what
`ListPageToolbar` itself renders, so the two can't drift. ~15 screens still
hand-roll one, with magnifier icons from 11px to 16px; migrate them when you
touch them.

Entity cards compose from `CardMetaFooter` (author/org/date), `BadgeStrip`,
`TypeBadge` and `EntityActionsMenu`. Use them rather than laying out metadata
by hand — the author hover-card and org resolution live inside them.

### Forms outside dialogs

Same scale as dialog bodies: `<Label className="text-xs font-medium">`, hint
`text-xs text-muted-foreground`, `RequiredMark` for required fields. Use
`<Input>`/`<Textarea>`, never a raw `<input>` (7 files still do). Reach for
`SearchableSelect` when a `<Select>` gets long — it exists but is used once.

### Buttons

`Button` already defines `xs` / `sm` / `lg` / `icon-xs` / `icon-sm` / `icon-lg`,
and **defaults to `sm`**. Use the variant; don't pass `className="h-6 w-6"` to
resize a button. Icons inside buttons: `gap-1.5`, `size={14}` (or `12` for `xs`).

### Empty, loading & not-found states

**Empty** — use **`EmptyState`** (`components/ui/empty-state.tsx`):

```tsx
<EmptyState icon={Database} title={t('...')} description={t('...')} />
<EmptyState icon={Search} title={t('...')} variant="filtered" />
```

`variant` carries the meaning the codebase had encoded only by eye: `empty` (40px
icon, full weight) for a collection with nothing in it, `filtered` (32px, dimmed)
for a search that matched nothing. Inside a table, use the `h-16` row from §2
instead. Before this, "nothing here" existed in 4 text sizes and 8 containers.

**Loading** — prefer `Skeleton` shaped like the final layout. If you use a
spinner, it is `<Loader2 className="animate-spin" size={14} />` (14 is the
dominant of 10 sizes in use). Never hand-roll a CSS spinner — the 6 that existed
have been replaced — and never `return null` while loading (3 pages still do,
leaving the screen blank).

**Not found** — use `components/layout/EntityNotFound.tsx`. The 4 warehouse
detail pages bypass it and degrade to a bare grey `<p>` with no icon and no way
back; don't copy them.

### Section headers (uppercase group labels)

Use **`SectionLabel`** (`components/ui/section-label.tsx`). The 48 inline
occurrences are now written identically (`text-[10px] font-medium uppercase
tracking-wider text-muted-foreground`) so they can be swapped over mechanically;
~20 further hand-mixed variants remain.

---

## 5. Adding a new shared component

Put it in `components/ui/`, kebab-case file, PascalCase export, and **add a row
to this file**. A shared component nobody knows about gets rebuilt:
`SearchableSelect` has 1 call site and `ExportDialog` has 0.
