# eCRF / questionnaire import + analysis plugin

Status: **format survey done; licensing review in progress; a first analysis
core is built and tested (101 tests) but its data model is provisional pending
decision (a).**

Goal, in two steps:
1. **Import** — read the exports of the eCRF/survey tools people actually use,
   into one common model. This doc is mainly about whether that model is
   possible, and whether we are allowed to ship the importers.
2. **Analyse** — a plugin dedicated to questionnaire answers, modelled on the
   figures of the CNP-CEMIR survey (`presentation_questionnaire.Rmd`).

---

## 1. The formats

### 1.1 What each tool actually emits

| Tool | Data export | Data dictionary | Dictionary lives |
|---|---|---|---|
| **Goupile** | XLSX, one sheet per form | `@definitions` + `@propositions` sheets | inside the data workbook |
| **REDCap** | CSV/XLSX, one row per record | Data Dictionary CSV, 18 canonical columns | separate file |
| **LimeSurvey** | CSV/XLSX/SPSS/R/STATA, + VV round-trip format | TSV structure (14 cols), or `.lss` XML | separate file |
| **Qualtrics** | CSV/TSV (3 header rows), JSON, SPSS | QSF (JSON survey definition) | separate file |
| **Castor EDC** | CSV bundle (ZIP), semicolon-delimited | `*_variablelist.csv` + option groups | inside the bundle |
| **OpenClinica** | ODM XML, tab-delimited, Excel, SPSS/SAS | CRF Excel template (per-CRF) | authoring artefact |
| **ODK / Kobo** | CSV/XLSX | XLSForm (`survey` + `choices` sheets) | separate file |
| **Google Forms** | CSV | none (API `forms.get` only) | — |
| **MS Forms** | XLSX | none (no public API) | — |

### 1.2 The one thing that actually differs: multiple choice

Everything else (single choice, numeric, text, date) is one column per question
in every tool. Multiple choice is where they diverge, and it diverges on **three
independent axes at once**:

| Tool | Physical shape | Column naming | "Ticked" value |
|---|---|---|---|
| Goupile | one column per option | `q.code` | `1` / `0` |
| REDCap | one column per option | `q___code` | `1` / `0` |
| LimeSurvey | one column per option | `Q1_SQ001` | **`Y`** / empty — or **`1`/`2`** |
| Qualtrics (split on) | one column per option | `Q2_1` | `1` / blank |
| Qualtrics (default) | **one column** | `Q2` | comma-separated |
| Castor (CSV) | one column per option | `var#option` | `1` / `0` |
| Castor (API) | **one column** | `var` | **semicolon**-separated |
| OpenClinica | **one column** | item name | **comma**-separated (`1,2,7`) |
| ODK / Kobo | either | `q/code` when split | `1`/`0`, or space-separated |
| Google / MS Forms | **one column** | question text | comma / semicolon, **labels not codes** |

So: 5 name separators, 3 truth conventions, 2 physical shapes — and Castor
disagrees **with itself** between its CSV export and its API.

Two traps worth recording now:
- LimeSurvey's "convert Y/N" option emits **`1` = yes, `2` = no**. Any parser
  treating "non-zero = ticked" reads every *No* as a *Yes*.
- Castor encodes missing dates as **`31-12-2999`** (and its API falls back to the
  `1970-01-01` epoch). Both parse as valid dates and silently corrupt analysis.

### 1.3 Other things no format agrees on

- **Missing data.** Three states matter — *not shown* (branching), *shown but
  skipped*, *answered*. Every tool models them, incompatibly: LimeSurvey
  `{question_not_shown}`; Qualtrics `-99` + `displayedFields`; Castor `-95`…`-99`
  plus the date sentinels above; OpenClinica `IsNull` + `ReasonForNull`; REDCap
  cannot distinguish them at all for checkboxes (every option is pre-coded `0`).
- **Ordinality is never declared.** A REDCap `radio` coded 1–5 is
  indistinguishable from a nominal radio. Only SPSS-family formats carry a
  `measure` (nominal/ordinal/scale) field. This decides which chart is correct,
  so it has to be inferred *and* user-overridable.
- **Codes vs labels.** Google/MS Forms ship labels only, so an option literally
  labelled `Yes, sometimes` is unparseable from a comma-joined cell. Everyone
  else offers both, under a different switch name.
- **Internal id vs export code.** Every serious tool has both (REDCap
  `field_name` vs `___` columns; LimeSurvey SGQA vs qcode; Qualtrics QID vs
  DataExportTag). Only the internal id is stable — the export code is
  user-editable.

### 1.4 Is CDISC ODM a viable pivot format?

**No.** It is worth stating because it is the obvious candidate.

ODM has **no native multi-select primitive**: within an `ItemGroupData` the same
`ItemOID` may appear only once, so implementers invent their own encoding. REDCap
flattens a checkbox to one boolean `ItemDef` per option and keeps the real choice
set only in a proprietary `redcap:CheckboxChoices` attribute — strip the vendor
extension and the multi-select identity is gone. Castor's ODM export downgrades
**checkbox to radio** outright, losing multi-selection entirely.

Add: opaque OIDs unique only within a MetaDataVersion, five nesting levels with
no analysis-ready flattening, and two incompatible live versions (1.3.2 dominant,
2.0 breaking).

Verdict: useful as an **import source** and possibly a regulatory **export
target** — never as our internal model.

### 1.4b Verified against the real artefacts

Read directly, not from secondary sources (all under
`../mission-cnp-cemir-definition-mir/ecrf-formats/`):

- **ODM v2.0 schemas** (MIT) + 17 official examples + the 1.1→1.3.2 archive,
  from [cdisc-org/DataExchange-ODM](https://github.com/cdisc-org/DataExchange-ODM)
- **XLSForm reference** + `pyxform` (BSD), and the **ODK XForms spec**
- **OpenClinica's own XSLT** (`ODMToTAB.xsl`) — confirms multi-select is written
  out as a raw comma-joined value, with no special handling

The decisive artefact is CDISC's own
`Demographics_RACE_check_all_that_apply.xml` — the official example of a
"check all that apply" question. It needs **six nested XML blocks per
respondent** for six options (a `Static` repeating ItemGroup pairing a code item
with a boolean item), and CDISC's own comment concedes the cost:

> "'Race' lines are treated a boolean each: disadvantage: cannot be kept in the
> database as coded values 1,2, ... 99"

The same file carries **three further encodings commented out as `NOT (YET)
USED`** — CDISC has not settled on one. And the official example contains
outright bugs: `IT.RACE_BOOLEAN` holding `<Value>4</Value>` and `<Value>1</Value>`
where a boolean belongs, and a date written `1975-01-31>`. If the standards body
cannot keep its own flagship example internally consistent, that is a strong
signal about implementation cost.

The XLSForm equivalent of that entire construct is **one line**:

| type | name | label |
|---|---|---|
| `select_multiple usi` | `usi_specialites` | Quelles USI… ? |

Round-tripped through the official converter (`xls2xform`) to confirm it is not
just readable but *authorable*: a MIR-shaped XLSForm converts cleanly, producing
`<select1>` vs `<select>` (single vs multiple made explicit in the format),
reusable `<itemset>` choice lists, native `itext` multilingual labels,
declarative branching (`relevant="… = 'oui'"`), and an auto-generated
`_other` field with its own relevance condition.

### 1.5 So: is a common model possible?

**Yes. Adopt XLSForm as the questionnaire model, and add a thin binding layer
for the physical column layout.** This is a standard we adopt, not a format we
invent.

#### Why XLSForm rather than ODM

| | XLSForm | CDISC ODM |
|---|---|---|
| Multi-select | `select_multiple list` — **native, one line** | no primitive; ≥3 rival encodings, ~6 XML blocks/respondent |
| "Other, specify" | `or_other`, auto-generates the companion field | convention only |
| Ordinality | choice order in `choices` | not expressible |
| i18n | `label::fr` / `label::en`, native | `TranslatedText` per element, verbose |
| Branching | `relevant` column, one expression | `ConditionDef` + `MethodDef` |
| Authoring | a spreadsheet | XML with opaque OIDs |
| Licence | BSD (`pyxform`), spec public for implementers | schemas MIT, spec doc restricted |
| Adopted by | ODK, KoboToolbox, SurveyCTO, Ona, **OpenClinica 4** | EDC vendors, FDA submissions |

ODM is a **clinical data interchange** format that happens to carry forms;
XLSForm is a **questionnaire definition** format. Ours is the questionnaire
problem. Notably OpenClinica 4 replaced its own CRF template **with XLSForm** —
an EDC vendor reaching the same conclusion.

Keep ODM as an **import source** (it is how Castor and OpenClinica export) and a
possible regulatory **export target**. Never as the internal model.

#### The model

XLSForm's own vocabulary, kept as-is:

```
Question {
  type,                  // select_one <list> | select_multiple <list> | integer
                         // | decimal | text | date | note …
  name, label, hint,     // label/hint are LocalizedString (= XLSForm ::lang)
  relevant, required, constraint,
  binding                // ← our only addition
}
Choice { list_name, name, label }
```

The one thing XLSForm does not describe is **how the answers were laid out in
the export file**, because it describes forms, not exports. That is the binding:

```
Binding =
  | single_column   { column, valueMap }
  | one_hot         { columns[]: { code, column, trueValue, falseValue } }
  | delimited       { column, delimiter, valueKind: code | label }
```

Those three shapes cover every tool in §1.1 — and the prior art agrees: SPSS
models exactly this (`MDGROUP`/`MCGROUP` with a declared *counted value*), as
does quantipy (`delimited set` as a first-class type).

So an importer's job becomes: **emit XLSForm + a binding**. Nothing else is
invented, and the ODK/Kobo importer is nearly free (its source *is* XLSForm).

#### What an XLSForm *responses* file looks like

XLSForm describes forms, not exports — so the natural question is what the
answers look like. In ODK/Kobo, a plain flat CSV: one row per respondent, one
column per question, and multi-select as **space-separated codes in a single
column**:

```
nom_structure,type_structure,usi_specialites,activites_mir,activites_mir_other
CH de Brest,ch,pneumologie usih usic,don_organes avis_urgences other,Recherche clinique
CH de Rennes,ch,usic,avis_urgences,
```

(sample: `ecrf-formats/xlsform/mir-survey_responses.csv`)

That is the `delimited` binding, and it matters for §1.6: this shape is
**unreadable in a datatable** — a cell reading `pneumologie usih usic` is one
opaque string. Whereas the one-hot shape (REDCap, Goupile) *is* readable but
spreads one question over N columns. Neither is good at both jobs, which is
exactly the tension the next section arbitrates.

#### What this costs us

The current code (`survey-schema.ts`) uses its own `type` vocabulary
(`single`/`multi`/`numeric`/…) rather than XLSForm's, and has no binding layer.
Realigning it is decision (a), now with a clearer target: not "invent a split"
but "adopt XLSForm".

### 1.6 Where the converted questionnaire lives — the real architectural choice

Decided up front: **no more format sniffing.** Goupile detection was auto-magic;
from here the user picks the parser from a dropdown (Goupile / REDCap /
LimeSurvey / ODK / …). Detection may *suggest* a default, never decide silently.

That leaves the question of what an importer produces. Three options.

**Option A — convert to one interoperable file.**
Every importer emits one XLSForm-shaped questionnaire (definition + responses),
and the plugin only ever reads that.

- Good: one parser downstream; the analysis code never sees vendor quirks; the
  file is a portable, standard artefact a user can take elsewhere.
- Bad: **it fights Linkr's dataset model.** A dataset here is a table + column
  metadata, and everything downstream (the datatable, filters, the IDE, ETL,
  dashboards) assumes that. A bespoke questionnaire file is invisible to all of
  it — and you already flagged the consequence: *you cannot view it in the
  Datasets datatable*. That is a real loss, not a detail: eyeballing the raw
  answers is how you catch a broken import.

**Option B — the plugin reads every native format.**
No conversion; the plugin learns Goupile, REDCap, LimeSurvey…

- Good: nothing is lost, ever — the source file is the truth.
- Bad: vendor quirks leak into the analysis layer permanently, every new tool
  touches the plugin, and the same datatable problem remains (a `.lss` or a
  Qualtrics 3-header CSV is not a dataset either).

**Option C — dataset + questionnaire sidecar (recommended).**
The importer produces **a normal Linkr dataset** — one row per respondent, one
column per *answer slot*, one-hot for multi-select — **plus** an XLSForm-shaped
questionnaire stored as dataset metadata (the sidecar that already exists for
`label` / `description` / `valueLabels`).

- The datatable, filters, ETL, IDE and dashboards all keep working, because it
  is an ordinary dataset.
- The plugin reads the sidecar and gets the questionnaire structure — question
  grouping, choice lists, ordinality, branching — that a bare table cannot carry.
- Without the sidecar the plugin still works via inference (§3), just less well.
  Graceful degradation rather than a hard dependency.
- The questionnaire travels with the project export already, for free.

Why one-hot rather than space-delimited in the stored dataset: it is the shape
that is *readable in a datatable* and *filterable*, which is precisely what
Option A sacrifices. The delimited form stays supported on **input** (ODK,
Qualtrics, OpenClinica) and is expanded at import.

**On information loss.** Option C loses nothing that a visualization report
needs, provided the sidecar carries: question id + full text + short label,
type, choice list *in declared order*, the multi-select grouping, the
`measure` (nominal/ordinal/continuous), the section, and the branching
expression (as opaque text — enough to warn that a denominator is conditional).
Deliberately *not* carried: audit trails, discrepancy notes, per-field
validation rules, layout/appearance. These matter for an EDC, not for a report.
If we ever need them, they belong in a separate archival copy of the source
file, not in the dataset.

**On column count — checked, not assumed.** One-hot expansion multiplies
columns, so this was measured against the real CNP-CEMIR Goupile export:
**134 data columns for 50 questions** (`@definitions` = 50 variables,
`@propositions` = 114 options), the widest form being 91 columns. That is well
within what the datatable handles, and it is the shape the export *already* has
— Goupile and REDCap both one-hot natively, so for those two the import adds no
columns at all. Only the delimited sources (ODK, Qualtrics, OpenClinica) expand,
and there the alternative is an unreadable cell.

---

## 2. Licensing — can we ship these importers?

**Reviewed. Verdict: no tool on this list legally blocks writing our own
importer.** Linkr is GPL v3. *(Not legal advice; two items flagged for counsel
at the end.)*

The consistent pattern: vendors restrict **their software and their running
services**, not the act of reading a file their customer lawfully exported. Most
of them actively advertise data portability.

Two principles carry the weight:
- **Formats are weakly protected.** EU law is the firmer authority and the one
  that applies to us: Directive 2009/24/EC Art. 1(2) excludes interface ideas
  and principles from protection, and CJEU *SAS Institute v. World Programming*
  (C-406/10, 2012) held that a program's functionality and **data file formats**
  are not protected as such. (*Google v. Oracle* is often cited here but decided
  fair use and expressly declined to rule on copyrightability — weaker ground.)
- **Vendor licences bind their licensees, not us.** REDCap's EULA, Qualtrics'
  AUP and Castor's ToS are contracts with the institution running the tool.
  Linkr is not a party and never accepts them.

| Tool | Tool licence | Importer? | Name in UI? | Main caveat |
|---|---|---|---|---|
| REDCap | Proprietary (Vanderbilt EULA) | Yes | Yes, nominative | EULA bans redistributing *the Software*; a CSV parser is neither it nor a derivative. Registered TM — text only, no logo, add disclaimer. |
| LimeSurvey | GPL v2+ | Yes | Yes | Write our own parser. Don't use "LimeSurvey" as a published *package* name. |
| Qualtrics | Proprietary SaaS | Yes | Yes, nominative | Anti-reverse-engineering is scoped to "the Cloud Service", not exported files. No data-use or competing-product clause found. |
| Castor EDC | Proprietary SaaS | Yes | Yes, nominative | Clauses don't reach file parsing; EU mandatory interoperability right preserved. **Prefer its CDISC-ODM export.** |
| OpenClinica | LGPL (Community) | Yes | Yes, nominative | LGPL doesn't reach us (no linking, no distribution). **Native format is ODM.** |
| ODK / Kobo | Apache 2.0 / AGPL v3 | Yes — safest | Yes | Spec published expressly for third-party implementers. |
| CDISC ODM | Schemas **MIT**; spec doc restrictive | Yes | Yes | ⚠️ see below |
| Google Forms | Proprietary SaaS | Yes | Yes, plain text | Restrictive terms live in the *API* ToS, which never attach if we parse exports. No form-definition export — response CSV only. |
| MS Forms | Proprietary SaaS | Yes | Yes, plain text | Anti-reverse-engineering scoped to "the Services", carved out for what copyright law permits. |

### CDISC ODM — the one needing care

CDISC's two published positions contradict each other. The
[XML schemas on GitHub](https://github.com/cdisc-org/DataExchange-ODM) are
**MIT licensed**; the [website T&Cs](https://www.cdisc.org/terms-and-conditions)
forbid creating derivative works of, or redistributing, "the Material" and
confine use to "within Your Organization".

Sensible reading: the T&Cs govern the **specification document**; MIT governs
the **machine-readable schemas** published for implementers. Neither restricts
*implementing* a reader — a standard that could not be implemented would be
pointless, and FDA submission requirements make implementation its purpose.

So: bundle the `.xsd` from the MIT GitHub repo (retaining the MIT notice in
third-party notices), **never copy CDISC spec prose or PDFs into our docs** —
link instead.

### Rules we adopt

1. **Clean-room every parser** — written from public format documentation and
   example files, never by copying vendor source. This matters most for
   LimeSurvey and OpenClinica, whose code we *may* legally read: reading
   GPL/LGPL source and then writing similar code is where accidental derivation
   happens.
2. **Descriptive trademark use only** — "Import a REDCap export", never
   "REDCap Importer™" or "Linkr for Qualtrics". No third-party logos anywhere.
   One disclaimer line in docs and About: *product names and trademarks
   referenced are the property of their respective owners; Linkr is not
   affiliated with, endorsed by, or sponsored by any of them.*
3. **Synthetic fixtures only.** Hand-author every test file; never commit a real
   export. In our healthcare domain the GDPR/HIPAA risk of an accidentally
   committed real export **far exceeds** any IP risk. Vendor sample files from
   documentation sites carry no redistribution grant — generate our own instead
   (the CDISC T&Cs make this explicit for ODM samples).
4. **Track third-party notices** if we bundle the MIT ODM schemas.

### Strategic consequence

**CDISC ODM is the highest-value target**: one parser buys Castor, OpenClinica
and much of the wider EDC market, on an open standard with MIT schemas — the
best legal position *and* the best engineering leverage. ODK/XLSForm is second
(Apache 2.0, multi-vendor spec). Both rank above adding more vendor-specific
importers.

This does not change §1.4's verdict: ODM is a good **import source**, still not
our internal model.

### Open for counsel (neither blocks starting)

- CDISC's [IP policy PDF](https://www.cdisc.org/system/files/about/policies/cdisc_policy_003_intellectual_property_v201408.pdf)
  could not be read — the patent position is unverified.
- Whether REDCap's aggressive derivative-works assignment clause could reach an
  importer authored by someone who is separately a REDCap licensee. Practical
  mitigation: the importer is written from public documentation, not against a
  REDCap instance under its EULA.

---

## 3. The analysis plugin

### 3.1 Why not the Plot Builder

The Plot Builder charts *columns*. A questionnaire's unit is a *question*, and
the two stop coinciding as soon as a question is multiple-choice: that question
is physically N columns the builder sees as N unrelated variables.

- **Denominator.** The percentage for one option is over the respondents who
  answered the *question* (ticked ≥1 box), not over all rows and not over the
  ticks — so percentages legitimately exceed 100%. The builder has no notion of
  the group a column belongs to.
- **Non-response.** A blank is not a zero. `n/N` is a headline figure — it is in
  every slide header of the Rmd.
- **Co-occurrence.** "Who does both ECMO and SMUR?" is a property of the whole
  question, invisible to a per-column chart.

The Plot Builder remains right for free exploration of numeric columns.

### 3.2 Charts per question type

| Type | Default | Alternatives |
|---|---|---|
| `single` / `boolean` | horizontal bars sorted by frequency, `n (pct%)` at bar end | pie (≤4 choices), donut, table |
| `multi` | horizontal bars over respondents, sorted | co-occurrence heatmap, selection-count, by group |
| `scale` (Likert) | 100% stacked | diverging bars, distribution |
| `numeric` | histogram + median line | boxplot by group, stacked pair, summary stats |
| `text` | response count + sample | — |

Rules adopted (sources: Robbins & Heiberger JSS 57(5); the Datawrapper critique;
ColorBrewer; Lex et al. UpSet, IEEE TVCG 2014; MeasuringU):

- **No pie or 100%-stacked for `multi`** — they assert a part-to-whole that does
  not exist. Structural, not stylistic.
- **Never split the neutral category.** Splitting implies half the undecided lean
  each way, which the data does not say, and corrupts the total the chart exists
  to show. Neutral to one side, in grey.
- **Percent of respondents, not of responses**, stated on the chart.
- **Sort by frequency by default, never for a `scale`** — its codes carry meaning
  (1..5). Pin `Other` / `None` last.
- **Never a mean alone** for a Likert item: it destroys polarization (100 people
  at 3 and a 50/50 split at 1 and 5 both average 3). If one number is wanted,
  top-1-box beats top-2-box (the latter correlates r = .97 with the mean).
- Lightness encodes intensity; colorblind-safe diverging palette (`RdBu`, not
  `RdYlBu`); grey for neutral and non-response.
- `multi` non-response is genuinely ambiguous (all-zero row = "answered, ticked
  nothing" or "never shown"?). We define respondents as ≥1 tick and say so.

---

## 4. Open decisions

**(a) Adopt the logical/physical split of §1.5.** The current code assumes
"one-hot, 0/1", which §1.2 shows is wrong on both halves. Concretely, today's
`isTicked` would read LimeSurvey's `2` (= No) as a tick. ~1h now vs a rewrite
later. *Recommended.*

**(b) User-overridable question type.** No format except SPSS declares
nominal/ordinal/continuous, and it decides the chart. Inference already errs on
real data (`seniors_journee` read as a scale when it is a headcount). Without a
manual override a mis-typed question is unusable. *Recommended.*

**(c) Loop-instantiable widget — decided.** Rendering *every* question in
sequence (as `presentation_questionnaire.Rmd` does) belongs to the **Reports**
page, not to dashboards: a dashboard is composed one widget at a time.

So the component is split in two, and only the inner half is reusable:

```
SurveyQuestionBlock({ schema, question, rows, chart, … })   ← pure, presentational
SurveyQuestionComponent({ config, columns, rows, compact }) ← the dashboard plugin,
                                                              resolves config → question
```

Reports can then map over `schema.questions` and render one `Block` each,
without touching plugin config. This also matches `reports-plan.md`, which makes
Linkr widgets first-class BlockNote blocks via `createReactBlockSpec` — a block
needs exactly this "here is the question, here are the rows" signature.

**(d) In-place chart switching rather than a dropdown.** SurveyJS registers
several visualizers per question type with a priority: the best renders by
default, and the user switches among the ones *valid for that question*. Better
than a menu listing 13 charts, most inapplicable.

---

## 5. State

Done — **the import layer, decision (a) applied**:
- format survey (§1) and licensing review (§2), from primary sources
- `survey/survey-schema.ts` — XLSForm vocabulary + the `binding` extension
- three parsers, all emitting the same schema: `goupile-import.ts`,
  `survey/redcap-import.ts`, `survey/xlsform-import.ts`
- `survey/survey-normalize.ts` — expands `delimited` to `one_hot` at import
- `survey/survey-analysis.ts` (denominator rules), `survey/survey-infer.ts`
  (schema recovered from columns alone, for datasets imported without one)
- **138 unit tests**, typecheck and lint clean

Verified end to end on the real files — all three converge on one model:

| Source | Questions | Columns |
|---|---|---|
| Goupile (CNP-CEMIR, 214 rows) | 49 | 134, unchanged (already one-hot) |
| REDCap (144 rows) | 24 | 45, unchanged (already one-hot) |
| XLSForm/ODK (12 rows) | 12 | 14 → 22 (space-delimited expanded) |

Also: two UI fixes — the Excel import bug (a stale `selectedSheet` between
files, not an Excel support gap) and the upload checkbox alignment.

Next:
- wire the parser dropdown into the upload dialog (§1.6: no more sniffing)
- persist the schema to the sidecar under `survey`, keyed by column NAME so it
  survives re-import (ids are derived from names — `lib/column-id.ts`)
- the widget component + `plugin.json` manifest (drafted, not final), pending
  decision (c)
- dataset import from the IDE (decided: full import, not a redirect)
- i18n keys

Still open: **(b)** user-overridable `measure`, **(c)** loop-instantiable widget.

Deferred:
- multi-sheet Excel import (one sheet at a time today)
- LimeSurvey / Qualtrics / Castor / ODK importers — the model of §1.5 covers
  them, but each needs its own truth-value and missing-data handling
- persisting the schema to the dataset sidecar (inference covers it for now)

## 6. Sample files

`../mission-cnp-cemir-definition-mir/redcap-sample/` — a REDCap Data Dictionary
and matching data export (144 responses, 45 columns) mirroring the MIR
questionnaire, **generated by us** (not taken from vendor documentation), for
testing the REDCap path against the Goupile one.
