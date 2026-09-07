## Introduction

A correlation matrix answers one question for every pair of variables at once:
when this one goes up, does that one tend to go up too, and how reliably?

It is an exploration tool. Used well, it is the fastest way to see the structure
of a table of numbers — which variables travel together, which are redundant,
where a model will run into collinearity. Used badly, it is a machine for
producing findings that were never there.

![A correlation heatmap of eight ICU variables, with one deep-red cell at 0.95
between CRP and ferritin.](attachments/output.png)

Above: the deep-red 0.95 between CRP and ferritin is the cell to act on — two
columns carrying the same information, so putting both into a regression would
make each coefficient unstable. Along the length-of-stay row, 0.35 with the
severity score is worth pursuing; the −0.05 with creatinine is not evidence
that creatinine is irrelevant, only that no *monotonic* relation shows here.

## Settings

Numeric columns, at least two of them. Identifiers start unticked in
**Variables** — a patient id correlates with nothing meaningful and only crowds
a grid that is square in the number of variables you keep.

Each pair is computed on the rows where **both** variables are present, so a
column with heavy missingness quietly contributes fewer pairs than its
neighbours. The header shows the total n; the pairs behind an individual cell
can be far fewer.

## Notes on the method

### What the coefficient measures

Each cell holds a coefficient between −1 and +1:

- **sign** — positive means both move the same way, negative means one rises as
  the other falls,
- **magnitude** — how tightly the points follow that trend. 1 is a perfect line,
  0 is no trend at all,
- the **diagonal** is every variable against itself, always exactly 1. It is
  drawn as neutral chrome because it carries no finding.

The matrix is symmetric: the cell above the diagonal and the one below it are
the same number.

### Pearson or Spearman

**Method** is the setting that changes what you are measuring, not just how it
is computed.

| | Pearson | Spearman |
| --- | --- | --- |
| Detects | straight-line relationships | any monotonic relationship |
| Works on | the values | the ranks of the values |
| Assumes | roughly normal, symmetric data | nothing about the shape |
| Outliers | one extreme point can create or destroy a correlation | barely moves it |

Health data is where this choice bites. Lengths of stay, ventilation durations,
lactate, CRP, ferritin — all strongly right-skewed, all with a long tail of
extreme values that are perfectly real. **Spearman is usually the safer default
for them.** Keep Pearson when the variables are near-symmetric (age, weight,
haemoglobin, a physiological pressure) or when you specifically want to describe
a linear relationship.

A useful habit: run both. When Pearson and Spearman disagree markedly, that gap
is itself the information — it means a few extreme points, or a curved
relationship, are driving one of the two numbers.

### Reading the heatmap

Colour carries the pattern, the number carries the magnitude. The scale runs
from blue at −1, through white at 0, to red at +1, so a block of strongly
coloured cells is visible before you have read a single figure.

That is what **Variable order** is for. In *Dataset order* the variables sit as
they do in the file; drag them into a *Custom* order that puts related ones side
by side — haemodynamics together, biology together, outcomes last — and families
of correlated variables show up as blocks.

**Show values** prints the coefficient in each cell, **Show significance** marks
those whose p-value falls under the **Significance level (α)**, with the usual
star convention (`*` p < 0.05, `**` p < 0.01, `***` p < 0.001).

There is no universal scale for "strong". In clinical data, r ≈ 0.7 between two
distinct measurements is already high, and anything above 0.9 usually means the
two columns are measuring the same thing twice.

### The traps

> [!WARNING]
> **A coefficient near 0 does not mean "no relationship" — it means "no *linear*
> relationship".** A U-shaped relationship gives r ≈ 0 while being a strong,
> clinically important effect: think of mortality against sodium, or against
> heart rate, where both extremes are dangerous and the middle is safe. The
> matrix will report nothing. Anscombe's quartet is the classic demonstration:
> four datasets that look nothing alike, all with the identical correlation
> coefficient. Plot the scatter before you believe a cell — in either direction.

**Correlation is not causation.** Two variables can move together because one
causes the other, because the other causes the one, or because a third variable
drives both. In a ward, severity drives almost everything, so almost everything
correlates with almost everything. A matrix ranks associations; it does not
explain them.

**Multiple comparisons.** A 10 × 10 matrix is 45 distinct tests. At α = 0.05,
you expect roughly two of them to be starred by pure chance even if no
relationship exists anywhere. At 20 variables it is 190 tests and about ten
false stars. Read the markers as "worth a look", never as a verdict — and if a
correlation is your actual hypothesis, test it on its own, prespecified.

**Sample size turns everything significant.** The p-value tests whether r
differs from zero, not whether it is large enough to care about. On n = 10 000,
an r of 0.03 — a relationship that explains 0.09% of the variance — comes back
with three stars. On n = 30, a genuine r of 0.4 may come back unstarred. Always
read the coefficient first and the marker second.

**Missing data.** Because each pair uses its own complete rows, cells in the
same matrix rest on different subsets of patients, and different subsets can
mean different populations — if a lactate is measured mainly on the sickest
patients, its correlations describe those patients, not your cohort. Check how
much of each column is present before reading its row.

## A worked example

*Which biological parameters track ICU length of stay?*

One row per stay, with admission-day laboratory values (lactate, creatinine,
CRP, platelets, albumin), a severity score, and length of stay in days.

1. **Variables** → the laboratory columns, the severity score, and length of
   stay. Untick the stay id.
2. **Method** → Spearman. Length of stay is heavily right-skewed and lactate has
   a long tail; Pearson would let a handful of 60-day stays set the answer.
3. **Variable order** → Custom, grouping the biology together and putting length
   of stay last, so its row reads as a single strip along the edge.
4. **Significance level (α)** → leave at 0.05, and remember the matrix is
   running around twenty tests.

Suppose the length-of-stay row shows ρ = 0.42 with the severity score, 0.31 with
lactate, and 0.04 with creatinine. The first two are worth pursuing; the third
is not evidence that creatinine is irrelevant — it may simply not be *monotonic*
with the stay, and a scatter plot is what will tell you.

Then check the rest of the grid for the other thing a matrix is good at: if CRP
and ferritin correlate at 0.88, do not put both into a regression. That is
collinearity, and it will make both coefficients unstable.

## Further reading

- [Schober P et al., *Correlation Coefficients: Appropriate Use and Interpretation*](https://journals.lww.com/anesthesia-analgesia/fulltext/2018/05000/correlation_coefficients__appropriate_use_and.50.aspx) — Anesthesia & Analgesia; the practical guide, including when to prefer Spearman.
- [Bland JM & Altman DG, *Correlation, regression, and repeated data*](https://www.bmj.com/content/308/6933/896) — BMJ Statistics Notes; one page on a mistake that is still made constantly.
- [Bland JM & Altman DG, *Correlation in restricted ranges of data*](https://www.bmj.com/content/342/bmj.d556) — why the same relationship yields a different r in a narrower population.
- [Anscombe FJ, *Graphs in Statistical Analysis*](https://www.jstor.org/stable/2682899) — the quartet: identical statistics, four incompatible datasets.
- [Altman DG & Krzywinski M, *Association, correlation and causation*](https://www.nature.com/articles/nmeth.3587) — Nature Methods Points of Significance.
