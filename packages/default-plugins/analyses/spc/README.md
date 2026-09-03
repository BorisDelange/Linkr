# Control chart (SPC)

A control chart separates the noise a process always has from a signal that
something actually changed — so a team acts on the signals and leaves the noise
alone.

This matters more than it sounds. Reacting to ordinary variation ("this month is
up 3%, what happened?") provably *increases* variation rather than reducing it.
Month-on-month comparisons in a management report are not a weaker version of a
control chart; they are worse than doing nothing.

## What the chart shows

Your indicator is plotted over time, with:

- a **centre line** — the process average over the baseline,
- **control limits** above and below it, at ±3 standard deviations by default,
- **flagged points**, drawn on top, where the data signals a real change.

The limits are not "the highest and lowest we have seen". They are computed from
a statistical model of your indicator, which is why the plugin asks first what
kind of number it is.

### Why the limits move up and down

A month with 40 admissions is noisier than a month with 400, so it gets wider
limits. The limits follow each period's denominator and are drawn as a
**staircase**, not two flat lines.

Flat limits over a varying denominator is the single most common error in
hand-made hospital charts: quiet months look out of control, busy months hide
real signals.

## Choosing the chart

**What is being charted** is the first setting because it picks the variance
model — and so the limits themselves. Left on *Auto*, the plugin infers it from
your data and tells you what it inferred.

| Your indicator | Setting | Chart |
| --- | --- | --- |
| Deaths / admissions, % compliance | Proportion | `p` (or `P′` on large denominators) |
| VAP per 1000 ventilator-days | Rate | `u` (or `U′`), `c` if the denominator is constant |
| Length of stay, SAPS II, a delay | Measurement | `I-MR`, or `EWMA` for slow drifts |
| A few events per year | Rare event | `g` (cases between) or `t` (time between) |

Leaving **Chart type** on *Auto* as well lets the plugin pick within that family.

### Three choices that decide real cases

> [!WARNING]
> **Rare events are the trap.** A "VAP rate per 1000 days" computed on 2 events a
> month is noise plotted with authority. Below roughly 5 events per period, use a
> **g-chart**: it follows the *interval between* events, and the line going **up**
> means things are improving. This is why CLABSI and unplanned extubations are
> normally charted this way.

**Large denominators overdisperse.** Past roughly 300–500 cases per period, a
p-chart's limits get so tight that almost every point is flagged. That is the
chart failing, not the process. Switch to **P′ / U′** (Laney), which corrects for
it — the plugin warns you when it sees this.

**Small drifts need EWMA.** A Shewhart chart (`p`, `u`, `c`, `I-MR`) is best at
big abrupt shifts and is the easiest to read. **EWMA** detects small sustained
drifts (0.5–1σ) far sooner, at the cost of a line that no longer shows the raw
data. λ = 0.2 is the convention; smaller means more memory and slower reaction to
a genuine jump.

## The baseline

Limits are estimated from a **baseline** period, then **frozen** and used to judge
everything after it. A dashed marker shows where the baseline ends.

This is the point of the chart. If the limits were recomputed every time new data
arrived, a slow deterioration would drag the limits along with it — and the chart
would quietly absorb the very problem it exists to detect.

By default the whole series is the baseline. Set **Baseline until** to a date once
you have a period you consider stable.

## Reading a signal

A point outside the limits is one kind of signal. Non-random *patterns* inside
them are another: a long run on one side of the centre line, or too few crossings
of it.

The default **Anhøj rules** scale their thresholds with the length of the series.
This is deliberate: every rule you add raises sensitivity and lowers specificity,
and a chart with all eight Western Electric rules stacked on alarms constantly on
a perfectly stable process.

A signal means *look*, not *act*. It says the variation is unlikely to be chance
— finding the cause is still your job.

## Warnings the widget may show

These are surfaced rather than hidden, because each one means the numbers on
screen may not mean what they appear to:

- **Too few periods** — limits estimated on a short series are themselves
  unreliable. Aim for 20+ periods before trusting them; 12 is a bare minimum.
- **Events too rare for a rate** — move to a g/t chart, as above.
- **Overdispersion** — your denominators are large; use `P′`/`U′`.
- **Denominator cannot apply** — the denominator chosen makes no sense for the
  statistic (e.g. an exposure column on a measurement chart).

## A worked example

*Are we seeing more central-line infections than usual?*

You have one row per infection episode, with an admission date, and a separate
count of line-days per month.

1. **What is being charted** → Rate. Infections per 1000 line-days is a rate over
   exposure time, not a proportion of cases.
2. **Date column** → the episode date. **Period** → Month.
3. **Denominator** → Exposure column → your line-days column. **Rate basis** →
   1000, so the y-axis reads "per 1000 line-days".
4. **Baseline until** → the end of last year, if that year was stable.

The plugin draws a u-chart with limits that widen in low-activity months. If it
warns that events are too rare, switch **What is being charted** to *Rare event*:
with a handful of infections a year, the interval between them is the honest
measure, and a rising line is good news.

## Further reading

- [Mohammed MA et al., *Plotting basic control charts*](https://qualitysafety.bmj.com/content/17/2/137) — the standard tutorial.
- [Anhøj J, *Diagnostic value of run chart analysis*](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0121349) — the runs rules used here.
- [Laney DB, *Improved control charts for attributes*](https://doi.org/10.1081/qen-120003555) — the P′/U′ correction.
- [Provost & Murray, *The Health Care Data Guide*](https://www.wiley.com/en-us/The+Health+Care+Data+Guide%3A+Learning+from+Data+for+Improvement%2C+2nd+Edition-p-9781119690139) — the reference textbook.
- [NHS England, *Making data count*](https://www.england.nhs.uk/publication/making-data-count/) — SPC for improvement teams, with worked examples.
