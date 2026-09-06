# Key Indicator

One number, large, with an icon, a subtitle and an optional mini-chart. Mortality
rate, mean length of stay, number of stays, proportion ventilated — the figures a
dashboard opens with and that get quoted in a meeting an hour later.

The plugin is simple. Making the number *mean* something is not, and that is
what this page is about. A KPI is the most compressed form a result can take: it
throws away the distribution, the denominator, the period and the uncertainty,
and leaves a single figure that reads as a fact. Everything a careful analysis
does — stating what was counted, over whom, when — has to be put back by hand,
in the title and the subtitle, because the number itself cannot carry it.

Used well, it is the fastest way to give a service its own figures. Used badly,
it is the fastest way to publish a wrong one.

## What you need

A tabular dataset and a **Column**. Picking one sets sensible defaults: a
numeric column starts on *Mean*, a categorical one on *Proportion (%)*.

- **Stat** is the statistic displayed: *Mean*, *Median*, *Min*, *Max*, *Sum*,
  *Count*, *Std dev*, *Q1*, *Q3*, *IQR*, *Proportion (%)*, or *None* to show the
  column's value with no aggregation. Only the options that make sense for the
  column's type are offered.
- **Target value** is which value to count, for *Count* and *Proportion (%)*.
  Left empty, *Count* counts all non-empty rows and *Proportion* auto-detects
  the most frequent value — convenient while exploring, and worth setting
  explicitly before anyone else reads the widget.
- **Exclude NA / empty** drops null, empty and NA values before computing. On by
  default: a mean over rows that do not exist is not a mean. Turning it off
  makes missing rows count as observations, which is almost never what you want
  and occasionally exactly what you want (counting completeness).
- **Unit**, **Decimals** and **Title** are the presentation. **Subtitle stats**
  adds context under the number — *n* by default, plus any of mean, median, SD,
  min, max, Q1, Q3, IQR.

The **Mini-chart** section adds a histogram, box plot, bar chart or pie beside
or below the value, and the **Style** section handles icon, colours, sizing and
centring.

## Unique per is what decides the meaning

**Unique per** groups rows by a column and reduces each group to one value
before the statistic is computed. **Per-entity function** says how: *First
value*, *Last value*, *Mean*, *Median*, *Min*, *Max*, *Sum*.

This is not a technical detail — it is the setting that determines what your
number is a number *about*. Take a dataset with one row per ICU day and a
`died` column repeated on each of a stay's rows:

| Configuration | What the number is | Typical value |
| --- | --- | --- |
| No **Unique per** | proportion of ICU *days* belonging to a stay that ended in death | inflated: long stays contribute many rows |
| **Unique per** = stay id, **Per-entity function** = *First value* | proportion of *stays* ending in death | the mortality rate people mean |
| **Unique per** = patient id, *Max* | proportion of *patients* who died at any point | lower N, different denominator again |

All three are computable, all three will render happily, and they can differ by
a factor of two. The first is not a mortality rate at all, but nothing on the
widget says so.

The same applies to any repeated measure. A mean lactate over 40 000 rows is a
mean per *measurement*, weighting the sickest patients — who are sampled most —
forty times over. Set **Unique per** to the stay identifier and **Per-entity
function** to *Max* and you have worst lactate per stay; set it to *Mean* and
you have average exposure. These are different clinical variables with different
distributions, and choosing between them is a clinical decision that belongs in
your methods.

*First value* and *Last value* keep a whole original row in the order the rows
arrive in the dataset — the plugin does not sort. If you mean "the last measured
value", sort your dataset by date upstream.

## A number with no denominator

> [!WARNING]
> **A bare percentage is the easiest way to mislead with real data.** "Mortality
> 33%" is compatible with 1 death out of 3 and 3300 out of 10 000, and only one
> of those is worth acting on. A KPI on a dashboard gets read at a glance,
> screenshotted, and quoted in a meeting where nobody can click into it — so if
> the denominator is not on the tile, it does not exist. Keep **Subtitle stats**
> showing *n*, and put the population and the period in the **Title**:
> "In-hospital mortality, ICU stays 2024 (n=812)" survives being quoted; "33%"
> does not. Beware in particular the tile that stays on a dashboard while its
> filters change underneath it: a percentage that was over 800 stays this
> morning can be over 11 this afternoon and look identical.

Small denominators do not just widen the uncertainty, they change what movement
means. With 20 stays, one extra death moves the rate five points, so a tile
"improving" from 20% to 15% may be one patient. If a KPI is being watched over
time to detect change, a single number is the wrong tool — that is what a
control chart is for, and it exists in Linkr as its own plugin precisely because
distinguishing signal from noise needs the series, not the latest value.

## The subtitle and the mini-chart are where the honesty goes

**Subtitle stats** exists to stop a single number from standing alone. Two
combinations earn their place on almost every tile:

- **n** on everything, always. It is the default, and turning it off should be a
  deliberate act.
- **Median** and **IQR** (or **Q1** and **Q3**) alongside a mean, whenever the
  variable is skewed. A mean length of stay of 8.4 days with a median of 5 days
  underneath tells the reader immediately that a few very long stays are pulling
  the headline figure — and in hospital data, assume skew until you have
  checked. Length of stay, ventilation duration, lactate, CRP, time to treatment
  and costs are all right-skewed almost by construction.

The mini-chart does the same job graphically. **Chart type** → *Histogram* under
a mean shows in one glance whether that mean describes anything real; a bimodal
shape means it describes nobody. *Box plot* is the compact version of the same
check. For a categorical column, *Bar chart* shows what the other categories
were, which a lone proportion hides entirely.

Set **Chart position** to *Side* when the tile is wide and *Below* when it is
tall, and use **Bins** on a histogram the way you would anywhere else: try two
or three values, and distrust a feature that only appears at one of them.

## A worked example

*What was our ICU mortality last year?*

One row per ICU day, with a stay identifier, a patient identifier, a vital
status repeated on every row of the stay, and a date.

1. **Upstream**, filter the dataset to the period — 2024 — so the tile cannot
   drift as data accumulates.
2. **Column** → the vital-status column. **Stat** → *Proportion (%)*, **Target
   value** → the value meaning death, set explicitly rather than auto-detected.
3. **Unique per** → the stay identifier, **Per-entity function** → *First value*.
   Without this you are computing the proportion of ICU *days* attributable to
   stays that ended in death, which is a larger and meaningless number.
4. **Exclude NA / empty** → on, so stays with an unknown outcome do not silently
   count as survivors. Note how many are excluded: if it is more than a handful,
   that missingness is itself the finding.
5. **Subtitle stats** → *n*. **Title** → "In-hospital mortality, ICU stays 2024".
   **Unit** → `%`, **Decimals** → 1.
6. **Chart type** → *Bar chart*, to show survivors against deaths rather than a
   percentage floating alone.

Read the tile as "of the 812 stays completed in 2024 with a known outcome,
21.4% ended in death". That sentence is defensible.

What would make it misleading: comparing it to another unit's figure, or to last
year's. A raw mortality rate is dominated by case mix — a unit taking more
severe patients has a higher rate and may be performing better — so a
comparison needs risk adjustment, not a second tile. And if the dashboard filter
lets a reader narrow to one admission category, the same tile can end up over
14 stays, where a change of one patient moves it seven points. Either fix the
population in the dataset, or make sure the *n* is visible enough that nobody
reads the percentage without it.

## Further reading

- [Donabedian A, *Evaluating the quality of medical care*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2690293/) — the structure / process / outcome framework, and why outcome indicators are the hardest to interpret alone.
- [Donabedian's classic article 50 years later](https://pmc.ncbi.nlm.nih.gov/articles/PMC4911723/) — what a half-century of quality measurement did and did not confirm.
- [Agniel D, Kohane IS & Weber GM, *Biases in electronic health record data due to processes within the healthcare system*](https://pmc.ncbi.nlm.nih.gov/articles/PMC5925441/) — why an indicator computed from routine data partly measures the data-collection process.
- [WHO, *Indicator metadata registry*](https://www.who.int/data/gho/indicator-metadata-registry) — how a health indicator is specified: numerator, denominator, period, exclusions. The model for what a KPI title should carry.
- [*The Book of OHDSI*, characterization](https://ohdsi.github.io/TheBookOfOhdsi/Characterization.html) — defining a cohort and its denominator reproducibly, which is the step before any indicator.
