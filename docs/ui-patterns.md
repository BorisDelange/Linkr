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

Nine text sizes are in use across the app, which is the single biggest source of
"same function, different size". **Only these five are allowed in new code**, and
one of them you never type:

| Class | Use for | Never for |
|---|---|---|
| `text-2xl font-bold` | Page title (one per screen) | Anything inside a card or dialog |
| `text-base font-semibold` | Dialog / sheet titles — set by the primitive, don't type it | Body copy |
| `text-sm` | Body copy, card titles, list rows | Dense table cells |
| `text-xs` | Dense contexts: table cells + headers, form labels, buttons, badges, dialog descriptions | Page-level prose, alert-dialog descriptions |
| `text-[10px]` | Micro-chrome only: inline column filters, result counters, pagination | Anything a user reads as content |

`text-[11px]` is **deprecated** — it is visually indistinguishable from `text-xs`
(12px) yet still widespread, so it is the one size you will see in neighbouring
code and must not copy. Use `text-xs`. `text-lg`, `text-xl` and `text-3xl` are
not part of the scale (a handful of stray uses); `text-base` is reserved for
dialog titles and comes from the primitive, so you never type it.

### The primitives carry the scale

Each primitive's default **is** the scale value, so the correct call site passes
no size class at all. Each default was moved off the shadcn value to the one the
app's own call sites had settled on — the table records why, because a default
with no rationale gets "corrected" back to upstream:

| Primitive | shadcn | Ours | Why |
|---|---|---|---|
| `Label` | `text-sm` | `text-xs font-medium` | nearly every styled label was shrinking it by hand; `Input` sits at `text-[13px]` with **zero** overrides |
| `Badge` | `text-xs` | `text-[10px]` (+ `size="xs"` → 9px) | badges are chrome, not content, and sat beside `text-[10px]` counters |
| `DialogTitle` / `AlertDialogTitle` / `SheetTitle` | `text-lg` | `text-base` | `text-lg` was overridden all over; `text-base` still keeps a form title above its body, where the majority `text-sm` would flatten it |
| `DialogDescription` / `SheetDescription` | `text-sm` | `text-xs` | matches the dense body |
| `AlertDialogDescription` | `text-sm` | `text-sm` | an alert's description *is* its content — the consequences of a destructive action — not a subtitle over a dense form; nine call sites were already overriding `text-xs` back to `text-sm` |
| `Button` | — | added `sm-tight` (h-7) | dozens of buttons hand-rolled `className="h-7"` |

Inside a dialog, labels and the description render at **13px** rather than 12px —
the size `Input`, `Textarea`, `Select` and `Button` already use, so a dialog reads
as one consistent form instead of 12px labels over 13px fields. It comes from the
`dialog-form-scale` utility (`index.css`) that `DialogContent` applies to the
`label` and `dialog-description` slots. Nothing changes at the call site: keep
writing `<Label>` with no size class. `text-xs` still means 12px everywhere —
pages outside dialogs are untouched, which is why this is a scoped rule on two
slots and **not** a redefinition of `text-xs`.

> The `DialogTitle` row is the cautionary one: the raw majority vote was
> `text-sm`, but it came almost entirely from workbench dialogs (diffs, viewers)
> where a quiet title fits. Applied to a form it left the title the same size as
> the body. Count the call sites, then check they are the same *kind*.

**Write `<Label>`, `<Badge>`, `<DialogTitle>` with no size class.** Adding one is
a deliberate departure from the scale, so it needs a reason.

`cn()` runs `twMerge`, so a call-site override always beats the default. That is
what makes changing a primitive's default safe: no call site breaks silently.
Remove the overrides it makes redundant rather than leaving them to rot.

**Colours** — use theme tokens (`text-muted-foreground`, `text-primary`,
`text-destructive`, `bg-accent`). Raw palette classes (`text-green-600`,
`text-blue-500`…) are widespread. They are **not** broken in dark mode — an
audit found the `bg-X-50 dark:bg-X-950` pairing applied nearly everywhere, and
zero light blocks surviving into dark. Prefer tokens in new code anyway, because
a raw pair has to be maintained by hand; semantic domain colours are the
deliberate exception.

**Entity hues live in `lib/entity-colors.ts`.** Each entity kind owns one hue,
used by its sidebar item, the icon square on its list-page card, and its catalog
badge (`.icon` / `.bg` / `.badge`). Hues are spread around the wheel, not shaded
off one domain colour, so a seven-item sidebar group and a mixed catalog grid
stay readable; picking a new one means staying clear both of its neighbours and
of the chrome's existing blue / violet / orange / pink / slate. Import the hue;
never re-type `text-teal-500` at a call site, or the three surfaces drift apart.

> Before reporting a colour as dark-mode-broken, read the whole class attribute:
> a per-line `grep` for `bg-green-50` matches a line whose `dark:` variant sits
> in the same string, and reports a violation that isn't one.

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

**Do not hand-roll a `useReactTable`** to get sorting or resizing. Seven files still
do; each is listed below with the specific thing holding it back. The pieces they
used to copy (resize grip, sort arrow, filter field, column label) now come from
`table-primitives` — so a new table has no excuse to re-declare any of them.

Multi-selection is opt-in too — pass `selectedRowKeys` + `onSelectedRowKeysChange`
for file-explorer behaviour (plain click replaces, Ctrl/Cmd toggles, Shift
extends from the anchor). Ranges follow the *filtered, sorted* order, so a
Shift-click selects what the user sees. The maths is `nextSelection()`, unit
tested in `concept-data-table.test.ts`.

**Checkbox selection is a different thing** — a dedicated column where every
click is a plain toggle and the header selects all. Don't reach for
`selectedRowKeys` there: its plain click *replaces* the selection, so unticking
one row would untick the rest. Build the column yourself with `headerCell` (the
select-all control) and `cell` (the per-row box), keeping the toggle semantics
in your own state; `PullConceptsDialog` is the reference. Pair it with
`onVisibleRowsChange` so select-all acts on the filtered rows.

Pass **`viewKey`** for a table inside a dialog: sort, filters, column sizes,
order and visibility are remembered under that key, so reopening the dialog
gives the user back the view they left. It is a module-level cache on purpose —
meant to survive a remount, not a reload.

Two escape hatches for what the table cannot know: **`filterCell`** places your
own control in the filter row when a column's predicate isn't per-value (a row
listing several providers must match a pick of any one of them), and
**`rowClassName`** marks a row state the table has no concept of, such as
dimming entries already handled elsewhere.

**Always paginate.** Pass `pageSize` (100 unless you have a reason) on any table
that can run long: a DOM node per row is what makes sorting and row selection
lag. The app has no infinite-scroll tables — paging is the one idiom, and the
footer places it identically everywhere.

**`cellTooltips`** decides what a hover reveals: `truncated` (default) only when
text is cut, `all` for tables whose values get copied out routinely — concept
ids, source codes — and `readOnly` to drop the copy button in dense
pick-a-row tables, where a hoverable panel would sit over the next rows. No mode
mounts a tooltip per cell; they are built on first hover.

### When a bespoke table is still legitimate

**Server-side pagination is the real dividing line.** `ConceptDataTable` owns
its sort, filters and paging, and computes them over the whole `data` array. A
table whose parent drives those through callbacks and answers each one with SQL
is a different design, not a missing feature — migrating it would mean loading
the entire vocabulary into memory. Four tables are genuinely in that case:
`SourceConceptTable`, `ConceptTable`, `CohortConceptPickerDialog` and
`GlobalSummaryView`'s dedup/flat pair.

**Do not trust the `manual*` flags to tell you which.** `manualSorting` /
`manualFiltering` / `manualPagination` have been copy-pasted into tables that are
entirely client-side — `ConceptSetsTab`, `MappingsTab` and `TargetConceptPanel`
all set them while slicing in JS (`sorted.slice(page * 50, …)`), and
`GlobalSummaryView` is the inverse: fully SQL-driven with no flags at all. Read
where the rows come from, not what the options say.

Column pinning, sticky headers and density moved in for the analysis plugins:
pass `stickyHeader` to keep the header visible while the body scrolls,
`density="compact"` for a table read as a block of figures (a dashboard widget)
rather than browsed row by row, and `striped` for alternate row shading. On a
column, `pinned` glues it to the left edge — pin only the leading one or two,
since the numbers mean nothing once the variable name has scrolled off —
`align: 'right'` lines numbers up by magnitude, and `cellClassName` carries
styling the table cannot infer.

Beyond that, the shared table still lacks **multi-level headers (`colSpan`
groups)** and virtualisation. If you need one of those, the rule is **extend the
shared component**, not fork it — reorder, multi-selection, checkbox headers,
view persistence, pinning and density all moved in that way.

**Known debt (do not extend, help retire):** the client-side hold-outs above are
migratable in principle, but each is held back by something structural rather
than by paging — in-cell async-import popovers (`SourceConceptTable`), a
memoised review-workflow row and a detail view that replaces the table
(`MappingsTab`), dnd-kit reorder plus affordance columns exempt from
sort/filter/hide (`ConceptTable`), two row types through one render path
(`GlobalSummaryView`), and three tables in one component (`TargetConceptPanel`).
Retiring one means moving that capability into the shared component first.

Their duplicated *pieces*, however, are already shared: see `table-primitives`
below. Reach for those before writing a header, a sort arrow or a resize grip.

### Table styling — exact classes

Copy these; they are what `ConceptDataTable` renders.

| Part | Class |
|---|---|
| Header cell | `relative select-none overflow-hidden text-xs` |
| Body cell | `overflow-hidden truncate px-2 py-1 text-xs` |
| Inline filter input | `h-6 w-full rounded border border-dashed bg-transparent px-1.5 text-[10px]` |
| Empty state row | `h-16 text-center text-xs text-muted-foreground` |
| Footer bar | `border-t px-3 py-1.5`, counter `text-[10px]`. **Left:** result count + column menu. **Right:** page arrows and `n / m`. Same in every table — don't rebuild it. |
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
| `OverflowBadgeList` | A badge row too narrow for its items. Keeps whole badges, folds the rest into `+N` with the full list as bullets on hover. Never clip a badge row with `overflow-hidden`. |
| `DebouncedInput` | Any search box over a large set (300 ms). One shared copy at `ui/debounced-input` — do not re-declare it locally. |

**`table-primitives`** holds the parts every table repeats, shared so a bespoke
table still looks like the others: `FILTER_INPUT_CLASS` (and its `_DENSE`
variant), `SortIndicator`, `nextSorting` (desc → asc → none), `columnLabel`, and
`ColumnResizeHandle` / `ResizeGrip` — the latter headless, for the two tables
that track widths themselves instead of through TanStack.

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

### Entity create/edit dialogs: `EntityDialogTabs`

Every entity's create/edit dialog wears the same tabs — **General** (name,
identifier, description), an optional domain tab, **Metadata** (status, badges,
version), and **Attribution** (edit only). Pass the panels, not a `Tabs` tree.

The dialog is sized to its tallest panel from the first frame, so switching never
moves the triggers out from under the pointer. Two traps, both already paid for:

- Every panel is measured, including the ones not on screen — measuring only what
  has been *shown* still grows the dialog on the first visit to a taller tab.
- Measure with `offsetHeight`, never `getBoundingClientRect()`. A dialog opens
  under `zoom-in-95`, and a rect read mid-animation comes back 5% short.

Edit dialogs also pass `dirtyTracked` + a `useSaveForm` baseline, which greys Save
and turns Cancel into Close while nothing has changed.

### Remaining rules

- **Never put a size class on `DialogTitle`/`DialogDescription`/`SheetTitle`** —
  the primitives now carry the right size. `sr-only` is still fine. Same for
  `AlertDialogDescription`, including inside an `asChild` wrapper: it is
  `text-sm`, so the `<p className="text-sm">` that used to sit in every
  "type the name to confirm" body is now the redundant override §1 warns about.
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
  (used consistently throughout) — keep it that way.
- **`DialogShell` renders no `<form>` — it confirms on Enter itself.** Don't
  re-add a `<form onSubmit>`, and don't hand-roll an `onKeyDown` Enter guard per
  dialog: those were three different spellings across sibling dialogs, and four
  dialogs migrated off `<form>` silently lost Enter-to-submit altogether.
  Textareas and anything inside a real `<form>` keep Enter. For a field where
  Enter means something else (a tag input that adds on Enter), mark that field
  `data-no-enter-submit`; to disable it for a whole dialog, pass `noEnterSubmit`.

### Shared dialogs — check call sites before restyling

`ImportConflictDialog` (10 call sites), `ImportSourceDialog` (5),
`EntityDocsDialog` (4), `ImportErrorDialog` (3), `EntityVersioningDialog` (2).
Editing one changes every caller. If only the wording differs, take a mode prop
and switch i18n keys (see `ImportConceptSetDialog`'s `dictionaryMode`) rather
than touching styling.

`components/ui/export-dialog.tsx` has **zero call sites** — superseded by the
export UI inside `entity-versioning-dialog.tsx` (file-private, so not importable).
Don't build on `export-dialog.tsx` without checking why it was abandoned.

---

## 4. Page shells

### List pages: use `ListPageTemplate`

**`features/warehouse/ListPageTemplate.tsx`** already composes the whole list
screen — page header, `ListPageToolbar`, cards with `EntityActionsMenu` +
`CardMetaFooter` + `BadgeStrip`, and the empty state. 7 pages use it. If you're
building an entity list, start here, not from a blank page.

### Card-grid multi-selection

Every card grid supports Cmd/Ctrl-click multi-selection through two shared
pieces — never re-implement the maths or the confirm dialog:

- **`useCardSelection(keys)`** (`components/ui/use-card-selection.ts`) — pass the
  **filtered, sorted** keys the grid actually renders, so Shift-ranges follow
  what the user sees and keys that leave the grid drop out of the selection. It
  reuses `nextSelection()` from the shared data table, so cards and tables read
  the same way.
- **`BulkDeleteAction`** (`components/ui/bulk-delete-action.tsx`) — the
  destructive `Delete (N)` button plus its confirm dialog listing the names.

A plain click stays **navigation**: selection only ever starts with a modifier.
Wire it in three places:

```tsx
const selection = useCardSelection(useMemo(() => rows.map((r) => r.id), [rows]))

// 1. header: bulk actions REPLACE Import/New while a selection is active
{selection.active ? (
  <BulkDeleteAction
    selection={selection}
    names={(id) => localized(rows.find((r) => r.id === id)?.name, language)}
    onDeleteMany={async (ids) => { for (const id of ids) await onDelete(id) }}
    canDelete={canDelete}
  />
) : <>{/* Import + New, unchanged */}</>}

// 2. the card: grey it out, and let the click be consumed
<Card
  className={cn('…', selection.isSelected(row.id) && selectedCardClass)}
  onClick={(e) => { if (selection.onCardClick(e, row.id)) return; navigate(row.id) }}
/>
```

`onDeleteMany` must reuse the page's **existing** delete function — the one the
single-item confirm dialog calls — so both paths stay in sync. Cards living in
their own component (`CohortCard`, `DatabaseCard`) take optional `selected` +
click-interception props rather than being forked.

### Git-linked cards: the "content not imported" badge

A card for a git-linked entity whose content was not reconstituted needs two
things, and they must agree — a card must never link to the repo while showing
no badge, or badge without the link. Both come from one hook:

```tsx
const { badgeFor, repoUrlFor } = useContentBadge('databases', workspaceId)

<Card contentBadge={badgeFor({ type: 'database', id, name, gitRemote })}
      onClick={() => { const repo = repoUrlFor(id, gitRemote?.url); … }} />
```

`useContentBadge` (`components/versioning/use-content-badge.tsx`) wraps
`useGitContentStatuses` + `GitContentStatusBadge` + `cardRepoUrl`, and handles
the `workspaceId && gitRemote?.url && status` guard and the retry refetch itself.
Do not rebuild that guard at a call site — it was open-coded four times before
this hook existed. `repoUrlFor` returns null in server mode (the content can be
retried in place, so the card keeps navigating).

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

Don't hand-roll `<h1 className="text-2xl font-bold">` — most pages still do, which is
why the title drifted. `ListPageTemplate` already consumes both.

Two known gaps: `text-2xl` doubles as *page title* **and** *KPI number*, so a
metric looks like a heading; and 4 detail pages
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

Same scale as dialog bodies: a bare `<Label>` (the primitive already carries
`text-xs font-medium` — adding it back is the redundant override §1 warns about),
hint `text-xs text-muted-foreground`, `RequiredMark` for required fields. Use
`<Input>`/`<Textarea>`, never a raw `<input>` — roughly 35 files outside
`components/ui/` still do, so copying a neighbour is not a safe guide here.
Reach for `SearchableSelect` when a `<Select>` gets long.

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
the dominant size). Never hand-roll a CSS spinner — the ones that existed
have been replaced — and never `return null` while loading (3 pages still do,
leaving the screen blank).

**Not found** — use `components/layout/EntityNotFound.tsx`. The 4 warehouse
detail pages bypass it and degrade to a bare grey `<p>` with no icon and no way
back; don't copy them.

### Section headers (uppercase group labels)

Use **`SectionLabel`** (`components/ui/section-label.tsx`), with `as` to keep the
real tag where the label is a heading (`as="h3"`).

**Do not use it for a form `<label>`.** ~25 sites keep a hand-written class for
that reason: `SectionLabel` renders a `div`/`span`/heading, and swapping the tag
would drop the association between the label and its input. Styling a label like
a heading is not the same as it being one.

---

## 5. Field & control catalogue

Composed components that solve one recurring field or control. Most encode a
**decision**, not just styling — rebuilding one loses the decision silently.
Check this table before writing any form field.

| Component | Use for |
|---|---|
| `FormField` | **Any labelled field** — label, optional hint, control. Owns the label/control gap, which had drifted into two spacings across 22 files, and wires `htmlFor` to the control so clicking the label focuses it. Every form field in the app goes through it; a hand-written `<div className="space-y-1"><Label>…` is the pattern it replaced. |
| `EntityIdField` | The id field on every entity create/edit dialog (slug rules, uniqueness, locked-after-create). |
| `VersionField` | The version input on those same dialogs. |
| `AuthoringFields` | Author + organization on an entity dialog. Both start locked showing the originals; unlocking re-attributes and writes a frozen snapshot. Don't roll your own attribution UI. |
| `DatePickerField` | Any date input — built on the app's own `Calendar`, so every date field matches. |
| `PasswordInput` | Any secret input (reveal toggle). |
| `LangHint` | Marks a field as `LocalizedString`-backed, so the user knows they are editing one translation. |
| `RequiredMark` | The required-field asterisk. |
| `GatedButton` | An action the user may lack permission for: renders disabled with an explanatory tooltip. **UX only — real enforcement is server-side.** |
| `ExecuteNotPermitted` | Placeholder in place of a code-backed widget the user can't execute. |
| `ServerModeNotice` | The single "not available in client-only mode" notice. Don't write that sentence yourself. |
| `EditableBadge` / `BadgeEditor` / `BadgeColorButton` | Badge chips, the badge editor (offers badges already used on sibling entities), and the colour swatch. |
| `ColorPickerPopover` / `IconPicker` | Colour and icon selection. |
| `FileTypeIcon` / `LanguageIcon` / `FileTreeHeader` | File-tree chrome: per-extension icon, language brand logo, sortable column header. |
| `CopySelectButton` | The "Copy SELECT" button in every database schema view. |
| `CopyablePath` / `ParquetFilesDialog` | A server path shown as copyable code, and the "N files" + Show dialog listing a Parquet source's table → blob paths (ETL sidebar, database Connection card). |
| `CustomSqlDot` | Marks a widget whose SQL was hand-edited; its tooltip carries the consequence (regenerating discards the edit). |
| `LinkrLogo` | The logo. |

### Tooltips

**"Tooltip" means the Radix one** — `components/ui/tooltip.tsx`: dark background,
light text, rounded, `text-xs`, arrow, animated in. It is theme-aware
(`bg-foreground text-background`), so it inverts correctly in dark mode. When a
tooltip is asked for, this is the default; never reach for the browser's.

```tsx
<Tooltip>
  <TooltipTrigger asChild><Button size="icon-sm"><Trash2 size={14} /></Button></TooltipTrigger>
  <TooltipContent side="bottom">{t('common.delete')}</TooltipContent>
</Tooltip>
```

Style it as little as possible — `side`/`align` and, at most, a width. The dark
panel, the padding and the text size come from the primitive.

For **text that may be cut off**, don't build the tooltip by hand: use
`TruncatedText` / `TruncatedHeader`, or a table's `cellTooltips` (§2). They
measure the overflow, only reveal what is actually truncated, add the copy
button, and mount nothing until the pointer arrives.

**The native `title=` attribute is the exception, not the fallback.** It renders
the OS tooltip — pale, unstyled, ~1s delay, unthemed — so it does not match the
app. It is legitimate in exactly one case: a long list where a Radix tooltip per
row costs too much (`MappingsTab` uses it across 50 rows for that reason, and
says so). Outside that, `title=` on a control is a bug; there are ~285 of them
left, so a neighbour is not evidence.

`GatedButton` already carries its own tooltip for the disabled-by-permission
case — a disabled element emits no pointer events, so a plain `Tooltip` around
one silently never opens.

---

## 6. Working rules

Everything above says *which* component to use. These five say how to work when
none of them quite fits — which is when drift starts.

### Action buttons say "New", dialogs say "Create"

The button that opens a creation dialog is **`New <entity>`** in sentence case —
"New dashboard", "New rule set", never "Create dashboard", "Create a workspace"
or Title Case. The dialog it opens keeps its own voice: the title is
"Create a <entity>" and the submit button is `common.create`. When one i18n key
served both, it was split rather than compromised (`concept_mapping.new_project`
for the button, `concept_mapping.create_project_title` for the dialog).

### Extend the shared component; don't degrade the caller

When a shared component *almost* fits, add the missing capability to it. Do not
fork it, and do not drop the feature from the screen you are building.
`onVisibleRowsChange`, `headerCell`, `viewKey`, `filterCell`, `rowClassName`,
`resizable` and `cellTooltips` exist on `ConceptDataTable` for exactly that
reason: each one is a capability a caller needed and would otherwise have lost.

The judgement call: if the capability is **general** (any table might want it),
it goes in the shared component. If it is **specific to one screen's domain**
(a review workflow, an import popover), that screen keeps its own code — and the
reason goes in "when a bespoke one is legitimate" above, so it is not
re-litigated later.

### Change the default, don't hardcode the exception

Writing the same override at call site after call site means the **primitive's
default is wrong**. Fix the default and delete the overrides; the `Label`,
`Badge` and `DialogTitle` rows in §1 are the worked examples.

`cn()` runs `twMerge`, so a call-site override always beats the default — which
is why changing a default cannot silently break a call site that opted out. Pick
the value the codebase already votes for: count the call sites first, and weight
them by *kind*, since the majority value can come from a context unlike the one
you are fixing.

### Three copies means it belongs in one place

A literal, helper or JSX block living in three files is a shared module waiting
to happen — that is what `table-primitives` is.

**Diff the copies before merging them.** Near-identical is a different fact from
identical. There are two `columnLabel` helpers on purpose: `table-primitives`
takes column defs and reads a header renderer, while `lib/format-helpers` takes
an id and strips a leading underscore, so affordance columns render as `Select`
rather than `" Select"`. Merging them would break one caller silently. When
copies genuinely differ, leave them and say which is for what.

### Read the data flow, not the flags

`manualSorting` / `manualFiltering` / `manualPagination` appear on tables that
filter and slice entirely in JS, and are absent from one that is fully
SQL-driven (see §2). A config option states an intention; it is not evidence.
Trace where the rows come from before concluding what a component does. The same
caution applies to a `grep` hit, which shows you a line and not the surrounding
class string.

### Leave the reason, not just the result

When you decide a component stays bespoke, or that a default takes a given value,
write **why** where the next person will look: this file, or a comment on the
surprising line. A rule with no rationale gets re-litigated; a result with no
rationale gets undone. Two docs naming different "reference" implementations for
the same pattern is the worst case — every new screen then inherits whichever one
its author happened to read first.

---

## 7. Adding a new shared component

Put it in `components/ui/`, kebab-case file, PascalCase export, and **add a row
to this file** — §5 if it's a field or control, otherwise the relevant section.
A shared component nobody knows about gets rebuilt, which is how
`SearchableSelect` ended up with 1 call site and `ExportDialog` with 0.
