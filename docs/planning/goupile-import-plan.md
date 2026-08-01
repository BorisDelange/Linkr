# Goupile import connector — design

Status: **implemented.** A specialized import that turns a Goupile
eCRF export (`.xlsx`, multi-sheet) into a single wide Linkr dataset, auto-labelled
from the export's embedded data dictionary.

## Why

Goupile (eCRF / form builder) exports **XLSX only** (verified against source —
no CSV, despite a stray doc mention). Its structure is regular and predictable:
- **One data sheet per form** (`introduction`, `a_propos_de_vous`, …), each
  starting with system columns `__tid`, `__sequence`, `__hid`, then the form's
  variables. `__tid` is the record (respondent) id — the join key across sheets.
- **Two dictionary sheets**: `@definitions` (`table, variable, label, type` with
  type ∈ text/number/enum/multi) and `@propositions` (`table, variable, prop,
  label` — the code→label map for categorical values).
- **Multi-select** variables are one-hot exploded into `variable.prop` columns
  valued 0/1.
- **Missing values** are the literal string `'NA'`. **Enum** values are stored as
  the code, not the label.

Linkr today imports one file = one sheet = one dataset, and now has a column
metadata layer (`label`/`description`/`valueLabels`, `dataset-metadata-plan.md`).
The connector joins the sheets and fills that metadata from the dictionary — no
new storage, it rides the existing rails.

## Behaviour (all decisions settled)

| Aspect | Decision |
|--------|----------|
| Trigger | **Auto-detect**: on `.xlsx` upload, if the workbook has both `@definitions` and `@propositions` → offer Goupile mode |
| Output | **One wide dataset**, full-outer join of all data sheets on `__tid` |
| `__tid`/`__sequence`/`__hid` | **Kept as-is** (Goupile's canonical ids), labelled ("Record id", …) |
| Column name collisions | **Prefix by form only on collision** (`recours_mir.remarques` vs `perspectives.remarques`); otherwise raw name |
| Multi-select | **Keep the 0/1 columns** (Goupile's own format), each labelled |
| `'NA'` | **→ null** (real empty; the one deliberate departure from Goupile, for analysis) |
| Dictionary sheets | Feed metadata only; **not kept** as separate datasets |
| Architecture | **Client-side** (SheetJS already reads the xlsx); no new server endpoint |

Coherence principle: **columns stay faithful to Goupile** (variable names, the
`var.prop` one-hot convention, system ids) — a Goupile user recognizes every
column. Only the **cross-sheet join** is our own convention (there is no Goupile
flat format to imitate), documented here.

## Parsing pipeline (client-side)

In `UploadDatasetDialog` (SheetJS `XLSX.read` already loads the workbook):

1. **Detect**: `wb.SheetNames` contains `@definitions` AND `@propositions`.
2. **Parse the dictionary** (once):
   - `defs[(table,variable)] = { label, type }` from `@definitions`.
   - `props[(table,variable)] = [ {prop, label}, … ]` from `@propositions`.
3. **Data sheets** = every sheet whose name does not start with `@`. Read each with
   `sheet_to_json` (as the current `parseExcel` does).
4. **Join on `__tid`** (full outer): collect the union of `__tid` across sheets;
   for each `__tid`, merge the row from each sheet. `__sequence`/`__hid` taken once
   (from the first sheet that has them). A `__tid` absent from a sheet → that
   sheet's columns are null for that respondent.
5. **Column names**: keep the raw variable name; if the same name appears in ≥2
   forms, prefix ALL of its occurrences with `<form>.` (collision-only prefix).
   System columns are never prefixed.
6. **`'NA'` → null** across all cells.
7. Build `columns` (`buildColumns`) + rows, create the dataset via the **existing**
   path (`createFileWithData` local / `importDatasetBySha`+parse server), naming it
   after the file (e.g. `export_cnp-cemir-quest-non-mir`).
8. **Push metadata** via `POST /dataset-files/columns/meta` with, per column id:

### Dictionary → metadata mapping

Column id is `col_<slug(name)>` (deterministic, same front/back).

| Goupile column | Linkr `label` | Linkr `description` | Linkr `valueLabels` |
|----------------|---------------|---------------------|---------------------|
| plain `enum` var | `@definitions.label` | — | `@propositions` props → `{code: label}` |
| plain `number`/`text` var | `@definitions.label` | — | — |
| one-hot `var.prop` (multi) | the **proposition's** label (e.g. `situations_recours.detresse_vitale` → "Détresse vitale") | the **mother question** label (`@definitions.label` of `situations_recours`) | — (it's a 0/1 flag) |
| `__tid`/`__sequence`/`__hid` | "Record id" / "Sequence" / "Human id" (i18n) | — | — |

Note the multi case: a one-hot column's own **label** is the option label and its
**description** is the parent question, so a plot of `situations_recours.*` reads
as a labelled set of yes/no bars under one question. Enum `valueLabels` make a
Table1 / filter show "CHU/CHR" instead of `chu_chr`.

## UI

Auto-detect banner inside `UploadDatasetDialog` (no separate dialog):
- After parse, if Goupile is detected, show a banner "Goupile export detected" +
  a checkbox **"Import as one joined dataset (labelled from the dictionary)"**,
  checked by default. Unchecked → falls back to the normal single-sheet import
  (with the existing sheet selector), so nothing is lost.
- Preview shows the joined wide table (first rows) like any import.

Anchor points (from the import-flow map):
- Detect (server preview): `UploadDatasetDialog` `parseServer` uses `res.sheetNames`.
- Detect (local): `parseExcel` after `wb.SheetNames`.
- Sheet enumeration server-side already exists: `dataset_parser.excel_sheet_names`.
- Metadata push: `POST /dataset-files/columns/meta` (built in the metadata plan).

## Server mode note

Server import uploads the raw blob and parses **one sheet** server-side. Two
options for the join in server mode:
- **(chosen) Client builds the joined table, then imports it as a generated CSV/rows**
  through the existing create path — the join logic lives once, in JS, for both
  modes. The original `.xlsx` can still be kept as the raw file for reference.
- (rejected) A new server endpoint that joins sheets in DuckDB — duplicates the
  join logic in Python for little gain; revisit only if huge exports are a problem.

So: the connector materializes the joined rows client-side and feeds them to the
normal import; metadata is pushed right after. No new server code required beyond
what already exists.

## Edge cases

- **Incomplete respondents** (a `__tid` in some sheets but not others) — full-outer
  join leaves nulls; expected, surfaced by the completeness view later.
- **A form with no `__tid`** (shouldn't happen in Goupile) — skip that sheet with a
  warning rather than dropping the whole import.
- **Duplicate `__tid` within a sheet** (a respondent editing?) — Goupile shouldn't,
  but if present, keep the last and log it (mirror the Rmd's dedup stance).
- **Free-text columns** — kept as-is (string), `'NA'`→null; no value labels.
- **`@counters` sheet** (present only when the form uses counters/secrets) — ignored
  like the other `@` sheets.
- **A non-Goupile xlsx that happens to have those sheet names** — the checkbox lets
  the user opt out; detection is a suggestion, not a forced path.

## Tests

- Pure `parseGoupileWorkbook(sheets, dict)` → `{columns, rows, meta}`, tested on the
  two real exports in `../mission-cnp-cemir-definition-mir/` (mir + non-mir):
  - join row count = distinct `__tid` count;
  - a known one-hot column carries the right label + mother-question description;
  - a known enum column carries the right `valueLabels`;
  - `'NA'` cells are null;
  - a forced collision (same var in two sheets) is prefixed.
- Follows the write-tests convention (pure import/transform logic = unit-tested).

## Settled details

- **Raw file = the joined CSV**, not the original `.xlsx`. The Goupile transform
  (join on `__tid`, collision prefixing, `'NA'`→null, one-hot kept) runs **once**
  at import and is materialized into a flat CSV that becomes the dataset's raw
  file. A later re-parse / "Import settings" re-reads that flat CSV with the
  standard parser and yields the same dataset — stable. Keeping the multi-sheet
  `.xlsx` as raw would break on re-parse (the standard parser reads one sheet and
  loses the join). The user still holds the original `.xlsx` locally if a
  re-import is ever needed.
- **Collision prefix separator = `.`** (`<form>.<var>`), matching Goupile's own
  `var.prop` one-hot dotting for visual consistency.
