# Plot Builder

One plugin for the everyday charts: scatter, line, bar, histogram, boxplot,
violin. The point of having them together is that switching between them is a
single setting — and switching is often the honest answer when a chart is not
saying what you thought it said.

## Which plot answers which question

The plot type is not a style choice. It follows from the question.

| Your question | Plot type | What you give it |
| --- | --- | --- |
| How is this variable distributed? | Histogram | X = the numeric variable |
| Do these groups have different distributions? | Boxplot, or Violin | X = the groups, Y = the numeric variable |
| Are these two numbers related? | Scatter plot | X and Y, both numeric |
| How does this change over time? | Line plot | X = date or time, Y = the value |
| How many, per category? | Bar chart | X = the category, Y left empty |
| What is the average per category? | Bar chart | X = the category, Y = the numeric value |

A bar chart with an empty **Y variable** counts rows; with a Y it averages that
column per category — not sums it. Bar charts keep at most 30 categories, boxes
and violins at most 20; beyond that the chart is unreadable anyway, so aggregate
your categories upstream rather than hoping the chart sorts it out.

## One row per patient, or one row per measurement?

> [!WARNING]
> **The unit of your rows is the unit of your chart.** A dataset with 40
> creatinine values per patient plotted straight into a histogram describes
> *measurements*, not *patients* — and the sickest patients, who are sampled
> most, count 40 times over. Set **Unique per** to your patient or stay
> identifier first, and pick a **Per-entity function**, so the chart describes
> the population you think it describes.

**Unique per** collapses the rows to one per entity before anything else
happens — before missing values are dropped, before outliers are excluded.
**Per-entity function** decides how:

- **First value** / **Last value** keep an entire original row, in the order the
  rows arrive in the dataset. Use them for attributes that are constant across a
  patient's rows (age, sex, admission unit) — or sort your dataset by date
  upstream if you mean "the last measured value", because the plugin does not
  sort for you.
- **Mean**, **Median**, **Min**, **Max**, **Sum** reduce every numeric column of
  the group. `Max` on a SOFA score gives worst-severity-per-stay; `Mean` on a
  lactate gives an average exposure. Non-numeric columns keep the first row's
  value.

Choosing between them is a clinical decision, not a technical one, and it should
appear in your methods: "worst SOFA in the first 24 h" and "mean SOFA over the
stay" are different variables with different distributions.

## Reading a boxplot, and when to use a violin

The box spans the first to the third quartile — the middle half of your data.
The white line inside it is the **median**, not the mean. The whiskers extend to
the furthest value still within 1.5 × the interquartile range of the box, and
stop at the actual data if it stops sooner.

That construction is what makes a boxplot useful: box height is spread, the
median's position inside the box is skew, and whisker length is tail behaviour.
It is also what makes it dangerous — a boxplot shows five numbers and hides
everything else. **Two very different distributions can produce the same box.**
The classic case is a bimodal variable: a group split between short and very
long stays gets a box centred on a length of stay that almost nobody actually
had.

The **Violin** plot draws the estimated density instead, so a two-humped
distribution looks like two humps. Reach for it whenever the groups are large
enough to estimate a shape (a handful of points produces a smooth curve that is
pure invention), and stay with the boxplot for compact side-by-side comparison
of many groups.

Neither shows you *n*. With small or unequal groups, put the counts in the
title or the axis labels — a comparison of 8 patients against 400 deserves to
look like one.

## Histograms: the bins decide the story

**Bins** (the default, 20 of them) splits the observed range into that many
equal slices. **Bin width** instead fixes the width and aligns the edges on
round multiples of it — pick this one whenever the width has meaning: 1 day for
a length of stay, 5 years for an age, 0.5 for a lactate.

The number of bins is a real analytical choice, not decoration:

- **Too many** and every bin holds a few patients; random ups and downs look
  like structure, and you start explaining noise.
- **Too few** and genuine structure disappears. A single wide bin can absorb an
  entire second mode.

Try two or three settings before believing any shape. If a feature survives
different bin widths it is probably real; if it moves or vanishes, it was the
binning. Drag across the chart to zoom into a range — the values inside are
re-binned, so a long tail stops crushing the interesting part.

A non-numeric X column is not binned at all: the histogram falls back to
counting each distinct value, sorted from most to least frequent.

## Excluding extreme values

**Exclude outliers** drops rows before plotting, by one of three rules applied
to the numeric axes:

- **IQR (Tukey)**, threshold 1.5 — outside Q1 − 1.5·IQR … Q3 + 1.5·IQR. The
  default, and the one that adapts to a skewed distribution.
- **Standard deviation**, threshold 3 — outside mean ± 3 SD. Assumes something
  roughly symmetric; on a length of stay it will cut the right tail and nothing
  on the left.
- **Percentiles**, threshold 1 — keeps the 1st to the 99th percentile. It always
  removes the same *proportion* of your data, whatever the data looks like.

Use it to stop a data-entry error (a weight of 700 kg, a heart rate of 9000)
from flattening the whole chart. Do not use it to make a distribution look
better behaved: in intensive care the extreme values are frequently the patients
the analysis is about. The plugin prints "*n* outliers excluded" under the
chart — quote that number wherever the chart goes, and say which rule produced
it.

Note that the fences are computed *after* **Unique per**, on the per-entity
values. That is the right order, but it means changing the aggregation changes
which rows are excluded.

## Axes that do not start at zero

By default the axes fit the data, rounded outward to the next round tick.
**X axis starts at 0** and **Y axis starts at 0** force the origin in.

The rule of thumb: **bar length encodes a quantity, position does not.** A bar
chart truncated at the bottom multiplies apparent differences by an arbitrary
factor, which is why bar charts here always start their value axis at zero. On a
scatter plot or a line, a zoomed axis is legitimate and often necessary — nobody
wants a temperature chart running from 0 °C — as long as the axis is labelled
and the reader can see the range.

## A worked example

*Do patients admitted for sepsis stay longer than the others?*

One row per ICU day, with a stay identifier, a length of stay, and an admission
category.

1. **Plot type** → Boxplot.
2. **Unique per** → the stay identifier, **Per-entity function** → *First
   value*. Length of stay is a stay-level attribute repeated on every daily row;
   without this the chart weights each stay by its own length, which is exactly
   the variable being studied.
3. **X variable** → admission category, **Y variable** → length of stay.
4. **Exclude NA / missing** stays on; leave **Exclude outliers** on *Keep all*
   for a first look, so you can see the long tail before deciding anything.

The boxes will be strongly right-skewed — medians low in the box, long upper
whiskers. That is normal for a length of stay and is itself the finding: the
mean is a poor summary here, and the median is the number to report.

Then switch **Plot type** to *Violin*. If a group shows two humps, you are
probably looking at two populations mixed together — for instance rapid deaths
and slow recoveries — and the median of that group describes neither. That is a
question a boxplot would never have raised.

## Further reading

- [Weissgerber TL et al., *Beyond bar and line graphs*](https://journals.plos.org/plosbiology/article?id=10.1371/journal.pbio.1002128) — why summary bars hide the data, with the alternatives.
- [Krzywinski M & Altman N, *Visualizing samples with box plots*](https://www.nature.com/articles/nmeth.2813) — what a box does and does not show.
- [Streit M & Gehlenborg N, *Bar charts and box plots*](https://www.nature.com/articles/nmeth.2807) — when each is appropriate.
- [Cleveland WS & McGill R, *Graphical perception*](https://www.jstor.org/stable/2288400) — the experiments behind "position beats length beats area".
