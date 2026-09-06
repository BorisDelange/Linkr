The table of population characteristics — the one that opens every clinical
paper, before any analysis. One row per variable, one column per group, each
group headed by its own n.

It is not a preliminary formality. It is what lets a reader decide whether your
results apply to their patients, and whether the groups you are comparing were
comparable in the first place. A reader who cannot see your population cannot
use your conclusion.

![A descriptive table of 1005 ICU stays, grouped into Died and Survived, with
medians and interquartile ranges and a missing-value row for
lactate.](attachments/output.png)

Above: 1005 stays, 174 deaths. Two rows carry most of the meaning. Lactate is
missing in 24% of survivors but only 5% of those who died — it was measured on
the sickest, so the two medians describe differently selected subsets. And the
two lengths of stay barely differ (5.5 versus 6.3 days), because death ends the
stay: a survivorship artefact, not an outcome.

## Settings

One row per subject. Not one row per measurement, not one row per stay if the
unit of analysis is the patient — the table describes the rows it is given, so a
patient with twelve stays would count twelve times.

- **Variables** — the rows of the table. Identifiers and raw timestamps start
  unticked: an id column has a meaningless mean and one level per patient.
- **Group by** *(optional)* — one column per level of this variable. It is never
  described as a row of itself.

## Notes on the method

### How each variable is rendered

The layout follows what journals print:

| Variable type | Rendered as |
| --- | --- |
| Categorical | a heading row naming the variable, then **one indented row per level**, each with `n (%)` |
| Numeric | a single row with the chosen summary — `median [IQR]` by default |

Levels are ordered by overall frequency, so the dominant category leads. **Max
levels** caps how many are printed; the remainder are folded into an "Other" row
rather than dropped, so the counts still add up. Leave it at 0 to show them all.

### Median [IQR] or mean ± SD

**Numeric summary** is the setting that decides whether your table tells the
truth about a variable.

The mean and standard deviation describe a distribution well only when it is
roughly symmetric. On a skewed one they describe nothing that exists: for ICU
length of stay, the mean sits above most of the patients, dragged up by a few
very long stays, and "8.4 ± 11.2 days" implies negative stays two standard
deviations down. The median and interquartile range have no such problem — the
median is the middle patient, the IQR is where the middle half of them sit, and
neither moves when one patient stays a year.

In hospital data, assume skew until you have checked otherwise:

| Usually skewed — use median [IQR] | Usually symmetric — mean ± SD is fine |
| --- | --- |
| Length of stay, ventilation and vasopressor duration | Age, height, weight |
| Lactate, CRP, ferritin, bilirubin, D-dimer | Haemoglobin, sodium, blood pressure |
| Time to treatment, costs, cell counts | Severity scores, in large samples |

Median [IQR] is therefore the default here. **Min / Max** and **Range** are for
the narrower case of documenting the extent of a variable — a plausibility
check, an eligibility window — not for describing a typical patient.

Whichever you choose, name it in the table caption. `12 [7–19]` and `12 ± 19`
look similar and mean entirely different things.

### Missing data

Percentages are computed over the subjects who **answered**, not over the group
total, and the **Missing row** reports the rest on a line of its own.

This is deliberate, and it is the honest option. The alternative — percentages
over the group total — makes a variable with 30% missing show levels summing to
70%, which reads as an arithmetic error. Hiding the missing count instead is
worse still: percentages computed over different denominators, presented in the
same column as if they were comparable, is one of the quiet ways a descriptive
table misleads.

Turn the missing row off only when you have already stated the completeness
elsewhere. A variable missing in a third of the cohort is a finding about your
data collection, and readers are entitled to see it.

One related behaviour: if the grouping variable itself is missing for some rows,
those rows form their own group rather than being dropped — dropping them would
silently change every other column's denominator.

### Reading it, and the p-value question

> [!WARNING]
> **Do not add p-values to the baseline table of a randomised trial.** CONSORT
> is explicit: in a randomised trial any baseline imbalance is by construction
> due to chance, so a test of "was it chance?" answers a question nobody asked.
> A significant p-value there indicates a randomisation failure, not a
> difference worth reporting; a non-significant one does not establish balance.
> Report the numbers and let the reader judge whether an imbalance matters
> clinically. In an observational study, comparing groups is legitimate — but it
> is still one test per row, so a table of thirty variables produces
> significant differences by chance alone, and the ones that matter are the
> clinically relevant imbalances, significant or not.

Read the table top to bottom on the size of differences, not on markers. A
five-year age gap between survivors and non-survivors matters in an ICU cohort
whether or not it clears a threshold; a difference of 0.2 kg does not, however
small its p-value on a large cohort.

### Presentation

**Overall column** adds a pooled column across groups. It sums counts only:
a median cannot be pooled from group medians, so numeric rows show a dash there
rather than a wrong number.

**Wrap long text** is off by default, and worth leaving off. Irregular row
heights break the vertical scan down a column of figures, which is the whole
point of the layout; long labels are truncated with the full value on hover.

On decimals, the plugin rounds to one decimal place and drops a trailing `.0`,
which is the right resolution for almost everything clinical. Do not fight it
back towards more precision: an age of `64.3` years is already finer than the
question deserves, `64.317` is noise, and a column of long numbers is materially
harder to compare down the page. Precision beyond the measurement's own accuracy
implies a certainty you do not have.

## A worked example

*What distinguished the patients who died from those who survived?*

One row per ICU stay, with demographics, a severity score, admission
laboratory values, length of stay, and a vital-status column.

1. **Variables** → age, sex, comorbidities, severity score, lactate, length of
   stay. Untick the stay id and the admission timestamp.
2. **Group by** → vital status. The columns become `Survived (n=812)` and
   `Died (n=193)`, each percentage below being over that group.
3. **Numeric summary** → Median [IQR]. Length of stay and lactate are both
   right-skewed; a mean would describe neither group.
4. **Variable order** → Custom, dragged into reading order: demographics, then
   comorbidities, then severity, then outcomes.
5. **Missing row** → on. If lactate is missing in 22% of survivors and 6% of
   those who died, that is a finding in itself — it was measured on the sickest.

Two things to watch when you read the result. First, that differential
missingness makes the two lactate medians describe two differently selected
subsets, not two comparable groups. Second, that dying patients have shorter
stays than survivors as often as longer ones, because death ends the stay —
length of stay in a mortality comparison is a survivorship artefact more than an
outcome.

## Further reading

- [CONSORT 2010 Statement](https://www.consort-statement.org/) — item 15 and its explanation on baseline data, including why significance tests do not belong there.
- [Moher D et al., *CONSORT 2010 explanation and elaboration*](https://www.bmj.com/content/340/bmj.c869) — the reasoning behind the baseline-table guidance, in full.
- [Altman DG & Bland JM, *Detecting skewness from summary information*](https://www.bmj.com/content/313/7066/1200) — a two-minute check that a mean ± SD is not describing a skewed variable.
- [Bland JM & Altman DG, *Statistics Notes: Quartiles, quantiles and quintiles*](https://www.bmj.com/content/309/6960/996) — what an interquartile range is and is not.
- [Vandenbroucke JP et al., *STROBE explanation and elaboration*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2020496/) — the observational-study equivalent: what descriptive data to report, and how to report missingness.
