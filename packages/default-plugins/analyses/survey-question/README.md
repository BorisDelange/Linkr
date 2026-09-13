## Introduction

One question from a questionnaire, analysed properly: how many people answered
it, how the answers are distributed, and the chart that actually fits the
question's type. It reads the metadata exported by eCRF tools — Goupile, REDCap,
LimeSurvey — so it knows a 1-to-5 scale from a free list, and it knows that a
multiple-choice question spread over eight boolean columns is *one* question.

A questionnaire is not a dataset of independent columns. Its columns carry a
declared answer order, a question text, and a structure that a generic chart
plugin discards the moment you point it at a column. Analysing a Likert item as
if it were a categorical variable sorted by frequency destroys the one thing
that made it a scale; analysing a multi-answer question column by column gives
you eight numbers and no question.

This plugin is deliberately one question at a time. A questionnaire is read item
by item, and the number that matters most for each item — its response rate — is
per-item, not per-questionnaire.

## Settings

A dataset with one row per respondent, and a **Question**. You can pick any
column belonging to the question; for a multiple-choice question, selecting one
of its option columns selects the whole question, and the widget reassembles the
options into a single distribution.

**Chart** then offers only the displays that fit that question. This is a
constraint, not an oversight: a pie chart asserts that the slices are exclusive
parts of one whole, which is exactly what a multiple-choice question is not, so
it is not offered there. *Auto* picks for you — bars for categories, a histogram
for a numeric answer, an answer list for free text.

- **Answer list** for free-text questions, where the answers are the result.
- **Horizontal bars** for anything with long option labels, which is most
  questionnaires.
- **Vertical bars** when the answers have a natural left-to-right order.
- **Pie** / **Donut** only for a single-answer question with few options.
- **Histogram** for numeric answers, with **Bins** and a **Median line**.
- **Summary statistics** and **Table** when the numbers matter more than the
  shape.

## Notes on the method

### The response rate is the first number to read

**Response rate** shows n/N: how many respondents answered *this* question out
of everyone in the dataset. Leave it on. It is the number that decides what the
rest of the chart is a statement about.

A distribution computed over 40% of respondents describes those 40%, not your
cohort — and the people who skip a question are rarely a random sample of the
people who answer it. The ones who did not answer "how many hours of overtime
did you work last month?" are systematically different from those who did, in
precisely the direction the question is about. A 92% response rate makes a
distribution roughly interpretable as a cohort-level statement; a 45% one makes
it a statement about respondents, and the honest report says so.

This is item non-response, and it sits on top of the questionnaire's own
response rate. A survey sent to 400 clinicians, answered by 180, with 96 people
answering this item, describes 24% of the people you asked. Every one of those
three numbers belongs in the methods section.

### Missing, "not applicable" and "prefer not to say" are three things

> [!WARNING]
> **A bar chart flattens three different kinds of non-answer into one gap.** A
> respondent who never saw the question (it was branched away by the
> questionnaire logic), one who saw it and chose "not applicable", and one who
> declined to answer are not interchangeable, and only the second and third are
> even in your data as values. Before reading any percentage, know which
> denominator you are on: excluding branched-away respondents from N is usually
> right, excluding refusals is usually wrong, and a chart cannot tell you which
> kind of blank you are looking at. Two identical-looking charts, one with a
> denominator of 400 and one of 96, support entirely different claims.

The practical rule: fix the denominator in the dataset, upstream, before the
chart. If a question was only asked of the subgroup that answered yes to a
filter question, the denominator for it is that subgroup, and the widget's n/N
should reflect it. Feeding the widget the full cohort and mentally adjusting
afterwards is how a 78% becomes a 34% between the dashboard and the paper.

**Exclude NA / empty** behaviour aside, an explicit "prefer not to answer"
option is real data and deserves to stay on the chart. **Hide unpicked** is off
by default for the same reason: an option nobody selected is a finding, not
clutter. Turn it on only when a long option list makes the chart unreadable, and
say that you did.

### Multiple choice: the percentages will not sum to 100

When a question lets a respondent tick several boxes, the plugin reassembles its
columns and reports, for each option, how many respondents selected it. Those
percentages sum to well above 100 — that is arithmetically correct and reads as
an error to anyone who is not told.

So state the denominator on the chart itself. Use **Title** to write it: "Which
monitoring devices do you use? (% of 180 respondents, multiple answers
possible)" leaves nothing to guess. **Bar labels** set to *n and %* helps
further, because the raw count is unambiguous where a percentage is not.

**Max options** groups everything past the top *n* into "Others" rather than
dropping it, so the counts still add up; leave it at 0 while you are exploring
and set it only for presentation. And note that on a multiple-answer question,
"Others" is a bag of unrelated options, not a category — it is honest as a
visual truncation and misleading as a finding.

### Ordinal answers must keep their order

A Likert item — *never / rarely / sometimes / often / always* — carries its
meaning in the sequence. Sorting it by frequency produces a chart where
"sometimes" sits between "never" and "always" because it happened to be picked
more often, and the shape of the distribution, which is the entire point, is
destroyed.

**Sort** therefore defaults to *By frequency* for unordered categories, and
scales detected as scales always keep their questionnaire order regardless. When
the plugin cannot detect the order — an imported column with no metadata, or
options phrased in a way it cannot parse — set **Sort** to *Custom* and use
**Answer order** to drag the answers into the right sequence by hand. Do this
once and the chart is correct from then on.

*Questionnaire order* is the other useful setting: it uses the order the options
were declared in, which is the order respondents actually saw them. That matters
when you suspect an ordering effect, because respondents disproportionately pick
the first options in a long list.

## A worked example

*How often do our ICU nurses use the sedation protocol?*

A Goupile export, one row per respondent, 180 responses to a survey sent to 400
staff.

1. **Question** → the sedation-protocol frequency item.
2. **Response rate** → on. It reads 152/180 — 28 people skipped the item, so
   every percentage below is over 152.
3. **Sort** → *Questionnaire order* if the scale is detected, otherwise *Custom*
   with **Answer order** dragged to never / rarely / sometimes / often / always.
4. **Chart** → *Vertical bars*, so the scale reads left to right.
5. **Bar labels** → *n and %*, and **Title** → "Sedation protocol use (n=152 of
   180 respondents, 400 invited)".

Read the shape, not the modal answer. A distribution piling up on "always" with
a small tail on "never" is a different unit from one that is flat across all
five, even if both have "always" as their most frequent answer.

What would make this misleading: reporting 71% "often or always" without the
denominators. That 71% is of 152 respondents to the item, who are 38% of the
staff invited — and the nurses who never use the protocol are exactly the ones
least likely to have answered a survey about it. The number is defensible with
its three denominators attached and indefensible without them.

## Further reading

- [Eysenbach G, *Improving the quality of web surveys: CHERRIES*](https://pmc.ncbi.nlm.nih.gov/articles/PMC1550605/) — the reporting checklist for online surveys: view rate, participation rate, completion rate, and why all three are needed.
- [Sullivan GM & Artino AR, *Analyzing and interpreting data from Likert-type scales*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3886444/) — what you may and may not do with ordinal answers, in two pages.
- [Sterne JAC et al., *Multiple imputation for missing data: potential and pitfalls*](https://pmc.ncbi.nlm.nih.gov/articles/PMC2714692/) — when non-response can be handled statistically, and when it cannot.
- [Little RJ et al., *The prevention and treatment of missing data in clinical trials*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3771340/) — the case that missing data is designed out, not analysed away.
- [Streit M & Gehlenborg N, *Bar charts and box plots*](https://www.nature.com/articles/nmeth.2807) — when a bar chart is the right display and when it is hiding the distribution.
