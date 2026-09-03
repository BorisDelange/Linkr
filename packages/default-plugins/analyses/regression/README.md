# Regression

Regression measures the association between an outcome and several variables **at
once**, so each one is read with the others held constant.

That is what a table of one-variable comparisons cannot do. Non-survivors in an
ICU are older *and* sicker *and* more often ventilated, and every one of those
columns will look "significant" on its own. Regression is how you ask which of
them still carries the association once the other two are accounted for.

## What you need

Two settings under **Data** are required.

- **Outcome (Y)** — what the model explains. One column, one row per patient or
  per stay.
- **Predictors (X)** — the variables to adjust for one another. Numeric columns
  enter as they are; a text column becomes one row per level.

Rows with a missing value in the outcome or in *any* predictor are dropped
entirely, and the widget tells you how many. This is complete-case analysis: add
a predictor that is 30% empty and you silently lose 30% of your patients, along
with whatever made them different.

**Predictor order** only changes how the rows read. Leave it on dataset order
while exploring; switch to *Custom (drag to reorder)* for a figure, where the
exposure of interest belongs at the top and the adjustment variables below.

## Linear or logistic

The **Regression type** setting follows from the nature of the outcome, not from
preference.

| Outcome | Type | The model reports |
| --- | --- | --- |
| Length of stay, SAPS II, a lactate value | Linear | A coefficient: change in Y per unit of X |
| Died / survived, readmitted yes-no | Logistic | An odds ratio |

*Auto-detect* reads the outcome column: exactly two distinct values give
logistic, anything else linear. A non-numeric column is always treated as
binary — and if it turns out to have more than two levels, the widget says so
rather than guessing.

Forcing **Linear** on a 0/1 outcome fits a linear probability model, which will
happily predict a risk of 1.3. Forcing **Logistic** on a continuous outcome
fails outright.

## Reading a coefficient

**Linear.** A coefficient of 0.42 for SOFA means: one extra SOFA point goes with
0.42 more days of stay, at equal age and equal ventilation status. Units are the
units of your columns — rescale age to decades if a per-year effect is too small
to read.

**Logistic.** An odds ratio of 1.15 for age means the *odds* of the outcome are
multiplied by 1.15 per extra year. OR = 1 is no association; below 1 is
protective.

An odds ratio is **not** a relative risk. When the outcome is rare (a few per
cent) the two are close enough to talk about interchangeably. When it is common
— and ICU mortality at 25% is common — the OR is systematically further from 1
than the risk ratio. An OR of 2.0 on a 25% baseline is a risk going from 25% to
about 40%, not to 50%. Say "odds", write "odds ratio", and resist the sentence
"twice as likely to die".

### The interval, not the p-value

Each row carries a confidence interval at the level set by **Confidence level
(%)** (95% by default, which also sets the significance threshold α used for
highlighting).

Read it first. It says which effect sizes are compatible with your data, and the
p-value does not.

- An interval containing **1** (odds ratio) or **0** (linear coefficient) is no
  evidence of an effect. It is *not* evidence of no effect: OR 1.8 [0.7 – 4.5]
  is an underpowered study, not a negative one.
- A narrow interval around 1 — OR 1.02 [0.98 – 1.06] — genuinely argues against
  a clinically useful effect. That is a different result, and only the interval
  distinguishes the two.
- A "significant" OR of 1.04 on a 3000-patient cohort may be real and useless.
  Significance is about sample size as much as about effect.

**Highlight significant** marks the rows where p < α. Treat it as a scanning
aid, not as a verdict.

## Categorical predictors

A text predictor is expanded into one row per level, minus one: the first level
in alphabetical order is dropped and becomes the **reference**. Every other
level is read against it — "Admission source: Emergency, OR 1.6" means 1.6 times
the odds compared with the omitted level, not compared with everyone else.

Two consequences worth planning for:

- The reference is picked alphabetically, so recode your values if you want a
  particular baseline first (`0_medical`, `1_surgical`, or a leading letter).
- A column with a single value is dropped; one with more than 20 levels is
  dropped too. Both are reported as warnings. A free-text diagnosis field needs
  grouping into a handful of categories before it can enter a model.

## Adjustment, and how it goes wrong

"Adjusted for age" means the coefficients describe patients compared *at the
same age*. That is the power of the method and also where it fails.

> [!WARNING]
> **Do not adjust for anything on the causal path.** If sepsis raises mortality
> *because* it causes shock, adding vasopressor use as a predictor removes
> exactly the effect you were measuring — the sepsis coefficient collapses
> towards 1 and you conclude, wrongly, that sepsis does not matter. The same
> damage comes from adjusting on a variable that both the exposure and the
> outcome influence (a collider), which can manufacture an association out of
> nothing. Choose predictors from what you believe causes what, before you run
> the model — never by putting every available column in and keeping what comes
> out significant.

**Collinearity** is the other failure. Two predictors carrying nearly the same
information — SOFA and SAPS II, weight and BMI — cannot be separated by the
model. The coefficients become unstable: large, wide-intervalled, sometimes with
flipped signs, while the model as a whole fits fine. If dropping one predictor
moves another one's estimate wildly, that is what you are looking at. Keep one
of the pair.

## How many patients

For logistic regression, the working rule is **10 events per predictor** — and
it is events, not rows. A cohort of 500 stays with 60 deaths supports about 6
parameters, and each level of a categorical variable counts as one. Below that,
coefficients are biased away from 1 and intervals are unreliable.

The widget stops and warns when there are fewer complete rows than parameters,
but nothing warns you at 3 events per variable: that is your judgement to make.
The other symptom is a coefficient with an absurd estimate and an interval
spanning several orders of magnitude — usually a level of a category with no
events at all in it (separation). Merge levels, or drop the variable.

## Reading the forest plot

Set **Display** to *Table + plot (stacked)*, *Table + plot (tabs)*, or either
one alone; **Table columns** chooses what the table shows (estimate, standard
error, interval, statistic, p-value).

The plot draws one row per coefficient — the intercept is excluded, as it has no
interpretation as an effect. The diamond is the point estimate, the horizontal
bar its confidence interval, and the dashed vertical line the null value (1 for
odds ratios, 0 for linear coefficients). Rows whose interval crosses that line
are drawn muted.

Read the plot for *widths* first: a row with a long bar is a variable your data
has little to say about, whatever its p-value.

## A worked example

*Which factors are associated with in-hospital death?*

One row per ICU stay, with a death flag, age, SAPS II, and whether the patient
was ventilated.

1. **Outcome (Y)** → the death flag. Two values, so **Regression type** on
   *Auto-detect* fits a logistic model and reports odds ratios.
2. **Predictors (X)** → age, SAPS II, ventilation. Not the length of stay: dying
   early shortens it, so the arrow points the wrong way.
3. **Confidence level (%)** → 95.
4. **Predictor order** → *Custom*, with ventilation first if that is the
   exposure the question is about.
5. **Display** → *Table + plot (stacked)*.

Check the event count before reading anything: 3 parameters need roughly 30
deaths. Then read ventilation's interval — if it spans 1, your cohort cannot
answer the question at this size, whatever the unadjusted comparison suggested.

If age and SAPS II both come back with wide intervals and one has an unexpected
sign, suspect collinearity: SAPS II already contains age. Keep the score, drop
the age column, and see whether the estimates settle.

## Further reading

- [Bland JM & Altman DG, *The odds ratio*](https://www.bmj.com/content/320/7247/1468) — one page, and the source of most of the confusion this note tries to prevent.
- [Bland JM & Altman DG, *Regression towards the mean*](https://www.bmj.com/content/308/6942/1499) — the trap in before/after comparisons.
- [Peduzzi P et al., *A simulation study of the number of events per variable in logistic regression*](https://pubmed.ncbi.nlm.nih.gov/8970487/) — where the 10-events-per-variable rule comes from.
- [Schisterman EF et al., *Overadjustment bias and unnecessary adjustment*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3888622/) — mediators, colliders, and what adjusting on them destroys.
- [Sedgwick P, *Understanding confidence intervals*](https://www.bmj.com/content/349/bmj.g6051) — why the interval says more than the p-value.
