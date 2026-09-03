# SPC / control-chart plugin — theory, chart choice, and design

Status: **built, not yet exercised in the running app.** §6 was arbitrated (one plugin,
auto-detect with an explicit override, all-data baseline by default, risk adjustment via
an optional expected column, both compute paths). What ships:

- `apps/web/src/lib/spc/` — the pure computation, 92 Vitest tests
- `packages/default-plugins/analyses/spc/plugin.json` + `SpcComponent.tsx` + `spc-server.ts`
- `apps/api/…/render/spc.py` + the `spc` kind, 125 pytest tests **that run the emitted
  program and assert on the numbers it prints**, against the same references as the TS

Verified against the real NeoCLIP dataset: the plugin reproduces an independent pandas
computation exactly (centre 0.06667 over 47 periods, limits to 1e-9), and steers a
low-volume unit off a monthly proportion onto the g-chart — which reads it as the stable
process it is (12 intervals, no signal) where the p-chart flagged all 47 periods.

**What remains: running it in the app** (no plugin has a validator — loading it and using
it is the only check that exists), then migrating the NeoCLIP widgets. Kept below: the
reading path, the chart-selection tree and the formulas, which are the reference for
reviewing what was built.

> Prior art in this repo: two projects already do SPC by hand —
> `@Linkr private portal RiCDC/projects/micu-clip` (`_sources/spc_ewma_pavm.R`,
> `_sources/spc_gchart.R`) and `.../neoclip` (the EWMA script, inline in **20 widgets**).
> `micu-clip/INDICATEURS_CANDIDATS.md` already carries a "which chart for which
> indicator" doctrine. This plan generalises all of it.

---

## 1. Why a plugin (the evidence)

The NeoCLIP dashboard (75 widgets) carries **two** generic SPC scripts, copy-pasted inline
into **39 widgets**, ~25 000 characters each — roughly **1 MB of duplicated statistics in one
dashboard document**:

| Family | Widgets | Script |
|---|---|---|
| **EWMA** | **20** | "Widget EWMA — toutes variables (numérique ou catégorielle) + règle de couleur" |
| **Shewhart u-chart** | **19** | "Widget Shewhart u-chart — Taux d'evts par periode (Poisson)" |

Diffing two EWMA widgets (gestational age vs. deaths) gives **3 differing lines out of ~700**:

```
-y_var       <- "ga_weeks"          +y_var       <- "death_status"
-x_var       <- "birthdatetime"     +x_var       <- "discharge_datetime"
-chart_title <- "…âges gestationnels…"  +chart_title <- "…décès…"
```

Four consequences, all already real:

- **Drift, and it has already happened.** Widget 37 alone received a `str_wrap()` fix for
  overflowing titles (and a `stringr` dependency the other 19 lack). Widget 27 (CLABSI) is a
  genuine **fork** of the u-chart script: it adds a fourth denominator mode, `device_days`
  (device-days by overlap, the CLABSI/VAP standard, with four extra parameters) — and pays for
  it by dropping most of the explanatory comments. **The best version of the u-chart lives in
  exactly one widget, and the other 18 will never receive it.**
- **No review surface.** The control limits are the clinical claim — "this month is out of
  control" — and they live in 39 unreviewed string blobs rather than in tested code.
- **Most of the configuration is dead weight.** Across the 20 EWMA widgets, **14 of the 24
  parameters never vary** (`lambda` 0.2, `L` 1.96, `run_len` 6, `rate_basis` 1000, `agg_fn`
  "median", …). Only 9 parameters plus the title actually differ. That is precisely a
  `configSchema` with sensible defaults.
- **R-only.** The scripts need `dplyr`/`lubridate`/`ggplot2` in a project R environment.
  A Python project, or a client-only (WASM) deployment, gets nothing.

A component plugin fixes all four at once, and matches where the other nine analysis
plugins already are: `runtime: ["component"]`, TypeScript compute, Python parity server-side.

**The u-chart script already covers five chart types** — `p`, `np`, `c`, `u`, and **`t`**
(Nelson's 1994 time-between-events chart, via the `Y = T^(1/3.6)` transform) — but all 19
widgets use `u`. So p/np/c/t are written, tested by nobody, and reachable only by editing a
string. The plugin turns them into a dropdown.

---

## 2. What to read

Ordered as a reading path, not by importance. The first two are the whole foundation;
read them and you can already configure every chart in §4.

### 2.1 Start here

1. **Benneyan, Lloyd & Plsek (2003), *Statistical process control as a tool for research
   and healthcare improvement*, Qual Saf Health Care 12:458–464.**
   [Free PDF](https://tbrieder.org/epidata/course_reading/d_benneyan.pdf) ·
   [DOI](https://doi.org/10.1136/qhc.12.6.458)
   The canonical healthcare SPC paper, and the one `INDICATEURS_CANDIDATS.md` already
   cites. Common-cause vs. special-cause variation, why reacting to common-cause noise
   ("tampering") makes a process worse, the chart-selection decision tree, and the
   rare-event g/t charts. **Read this one first, in full.**

2. **Mohammed, Worthington & Woodall (2008), *Plotting basic control charts: tutorial
   notes for healthcare practitioners*, Qual Saf Health Care 17:137–145.**
   [Free PDF](https://qi.elft.nhs.uk/wp-content/uploads/2018/10/Mohammed-et-al-2008-Plotting-basic-control-charts.pdf)
   The practical companion: how you actually build each chart, with worked arithmetic.
   This is the one to have open while implementing — it is where the formulas in §5 come from.

### 2.2 Choosing rules, and not over-alarming

3. **Anhøj (2015), *Diagnostic value of run chart analysis: using likelihood ratios to
   compare run chart rules on simulated data series*, PLoS ONE 10(3):e0121349.**
   [Open access](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0121349)
   Compares the Anhøj / Perla / Carey rule sets by sensitivity and specificity on simulated
   series. Concludes the **Anhøj rules** (longest run + number of crossings, both a function
   of series length) dominate. This is the evidence base for *which* runs rules to ship —
   the naïve "8 points on one side" is a fixed threshold applied to series of any length.

4. **Anhøj & Olesen (2014) / the `qicharts2` documentation.**
   [Package site](https://anhoej.github.io/qicharts2/) ·
   [Control charts vignette](https://cran.r-project.org/web/packages/qicharts/vignettes/controlcharts.html)
   The de-facto reference implementation in healthcare QI: I, MR, Xbar, S, T, C, U, U', P,
   P', G charts, Anhøj rules as sensitising rules on control charts. **Read the vignette as
   a spec** — our chart list in §4 deliberately tracks its coverage, and it is the obvious
   thing to validate our numbers against.

5. **Woodall (2006), *The use of control charts in health-care and public-health
   surveillance*, Journal of Quality Technology 38(2):89–104.**
   The critical review. Why Phase I (learning the limits) and Phase II (monitoring against
   frozen limits) are different problems, and why the healthcare literature routinely
   conflates them. Directly motivates the calibration/freeze design in §6(b).

### 2.3 The two traps specific to health data

6. **Laney (2002), *Improved control charts for attributes*, Quality Engineering
   14(4):531–537** — the **P′ and U′ charts.**
   [Minitab's overview](https://support.minitab.com/en-us/minitab/help-and-how-to/quality-and-process-improvement/control-charts/how-to/attributes-charts/laney-p-chart/before-you-start/overview/) is the clearest short explanation.
   **This matters more than its obscurity suggests.** With large denominators (a p-chart on
   1 200 admissions/month), binomial limits become so tight that nearly every point falls
   outside them — not because the process is unstable, but because real between-period
   variation exceeds what the binomial allows (overdispersion). The P′ chart rescales the
   limits by the observed between-period variation, and degrades gracefully to the ordinary
   p-chart when there is no overdispersion. **Any p/u chart we ship on hospital volumes
   needs this**, or it cries wolf every month.

7. **Spiegelhalter (2005), *Funnel plots for comparing institutional performance*,
   Statistics in Medicine 24(8):1185–1202.**
   [DOI](https://doi.org/10.1002/sim.1970) ·
   [FunnelPlotR](https://nhs-r-community.github.io/FunnelPlotR/) (NHS-R implementation)
   For *comparing units* (services, sites, operators) rather than *following time*: plot each
   unit's rate against its precision (its volume), with limits forming a funnel. The paper
   also handles overdispersion, and argues the case against league tables. Relevant to the
   INDICATE cross-site comparison work, and to any "compare our ICUs" ask.

8. **Steiner, Cook, Farewell & Treasure (2000), *Monitoring surgical performance using
   risk-adjusted cumulative sum charts*, Biostatistics 1(4):441–452**, plus **VLAD**
   (Lovegrove et al., Lancet 1997).
   [PMC review of both](https://pmc.ncbi.nlm.nih.gov/articles/PMC6082524/)
   Risk-adjusted monitoring: each patient's expected outcome comes from a risk model
   (SAPS II, a logistic model), and the chart follows observed-minus-expected. **This is the
   right answer to "our mortality rose but so did our case-mix"** — the objection any
   clinician raises within thirty seconds of seeing a raw mortality chart. VLAD is
   interpretable ("lives saved vs. expected"); RA-CUSUM detects faster. See §6(d).

### 2.4 Reference texts

9. **Provost & Murray, *The Health Care Data Guide* (2nd ed., 2022)** — the IHI practitioner
   bible; chart selection, worked healthcare cases, and the standard on annotating charts
   with the interventions that explain a shift.
10. **Montgomery, *Introduction to Statistical Quality Control*** — the industrial reference
    for the underlying theory (EWMA and CUSUM design, ARL). Consult, don't read cover to cover.

---

## 3. The theory in one page

**The core claim.** Every process varies. **Common-cause** variation is the process's own
noise; **special-cause** variation is a signal that something changed. A control chart draws
the boundary between the two, so you act on signals and leave noise alone. Reacting to noise
("tampering", Deming's funnel experiment) provably *increases* variation — which is why
month-on-month percentage comparisons in a management report are worse than useless.

**The construction.** Plot the statistic over time. Draw a **centre line** (its mean) and
**control limits** at ±L standard deviations, where the standard deviation is the *theoretical*
one for that statistic's distribution, not the empirical scatter of the points. L = 3 is the
Shewhart convention — not a significance test, but an economic trade-off between false alarms
and missed signals (≈1/370 false-alarm rate per point under normality).

**The one distinction that matters most.** The sigma is derived from a **distributional model
of the count**, and the model follows from what you are counting:

| Statistic | Model | Variance |
|---|---|---|
| Proportion (events / cases) | Binomial | `p(1-p)/n` |
| Rate (events / exposure-time) | Poisson | `λ/n` |
| Measurement (mean, median) | Gaussian | `σ²/n` |
| Time between rare events | Geometric / exponential | `m(m+1)` |

Pick the wrong model and the limits are wrong in a way no amount of plotting fixes. This is
why the plugin's first configuration question must be *what kind of number is this* — §6(a).

**Limits vary with n.** A month with 40 admissions gets wider limits than one with 400. The
limits are a staircase, not a pair of horizontal lines. A chart drawn with flat limits over
varying denominators is misleading, and it is the single most common error in hand-made
hospital charts.

**Phase I vs Phase II.** Phase I: you have a stable baseline and you *estimate* the limits from
it. Phase II: you *freeze* those limits and judge new data against them. Recomputing the limits
every time new data arrives means a slow drift silently moves the limits along with it — the
chart absorbs the very deterioration it exists to detect. The existing EWMA script gets this
right (`calibration_until` / `calibration_months`); the plugin must keep it and make it visible.

**Runs rules.** A point outside the limits is one signal. Non-random *patterns* inside them
are another: a long run on one side, a monotone trend, too few crossings of the centre line.
Each added rule raises sensitivity and lowers specificity — with enough rules, a stable process
alarms constantly. This is why we adopt the Anhøj rules (reference 3), whose thresholds scale
with series length, rather than stacking all eight Western Electric rules.

---

## 4. Which chart, when

The decision tree, in the order the plugin should ask it:

```
What are you plotting?
├─ A MEASUREMENT (LOS, SAPS II, weight, delay)
│   ├─ one value per period, or you want individual points  → I-MR (XmR)
│   └─ several per period, you plot the mean                → Xbar-S
│       └─ you want to detect a SMALL persistent shift      → EWMA  or  CUSUM
├─ A PROPORTION (deaths / admissions, % compliance)
│   ├─ ordinary denominators                                → p-chart
│   └─ large denominators (n ≳ 300–500/period)              → P′ (Laney)
├─ A RATE per exposure (VAP / 1000 ventilator-days)
│   ├─ ordinary                                             → u-chart
│   └─ large exposure, overdispersed                        → U′ (Laney)
├─ A COUNT with a constant denominator                      → c-chart
├─ A RARE EVENT (a few per year)
│   ├─ count cases between events                           → g-chart
│   └─ measure time between events                          → t-chart
└─ COMPARING UNITS rather than following time               → funnel plot
```

Notes that decide real cases:

- **Rare events are the trap.** A "VAP rate per 1000 days" computed on 2 events/month is
  noise plotted with authority. Below ~5 events per period, move to a g/t chart: it follows
  the *interval between* events, and the line going **up** means improvement. This is exactly
  why `micu-clip` uses a g-chart for CLABSI and unplanned extubations.
- **EWMA vs CUSUM vs Shewhart.** Shewhart is best at big abrupt shifts (>2σ) and is the most
  readable. EWMA and CUSUM detect small sustained shifts (0.5–1σ) far sooner, at the cost of
  a line that no longer shows the raw data. EWMA with λ=0.2 is the practical default and what
  both existing projects use; CUSUM detects marginally faster but is harder to read for
  clinicians. **Ship EWMA before CUSUM.**
- **λ (EWMA)**: 0.2 is the convention (0.05–0.3 sensible). Small λ = more memory, slower to
  react to a real jump, better at tiny drifts. **L**: the existing scripts use 1.96 with EWMA
  (≈95%), which is more sensitive than Shewhart's 3 — appropriate, since EWMA's smoothing
  already suppresses noise. Keep 3 for Shewhart-family charts.

---

## 5. Formulas to implement

Consolidated from Mohammed 2008 and the two existing scripts, so the implementation has one
reference. `ȳ` = centre line, `n_t` = denominator of period *t*, `L` = limit width in sigmas.

| Chart | Centre | σ(t) | Limits |
|---|---|---|---|
| **p** | `Σy/Σn` | `√(p̄(1-p̄)/n_t)` | `p̄ ± Lσ`, clamped to [0,1] |
| **P′** (Laney) | as p | `√(p̄(1-p̄)/n_t) · σ_z` | as p, with `σ_z` = the MR-based SD of the z-scores (see below) |
| **u** | `Σy/Σn` | `√(ū/n_t)` | `ū ± Lσ`, LCL clamped to 0 |
| **U′** (Laney) | as u | `√(ū/n_t) · σ_z` | as u |
| **c** | `ȳ` | `√(c̄)` | `c̄ ± Lσ`, LCL clamped to 0 |
| **I (XmR)** | `mean(y)` | `MR̄ / 1.128` | `ȳ ± Lσ` |
| **MR** | `MR̄` | — | `UCL = 3.267·MR̄`, `LCL = 0` |
| **Xbar-S** | `Σ(n_t·ȳ_t)/Σn_t` | `s̄/(c₄(n_t)·√n_t)` | staircase |
| **g** | `mean(gaps)` | `√(m(m+1))` | `LCL = max(0, ·)`; UCL rarely useful |
| **t** | on `Y = T^(1/3.6)` | `MR̄(Y)/1.128` | limits computed on `Y`, then raised to the power 3.6 |
| **np** | `n̄·p̄` | `√(n̄·p̄(1-p̄))` | constant limits (requires roughly equal `n`) |
| **EWMA** | Phase-I mean or a target | `√(λ/(2-λ)·(1-(1-λ)^{2t})·v_t)` | recursive, see below |

The **t-chart** (Nelson 1994) is the continuous sibling of the g-chart: it charts the *time*
between rare events rather than the count between them, normalising via `Y = T^(1/3.6)` and
back-transforming the limits. **The NeoCLIP u-chart script already implements it** (along with
`p`, `np` and `c`) — none of the 19 widgets use it, because reaching it means editing a string.

**Laney's `σ_z`** — the whole point of P′/U′. Compute `z_t = (p_t - p̄)/σ_t` (the ordinary
binomial/Poisson sigma), then `σ_z = MR̄(z)/1.128`, the moving-range SD of that z series. If
the data are exactly as dispersed as the binomial predicts, `σ_z ≈ 1` and P′ = p. Overdispersed
data give `σ_z > 1` and proportionally wider limits. **It costs ~10 lines and removes the
single worst failure mode of hospital p-charts.**

**EWMA recursion** (as implemented in `spc_ewma_pavm.R`, which is correct):

```
z_t   = λ·y_t + (1-λ)·z_{t-1},          z_0 = centre
var_t = λ²·v_t + (1-λ)²·var_{t-1},      var_0 = 0
UCL/LCL = centre ± L·√var_t
```

where `v_t` is the per-period variance from the model in §3 (`p̄(1-p̄)/n_t` for a proportion,
`λ̄·basis/n_t` for a rate, `σ²/n_t` for a measurement). Using the *exact* recursive variance
rather than the asymptotic form is what makes the first few points' limits correctly wider.

**CUSUM** (if we ship it): `S⁺_t = max(0, S⁺_{t-1} + (y_t - (μ₀ + k)))`, mirrored for `S⁻`,
with `k = δσ/2` (δ = shift to detect, conventionally 1σ → `k = 0.5σ`) and decision interval
`h = 4σ` or `5σ`. Report in σ units so `h` is interpretable.

**Anhøj runs rules** (on the points, against the centre line):
- **Longest run**: a run of more than `round(log₂(n) + 3)` consecutive points on the same side.
- **Crossings**: fewer crossings of the centre line than the 5th percentile of the binomial
  distribution of crossings for that n.

Both scale with series length, unlike the fixed "8 in a row". The existing scripts use fixed
`run_len = 6` for both shift and trend — worth replacing.

**Denominators for rates** — the existing scripts already implement four modes, and all four
should carry over. Ranked by subtlety:

1. **`proportion`** — `n` = number of stays in the period. Binomial.
2. **`incidence_rate`** — `n` = `Σ exposure_var`, a per-stay duration already computed.
3. **`patient_days_overlap`** — patient-days by **clipping each stay to the period window**
   (`Σ max(0, min(discharge, period_end) - max(admission, period_start) + 1)`), the NHSN
   definition. A 90-day stay contributes to three consecutive months. Summing a per-stay
   length into the stay's admission month is a different and wrong number for long stays.
4. **`device_days`** — the same overlap computation but on **device** start/end
   (line insertion → removal) rather than admission → discharge. This is the correct
   denominator for CLABSI and VAP, where the population at risk is "patients with a line
   in place", not "patients present".

**Mode 4 exists in exactly one widget.** It was added in the CLABSI fork (widget 27) with four
extra parameters (`device_start_var`, `device_end_var`, `device_id_prefix`, `device_filters`),
and the other 18 u-chart widgets never received it. It is the single strongest argument for the
plugin: a correct denominator, written once, that is currently stranded in one string blob.

One operational note the script itself carries and the plugin must honour: with an overlap
denominator, **the dataset must not be pre-filtered to the event rows** — the numerator is
filtered internally, but the denominator needs every stay. That is what
`denom_on_full_dataset` does, and it is a genuine footgun to surface in the UI rather than
leave as a boolean nobody understands.

---

## 6. Decisions I need from you

**(a) Scope of the first version.** My recommendation: **one plugin, `linkr-analysis-spc`**,
with a `chartType` select, rather than one plugin per chart. Rationale: the config is ~80%
shared (data columns, period, phase, rules, style), the chart choice is genuinely a *decision*
the user should be able to change and immediately re-render, and a "SPC" entry in the widget
picker matches how clinicians think. `visibleWhen` (already in `PluginConfigField`) hides the
irrelevant fields per chart type. The cost: one big manifest.

Which charts in v1? I would ship **p, P′, u, U′, c, I-MR, EWMA, g** and defer **Xbar-S, t,
CUSUM, funnel**. That covers every indicator in `INDICATEURS_CANDIDATS.md` and both existing
projects, and it closes the "p-chart / u-chart / CUSUM not implemented" note in that file for
everything except CUSUM.

**(b) Auto-detection vs explicit choice.** The existing script *guesses* whether `y_var` is
numeric and switches model accordingly. I would rather make the **statistic type explicit**
(proportion / rate / measurement / rare event) and let it *suggest* the chart type.

**This is no longer a preference — the auto-detection is actively misfiring in production.**
The script branches on `is_numeric` **first**, and only consults `denominator` when the column
is categorical. So in the NeoCLIP dashboard, **18 of the 20 EWMA widgets set a `denominator`
that is silently ignored**: widgets 61-63 and 67-70 declare
`denominator = "patient_days_overlap"` alongside a numeric `y_var = "vent_duration_days"`, and
get an x-bar chart on the median ventilation duration instead of the events-per-patient-day
rate their title promises. Only widgets 37 and 38 (`growth_anomaly_birth`, `death_status`)
actually exercise the proportion branch. A user set an option, the chart rendered, nothing
warned, and the statistic is not the one asked for.

That is the argument for making the statistic type the **first, explicit** field, and for the
plugin to refuse (or warn on) an incoherent combination rather than silently picking a branch.
Tell me if you would rather keep the auto-detection for continuity — but note that migrating
those 18 widgets will change their numbers, which is a conversation to have with their readers.

**(c) Phase I / Phase II defaults.** The scripts default to `calibration_until = "auto"` with
12 months. Options: keep that, default to using all data (no freeze, simplest, less correct),
or require an explicit baseline. I lean toward **"all data" as the default with a visible
"freeze limits after ⟨date⟩" control**, because a silent 12-month split surprises people —
but the existing behaviour has a year of field use behind it, so tell me if you'd rather keep it.

**(d) Risk adjustment.** Genuinely valuable in ICU (the case-mix objection is immediate and
correct), but it needs an expected-risk column per row — i.e. the user must have already fitted
a model, or we point at a SAPS II-derived expected mortality. I propose **v1 accepts an optional
"expected value" column** and, when present, charts observed-minus-expected (VLAD-style) —
without fitting any model ourselves. Fitting is a `regression`-plugin job. Agree?

**(e) Server parity.** Every component plugin has a Python twin in
`apps/api/app/services/execution/render/` and a `kind` in its `_BUILDERS` allow-list. SPC means
another ~400 lines of Python held in parity with the TS. It is the house pattern and I'd follow
it — but confirm, since it is roughly a third of the work.

**This one is less optional than it looks.** In server mode the component receives
**`rows` empty** (`ComponentPluginProps`, `component-registry.ts:5-28`) — only `columns` is
populated. And a component registered without `supportsServer: true` is **not mounted at all**
in server mode; the user gets `datasets.component_server_unavailable` instead
(`ComponentAnalysisShell.tsx:229-234`). So "client-only" does not mean "works everywhere with
less code" — it means **the widget is blank for every server-mode deployment**, which is the
portal deployments. The real choice is: dual implementation (TS + Python, as all nine plugins
do), or server-only with a placeholder in WASM builds. I recommend the dual implementation:
the maths is pure arithmetic, no scipy, and the TS half is what makes the static portal work.

---

## 7. Proposed configuration

Following the house grammar (`Data → ⟨domain⟩ → Style`, `row` to pair fields, standard
`colorPalette` / `color-select` / `cardIcon` in Style). Sections and naming deliberately mirror
`kaplan-meier` and `plot-builder`.

| Section | Field | Type | Notes |
|---|---|---|---|
| **Data** | `statisticType` | select | proportion · rate · measurement · rare event → drives everything |
| | `dateColumn` | column-select | the time axis |
| | `period` | select | day/week/month/quarter/year, `row: timeRow` |
| | `valueColumn` | column-select | the measured/counted variable |
| | `eventValues` | column-value-select | `columnField: valueColumn` — which modality counts as the event (categorical only, `visibleWhen`) |
| | `denominatorMode` | select | cases · exposure column · patient-days overlap, `visibleWhen` statisticType ∈ {proportion, rate} |
| | `exposureColumn` | column-select | `visibleWhen` denominatorMode = exposure |
| | `admissionColumn` / `dischargeColumn` | column-select | `row`, `visibleWhen` denominatorMode = overlap |
| | `rateBasis` | number | 1000 by default, `row` with `rateUnitLabel` |
| | `deduplicateBy` | column-select | one row per stay (`visit_id`) — the scripts all do `distinct(visit_id)` |
| | `expectedColumn` | column-select | optional; enables risk-adjusted mode — decision (d) |
| **Chart** | `chartType` | select | auto · p · P′ · u · U′ · c · I-MR · EWMA · g |
| | `limitSigma` | number | L, default 3 (1.96 when chartType = EWMA via `setFieldsOnChange`) |
| | `lambda` | number | `visibleWhen` chartType = EWMA, default 0.2 |
| | `target` | number | optional fixed centre line instead of the estimated one |
| | `baselineMode` | select | all data · freeze after date · first N periods — decision (c) |
| | `baselineUntil` | string | date, `visibleWhen` baselineMode = freeze |
| **Rules** | `runsRules` | select | none · Anhøj (default) · fixed run length |
| | `runLength` | number | `visibleWhen` runsRules = fixed |
| | `highlightSignals` | boolean | colour out-of-limit points |
| **Style** | `title`, `yLabel` | string | |
| | `showLimits` / `showCentre` / `showRawData` | boolean | `row` — raw points behind the EWMA line |
| | `showGrid`, `centerTitle` | boolean | `row`, house standard |
| | `colorPalette`, `signalColor`, `cardColor`, `bgColor`, `titleColor`, `cardIcon` | palette/color/icon-select | house standard, copy from `plot-builder` |

Icon: `Activity` is taken by kaplan-meier; **`LineChart` or `TrendingUpDown`**, colour `amber`
or `sky` (unused among the nine). i18n: labels live in `plugin.json` (`{en, fr}`), not in
`locales/*.json`.

### 7.1 Constraints of the config system (verified against the code)

`PluginConfigField` (`apps/web/src/types/plugin.ts:12-94`) and the renderer
(`GenericConfigPanel.tsx`, the `type` switch at lines 378-527) impose things the table above
has to respect:

- **`filter` has only `numeric` and `categorical` — there is no `date`.** So `dateColumn`
  cannot be filtered to date columns; it must accept any column and validate at compute time.
  This is a real papercut for an SPC plugin, whose first field *is* a date.
- **`visibleWhen` is the only conditional mechanism** (no `dependsOn`/`visibleIf`), an array is
  **AND**, and the only "or" is `values: [...]` on one field. Comparison is strict `===`.
  Watch out: `notEmpty` does **not** reject an empty array, so it is useless on a multi
  `column-select`. A hidden field keeps its stored value.
- **`step` is not supported on `number`** — `plot-builder`'s `"step": 0.5` is a dead key
  (manifests are cast, not validated, so an invented key is silently ignored). `min`/`max` are
  HTML attributes with **no programmatic clamp**: λ and L must be validated in compute and in
  `validate_spec`.
- **`boolean` and `palette-editor` do not render `description`/`hint`** — they bypass
  `FieldLabel`. Any explanation attached to a checkbox is invisible; put it on a neighbouring
  field or in the section.
- **`hint` matching `/required|requis/i` is what colours the badge amber** — that is the whole
  "required" mechanism, exactly as `kaplan-meier` uses it.
- **Sections merge only when consecutive**; two same-named sections separated by another
  section render as two accordions. `defaultOpen` must be *explicitly* `false` to start closed.
- **`orderable` is hardwired to a config key literally named `variableOrder`**
  (`GenericConfigPanel.tsx:753`) — reuse that name or the reorder panel never appears.
- Reserved keys: **never declare `__widthPct` / `__heightPct`**, the shell owns them.

Two types the table can use that I had not listed: **`column-value-select`** (distinct values
of the column named by `columnField` — and it fetches them server-side when `rows` is empty,
which is exactly what `eventValues` needs) and `concept-select` (warehouse-only).

---

## 8. Implementation checklist (once §6 is arbitrated)

Derived from how `survey-question` and `kaplan-meier` were added:

1. `packages/default-plugins/analyses/spc/plugin.json` — manifest. `runtime: ["component"]`,
   `languages: []`, and `componentId` on the registration: **both are required** for
   `AnalysesPanel.tsx:41` to route to the component shell.
2. `apps/web/src/features/projects/lab/datasets/analyses/SpcComponent.tsx` — the component.
3. `apps/web/src/features/projects/lab/datasets/analyses/spc-server.ts` — the spec builder
   (house convention: one `*-server.ts` per component, carrying a comment naming its Python twin).
4. `apps/web/src/lib/plugins/default-plugins.ts` — `registerComponent('spc', () => import(…), { supportsServer: true })`
   + `registerPlugin({ manifest, templates: null, componentId: 'spc' })`, and the manifest import.
   **The loader must stay lazy** (recharts must not enter the initial bundle).
5. `apps/web/src/lib/plugins/builtin-widget-plugins.ts` — add `linkr-analysis-spc` to `SYSTEM_PLUGIN_IDS`.
6. `apps/api/app/services/execution/render/spc.py` — `validate_spec` + `build_code`; register the
   `"spc"` kind in that package's `__init__.py` `_BUILDERS`. `build_code` returns Python that
   **prints JSON on stdout** in the same shape the TS computes.
7. **Pure compute in its own module** (`lib/spc/`), not in the `.tsx` — it is exactly the
   "pure, critical logic" the test rule names. Unit-test the limit formulas against
   `qicharts2` output for a fixed series.
8. `.claude/skills/create-project/{references/dashboards.md, assets/build_zip.py}` —
   `PLUGIN_COLUMN_KEYS`, per the comment in `default-plugins.ts:40`.
9. `docs/ui-patterns.md` if any new shared UI appears (it should not).
10. Website docs — `../linkr-website`, per CLAUDE.md, once the feature is user-visible.

### 8.1 The component contract (what the props do and do not give)

`ComponentPluginProps` — `apps/web/src/lib/plugins/component-registry.ts:5-28`:

```ts
{ config, columns, rows, compact?, datasetFileId?, datasetFilters?, onConfigChange? }
```

What is **not** there, and must therefore be handled inside the component:

- **No theme prop** — use Tailwind `dark:` and the shared helpers in
  `lib/plugins/shared-styles.ts` (`CHART_PALETTES`, `resolvePalette`, `resolveColor`,
  `TOOLTIP_STYLE`, `getLucideIcon`). Reuse these rather than defining SPC colours: the
  signal red/orange should come from `COLOR_MAP`.
- **No loading/error prop** — own `useState` around `renderOnServer`, and handle all four
  states: loading, `out.stderr` (errors arrive there, not as a throw), unparsable JSON,
  and a `null` result.
- **No size prop** — fill `h-full w-full`; the shell owns sizing through its reserved keys.
- **`onConfigChange` is optional and absent in dashboard widgets** — any in-chart control
  (e.g. clicking a point to freeze the baseline) must degrade to read-only without it.
- **Defaults are merged by the config *panel*, not the shell** — so read every option as
  `(config.x as T) ?? fallback`, as `KaplanMeierComponent.tsx:850-864` does.

The dual-path pattern to copy verbatim (`KaplanMeierComponent.tsx:869-901`): compute locally
via `useMemo` when `!isServerMode()`, build a spec and `renderOnServer('spc', spec, …)` when in
server mode, then `const result = server ? serverResult : localResult`. Both halves must return
the same result shape. Results are cached per `(kind, project, dataset, filters, spec)`;
the shell's Run button clears that cache and forces a remount.

Then migrate: the NeoCLIP dashboard's 20 inline widgets become 20 plugin widgets with a config
each, and `micu-clip`'s two `_sources` scripts get deleted in favour of the plugin. That
migration is the real acceptance test.
