A Sankey diagram follows *where things go*. Each band is a group of patients
moving from one stage to the next, and the band's width is how many of them
there are — so the eye reads the volume of a pathway directly, without doing
arithmetic on a table of counts.

It answers questions a table answers badly: where does the cohort split, which
route carries most of the patients, and — usually the interesting one — where do
they disappear.

![A Sankey diagram of hospital pathways: admission sources on the left, ICU in
the middle, and discharge outcomes on the right.](attachments/output.png)

Above: 320 visits, from where they came to how they ended. Read it for the
splits rather than the totals — the band that leaves the ward and returns to
ICU is a readmission signal, and it is the kind of thing worth quantifying
properly rather than concluding from the picture.

## Settings

**Data shape** comes first, because it decides which other settings appear.

| Your data | Setting | What you configure |
| --- | --- | --- |
| One row per step (a stay-movement table) | Long | *Unique per*, *Stage / step*, *Order by* |
| One column per stage, already wide | Level columns | the columns, in order |
| One column holding `"A;B;C"` | Path string | the column and its separator |

**Long** is the recommended shape and the one hospital data usually arrives in.
**Unique per** is the identifier the steps belong to — a visit or stay id, not a
patient id if a patient can have several independent stays. **Stage / step** is
the column holding each step's value. **Order by** is what puts the steps in
order within each entity: a unit-entry datetime, a sequence number. Leave it
empty and the plugin trusts the dataset's row order, which is a bet you rarely
want to take.

**Merge consecutive repeats** is on by default and collapses A→A into a single
step, so a stay recorded as three consecutive rows in the same unit does not
generate loops onto itself. **End node label**, if you fill it in, appends one
final node with that label to every flow.

## Notes on the method

### Three things it does well

**Patient pathways.** Emergency → ICU → ward → discharge, with every deviation
visible: the returns to ICU, the direct transfers, the deaths at each stage.

**State transitions.** Ventilation status day 1 → day 3 → day 7, renal
replacement started and stopped, a severity band that moves.

**Inclusion funnels.** Screened → eligible → consented → analysed. Each
narrowing is drawn to scale, and the losses are as visible as the survivors,
which is exactly what a flow diagram in a paper is meant to show.

### What the diagram is actually counting

Node columns are **positional**: the first step of every flow sits in column 1,
the second in column 2, and so on. A stage that occurs at two different points
appears as two nodes, in two columns, sharing one colour. A patient going ICU →
ward → ICU therefore produces two separate "ICU" nodes rather than an arrow
pointing backwards — the diagram always reads left to right, and readmissions
show up as a stage reappearing further right.

A link's value is the number of flows making that transition at that position:
in Long shape, a count of entities; in Level or Path shape, a count of rows.

**Align end states** is worth knowing about. Without it, pathways of different
lengths put their final stage in different columns, so "Death" can appear three
or four times across the diagram. Turn it on and every flow's last stage is
merged into one shared final column, giving a single "Death" node and a single
"Discharge" node — much easier to read whenever outcomes are the point.

### Keeping it readable

> [!WARNING]
> **Too many nodes and the diagram means nothing.** With 30 units, 12 outcomes
> and no minimum, you get a hairball where no band is thick enough to follow —
> and the rare paths, which are visually the most tangled, are the least
> informative. Group small categories into a sensible "Other" upstream and raise
> **Min flow size** until the picture is legible. A Sankey is a communication
> tool: if a colleague cannot trace one path with their eye, it has failed,
> however complete it is.

**Min flow size** hides transitions occurring fewer times than the threshold.
Raising it from 1 to 5 or 10 usually turns an unreadable diagram into a clear
one. Be aware that this changes the totals: every percentage the widget shows is
relative to the sum of the *displayed* flows, so a filtered diagram no longer
accounts for the whole cohort. Say so when you present it.

The other rule is about interpretation. **A Sankey shows observed flows, not
causes.** A thick band from ICU to the ward does not mean the ICU stay caused
the ward stay, and comparing the width of two bands compares two groups of
patients who were never comparable to begin with. It is a description of what
happened, and a good one; it is not an effect.

Use **Display** → *Diagram + table* when the exact numbers matter. The table
lists From, To, Count and a percentage of the displayed total, is sortable and
filterable, and clicking a band in the diagram jumps to its row.

## A worked example

*Where do our ICU patients come from, and where do they end up?*

One row per unit stay, with a visit id, a unit name, an entry datetime, and a
discharge outcome recorded on the last row of each visit.

1. **Data shape** → Long.
2. **Unique per** → the visit id. Using a patient id here would splice two
   separate hospitalisations into one impossible pathway.
3. **Stage / step** → the unit name, **Order by** → the entry datetime.
4. Leave **Merge consecutive repeats** on: a transfer between two beds in the
   same unit is not a step in the pathway.
5. **Align end states** on, so "Death", "Home" and "Transfer" each appear once
   on the right instead of scattered over several columns.
6. **Min flow size** → start at 1, look at the mess, then raise it to around 1 %
   of your cohort.

Read it for the splits, not the totals. If a visible share of ICU discharges
comes back to ICU two columns later, you have a readmission signal worth
quantifying properly. If the band into "Death" is thick from one particular
upstream unit, that is a question to take to the data — not a conclusion to draw
from the picture.

## Further reading

- [Schmidt M, *The Sankey diagram in energy and material flow management*](https://onlinelibrary.wiley.com/doi/10.1111/j.1530-9290.2008.00004.x) — where the form comes from and what it was designed to convey.
- [Schulz KF et al., *CONSORT 2010 Statement*](https://www.bmj.com/content/340/bmj.c332) — the inclusion-funnel flow diagram a Sankey generalises.
- [Riehmann P et al., *Interactive Sankey diagrams*](https://ieeexplore.ieee.org/document/1532152) — the readability limits of the form.
- [Krzywinski M & Altman N, *Points of view: Visualizing samples*](https://www.nature.com/articles/nmeth.2813) — a reminder that a summary picture is not the data.
