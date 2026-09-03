# Statistical tests

Compare groups on many variables at once, with the right test picked per
variable — and with the numbers that say whether the difference matters, not
only whether it is "significant".

The plugin exists because the test is rarely the hard part. Choosing it is:
a t-test on a skewed length of stay, a chi-squared on a 2×2 table with four
patients in a cell, a p-value read as a probability that the groups are the
same. Each of those produces a number that looks perfectly respectable and is
wrong.

## What you need

Two settings do the work:

- **Group column** — the variable whose groups are compared. It must be
  categorical: survivor / non-survivor, ward A / ward B / ward C. Two groups
  give a t-test or Mann-Whitney; three or more, an ANOVA or Kruskal-Wallis.
- **Variables tested** — one row of the table per variable. Numeric and
  categorical variables can be mixed freely; the plugin handles each according
  to its type. Date columns are skipped.

One row per patient (or per stay — but be consistent). Rows with a missing
group value are dropped; missing values in a tested variable are dropped for
that variable only, which is why the `n` shown per group can differ from row to
row.

## Which test, and why

The test is chosen per variable, from the variable's type and the number of
groups:

| Variable | Groups | Parametric | Rank-based / exact |
| --- | --- | --- | --- |
| Numeric (age, SAPS II, lactate) | 2 | Welch's t-test | Mann-Whitney U |
| Numeric | 3 or more | One-way ANOVA | Kruskal-Wallis |
| Categorical (sex, comorbidity) | any | Chi-squared | Fisher's exact |

For a categorical variable the choice is not yours to make: on a 2×2 table, if
any **expected** count falls below 5, the chi-squared approximation stops being
trustworthy and the plugin switches to **Fisher's exact test**. Note *expected*,
not observed — a cell with 7 patients can still have an expected count of 2.

For a numeric variable, **Test choice** decides:

- **Auto (guided by the data)** — each group is checked for normality
  (Shapiro-Wilk). If any group departs from it, the whole comparison goes to the
  rank-based test. Failing towards the non-parametric side is deliberate: it
  costs a little power when the data really were normal, whereas a t-test on a
  skewed variable can report a difference that is not there.
- **Force parametric** / **Force non-parametric** — applied to every variable,
  no check. Use these when a protocol or a statistical analysis plan fixed the
  analysis in advance; a tool should not quietly overrule that.

A parametric test assumes roughly normal data in each group and — for ANOVA —
comparable variances. Welch's t-test drops the equal-variance assumption, which
is why it is the default rather than Student's. On small groups (say under 20
per arm) normality cannot really be checked at all, and the rank-based test is
the prudent answer. The table tells you which was used and why: hover the test
name, or click it to pin a different test on that one variable.

## Reading the results

Each row carries, depending on **Table columns**:

- **Group descriptives** — `n` and mean ± SD per group for numeric variables,
  counts and percentages per category for categorical ones. Read these first.
  They are the actual finding; the p-value only qualifies it.
- **Statistic** and **degrees of freedom** — `t`, `U`, `χ²`, `F`, `H`. Needed to
  report the test, rarely to interpret it.
- **p-value**, with `*` (< 0.05), `**` (< 0.01), `***` (< 0.001), and an amber
  triangle when the result is fragile (a cell below the expected count, a group
  with too few observations). The warning is shown rather than the result
  hidden — a shaky number you can see beats one silently withheld.
- **95% CI** — the confidence interval on the difference between means, for
  Welch's t-test. This is the number to quote.
- **Effect size** — Cohen's *d*, rank-biserial *r*, Cramér's *V*, η². How big
  the difference is, on a scale that does not grow with your sample size.

### What a p-value is not

It is the probability of seeing a difference at least this large **if the groups
truly did not differ**. It is not the probability that they do not differ, and
it is not a measure of how big the difference is.

The practical consequence: on 5000 patients, a p of 0.002 can correspond to a
half-day difference in length of stay that no one would change practice for. On
40 patients, a p of 0.09 can hide a difference that matters a great deal. This
is why **Effect size** and **95% CI** are on by default — an interval running
from −0.3 to +4.1 days says "we do not know", whichever side of α the p-value
landed.

**Significance level (α)** sets the threshold a p-value is compared against.
It changes only what is marked with a star, never the p-values themselves.
Lowering it to 0.01 makes false positives rarer and false negatives commoner;
there is no setting that avoids both.

## The traps

> [!WARNING]
> **Testing 20 variables at α = 0.05 buys you roughly one false positive by pure
> chance.** This plugin tests every variable you tick, in one click, so the risk
> is immediate rather than theoretical. Decide *before looking* which comparison
> answers your question; everything else is exploratory and must be described
> as such. If several comparisons genuinely carry the conclusion, correct for
> multiplicity (Bonferroni, Benjamini-Hochberg) outside the table — the p-values
> here are uncorrected.

**A "Table 1 with p-values" comparing the arms of a randomised trial is not
informative.** Randomisation guarantees that every baseline difference is due to
chance, so the p-value tests a hypothesis you already know to be true. What
matters is whether an imbalance is *large enough to confound*, which is a
clinical judgement on the effect size, not a test. Between non-randomised groups
— survivors vs non-survivors, two wards — the comparison is a real question and
these p-values mean something.

**Three groups do not tell you which pair differs.** A significant ANOVA or
Kruskal-Wallis says "not all groups are alike". Identifying the pair takes a
post-hoc comparison, itself a multiple-comparison problem.

**A non-significant result is not evidence of no difference.** It means the data
were compatible with no difference — and, on a small sample, compatible with a
large one too. The confidence interval is what distinguishes the two cases.

## A worked example

*How do ICU survivors and non-survivors differ at admission?*

One row per stay, a `died_icu` column with two levels, plus age, SAPS II,
admission lactate, sex, and a chronic-disease flag.

1. **Group column** → `died_icu`. Two levels, so pairwise tests throughout.
2. **Variables tested** → age, SAPS II, lactate, sex, chronic disease.
3. **Test choice** → *Auto*. Age will likely stay on Welch's t-test; lactate is
   right-skewed and will go to Mann-Whitney. The table says which, and why.
4. **Significance level (α)** → 0.05, and read it as a marker, not a verdict.
5. **Variable order** → *Custom*, dragging demographics above severity scores,
   the way a Table 1 is normally laid out.

Now read the effect sizes. A SAPS II gap of 18 points with Cohen's *d* near 1.0
is the finding; a two-year age difference with *d* = 0.12 is significant on
2000 stays and clinically irrelevant. Five variables tested means the weakest
star deserves the least trust — and none of it is causal: non-survivors are
sicker for reasons this table cannot separate.

## Further reading

- [Wasserstein RL & Lazar NA, *The ASA statement on p-values*](https://www.tandfonline.com/doi/full/10.1080/00031305.2016.1154108) — six principles, and what a p-value cannot do.
- [Amrhein V, Greenland S & McShane B, *Scientists rise up against statistical significance*](https://www.nature.com/articles/d41586-019-00857-9) — why the dichotomy at 0.05 misleads.
- [Bland JM & Altman DG, *Multiple significance tests: the Bonferroni method*](https://www.bmj.com/content/310/6973/170) — one page on the multiplicity problem.
- [Altman DG & Bland JM, *Absence of evidence is not evidence of absence*](https://www.bmj.com/content/311/7003/485) — how to read a non-significant result.
- [de Boer MR et al., *Testing for baseline differences in randomized controlled trials*](https://pmc.ncbi.nlm.nih.gov/articles/PMC4029520/) — why Table 1 p-values in a trial are unhelpful.
