# eCRF / questionnaire analysis plugin — remaining work

Status: **import layer built and tested (166 tests); the analysis plugin ships as
`survey-question` with server parity. What remains is wiring and two open decisions.**

> The format survey and the licensing review are finished research and moved to
> [../ecrf-formats-licensing.md](../ecrf-formats-licensing.md) — read it before adding an
> importer or naming a vendor in the UI (clean-room rule, trademark rule, synthetic
> fixtures only).

## 1. Where we stand

**Import layer.** `survey/survey-schema.ts` (XLSForm vocabulary + the `binding`
extension), three parsers emitting one model — `goupile-import.ts`,
`survey/redcap-import.ts`, `survey/xlsform-import.ts` — plus
`survey/survey-normalize.ts` (expands `delimited` to `one_hot` at import),
`survey/survey-analysis.ts` (denominator rules) and `survey/survey-infer.ts`
(schema recovered from columns alone). The parser **dropdown** is wired into the
upload dialog (`survey-presets.ts` + `UploadDatasetDialog.tsx`) — no silent sniffing.

Verified end to end on real files — all three converge on one model:

| Source | Questions | Columns |
|---|---|---|
| Goupile (CNP-CEMIR, 214 rows) | 49 | 134, unchanged (already one-hot) |
| REDCap (144 rows) | 24 | 45, unchanged (already one-hot) |
| XLSForm/ODK (12 rows) | 12 | 14 → 22 (space-delimited expanded) |

**Plugin.** `packages/default-plugins/analyses/survey-question/plugin.json`, split per
decision (c) into a pure `SurveyQuestionBlock` (presentational, so Reports can map over
`schema.questions`) and `SurveyQuestionComponent` (the dashboard plugin). Server parity in
`app/services/execution/render/survey_question.py`, pinned by `test_render.py`.

## 2. Remaining

| St | Item | Effort |
|----|------|--------|
| 🔜 | **Wire `redcap` / `xlsform` to the upload path** — both parsers are tested but never called from a `.tsx`; the dropdown offers them and only Goupile actually parses | S |
| 🔜 | **Persist the schema to the dataset sidecar** (`SURVEY_SIDECAR_KEY`, keyed by column NAME so it survives re-import — ids derive from names, `lib/column-id.ts`). Declared but referenced nowhere; today everything rides on inference | M |
| 🔜 | Dataset import from the IDE (decided: full import, not a redirect) | S/M |
| 🔜 | i18n sweep — one thin `survey` section against the plugin's actual surface | S |
| 🤔 | **(b) User-overridable `measure`** — the field exists on the type, no UI control. No format except SPSS declares nominal/ordinal/continuous and it decides the chart; inference already errs on real data (`seniors_journee` read as a scale when it is a headcount) | S |
| 🤔 | **(d) In-place chart switching** — SurveyJS registers several visualizers per question type with a priority, so the best renders by default and the user switches among those *valid for that question*. Today it is a plain `chart` dropdown in `configSchema` | M |
| 💤 | Multi-sheet Excel import (one sheet at a time today) | S |
| 💤 | LimeSurvey / Qualtrics / Castor / OpenClinica importers — the common model covers them, but each needs its own truth-value and missing-data handling. **CDISC ODM is the highest-value target** (buys Castor + OpenClinica, MIT schemas) | L |

## 3. The analysis plugin — chart rules (as-built)

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

## 4. Sample files

`../mission-cnp-cemir-definition-mir/redcap-sample/` — a REDCap Data Dictionary and
matching data export (144 responses, 45 columns) mirroring the MIR questionnaire,
**generated by us** (not taken from vendor documentation), for testing the REDCap path
against the Goupile one.
