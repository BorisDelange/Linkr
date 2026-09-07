## Introduction

Survival analysis answers "how long until this happens?" while correctly
handling the patients it has not happened to *yet*.

That last part is the whole point. If you simply computed "% who died", you
would have to drop everyone still alive at the end of follow-up — or count them
as survivors, whatever their follow-up length. Both answers are wrong. Survival
analysis keeps them, contributing information for exactly as long as they were
observed.

![Kaplan-Meier curves for two protocols over 90 days, with confidence bands,
censoring marks and an at-risk table below the
axis.](attachments/output.png)

Above: two protocols, 210 stays each. The curves separate from about day 30 and
stay apart. Read the at-risk row before believing the tail: by day 80 only 76
and 55 patients remain, so the right-hand end of each curve rests on far fewer
people than the left.

## Settings

Three columns, two of them required:

- **Time variable** — the follow-up duration per patient, in your unit of choice
  (days, months). Not a date: a duration, from the same origin for everyone.
- **Event variable** — `1` when the event happened, `0` when censored. That
  coding matters: an inverted column silently plots the mirror image of the
  truth.
- **Group variable** *(optional)* — one curve per level, plus a log-rank test
  comparing them.

The origin has to be the same clinical moment for everyone — admission,
diagnosis, randomisation. Mixing origins is the most common way a survival
curve ends up meaningless.

## Notes on the method

### Censoring, in one paragraph

A patient is **censored** when follow-up ends without the event: they were still
alive at their last visit, they moved away, the study closed. They count as "no
event *up to here*", then stop contributing.

> [!WARNING]
> Censoring must be unrelated to the outcome. If patients drop out *because*
> they are deteriorating, the curve is optimistic and no setting fixes it. This
> is an assumption about your data, not something the plugin can check.

### Reading the curve

The line falls each time the event happens, and is flat in between. Small ticks
mark censored patients. The curve is not an estimate of a percentage: it is the
probability of *still* being event-free at each point in time.

**Median survival** is where the curve crosses 50%. If it never does, there is
no median — that is a legitimate result, not a failure, and it says more than
half the patients were still event-free at the end.

**Confidence bands** widen towards the right, because fewer and fewer patients
remain. The tail of a Kaplan-Meier curve is always the least reliable part of
it, and the **at-risk table** is what lets a reader see that: turn it on when
the chart is going into a paper or a presentation. A drop from 3 patients to 2
looks like a 33% fall and means almost nothing.

### The log-rank test

With a group variable, the plugin reports a log-rank p-value: the probability of
seeing a difference this large between the curves if the groups truly had the
same survival.

It compares the curves *as a whole*, not at a chosen time point — which is why
you should not read it as "the difference at 1 year". It also assumes the curves
do not cross: when they do, the test loses power and can return a
non-significant p-value for two visibly different survival patterns.

### The Cox model

Add **Cox predictors** to fit a proportional-hazards model — the way to ask
whether a difference holds after adjusting for other variables (age, severity,
comorbidity).

It reports a **hazard ratio** per predictor. HR = 1.5 means a 50% higher rate of
the event per unit of that variable, at any moment. HR below 1 is protective.
The confidence interval matters more than the point estimate: an HR of 2.0 with
a CI from 0.8 to 5.1 is not evidence of anything.

#### The proportional-hazards assumption

Cox assumes the hazard ratio is **constant over time**. A treatment that helps
early and stops helping violates it, and its single averaged HR then describes
no period in particular.

The plugin runs the assumption check and warns you when it fails. Take the
warning seriously: a violated model is not a slightly worse model, it is one
whose main number has no clear meaning. Reporting the Kaplan-Meier curves alone
is a perfectly respectable answer.

## A worked example

*Does the new protocol reduce 90-day mortality?*

One row per stay, with a length of follow-up, a death flag, and the protocol
used.

1. **Time variable** → days from admission to death or last contact.
2. **Event variable** → the death flag, `1` for died.
3. **Group variable** → the protocol.
4. Turn on **At-risk table** — reviewers ask for it, and it shows how thin the
   tail is.
5. Add age and a severity score as **Cox predictors**: if the groups were not
   randomised, the unadjusted curves compare populations, not protocols.

If the assumption check complains, look at the curves: crossing lines mean the
protocol's effect changes over time, which is a finding in itself.

## Further reading

- [Clark TG et al., *Survival analysis part I: basic concepts*](https://www.nature.com/articles/6601118) — the standard primer.
- [Bland JM & Altman DG, *The logrank test*](https://www.bmj.com/content/328/7447/1073) — one page, no algebra.
- [Ranganathan P & Pramesh CS, *Censoring in survival analysis: potential for bias*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3275994/) — what goes wrong in practice.
