# Map

Plots your rows as points on an interactive map, from a latitude and a longitude
column. Use it to see where patients come from, how cases spread across a
territory, or how far people travel to reach your service.

Geography is one of the few variables that is genuinely hard to read from a
table. A map makes catchment areas, gaps in coverage and distance effects
obvious in a way that a list of postcodes never will.

## What you need

Two numeric columns: **Latitude** and **Longitude**, in decimal degrees
(48.1173, −1.6778), not degrees-minutes-seconds and not a text address. Rows
with unparseable or out-of-range coordinates are dropped silently, so if fewer
points appear than you expect, look at your coordinate columns first — swapped
latitude and longitude is the classic error, and it usually lands your entire
cohort in the sea off West Africa.

You will normally need a geocoding step upstream to turn addresses or postcodes
into coordinates. Do that once, in a pipeline, and store the result.

Three optional columns change what the points say:

- **Color by** — a categorical column. Each distinct value gets its own colour
  and a legend entry. Keep it to a handful of categories.
- **Size by** — a numeric column scaling each point's radius, turning the map
  into a bubble map. This is how you show a *count* per location.
- **Label** and **Hover popup fields** — the text shown next to a point and in
  its tooltip.

The map fits itself to your data on load, so you do not need to set a centre or
a zoom.

## Never map patients at their home address

> [!WARNING]
> **A point at someone's home is identifying data.** A published map at street
> resolution can be reverse-engineered back to individual addresses with high
> accuracy — this is a demonstrated attack, not a theoretical one, and blurring
> or shrinking the image does not fix it. Aggregate before you map: count
> patients per municipality, postcode or health district, and plot one point per
> *area*, sized by its count. Individual coordinates belong in a working dataset
> under access control, never in a dashboard that gets screenshotted into a
> slide deck.

Aggregating is also what makes the map readable, so this rarely costs you
anything. Small areas with very few patients deserve a second thought even when
aggregated: a single case in a village of 200 people is not much more anonymous
than a dot on a house. Suppressing or merging cells below a small-count
threshold is standard practice, and your data protection rules probably require it.

## Counts reproduce the population map

Here is the trap that catches most disease maps. Plot raw case counts by
municipality and you will find the biggest circles over the biggest cities. This
is not a finding: **more people live there, so there is more of everything
there.** You have drawn a population map with extra steps.

To say something about risk, map a **rate** — cases per 1000 inhabitants, per
100 000, or a standardised ratio — computed in your pipeline and fed into
**Size by** or **Color by**. That is a different map, and often it points
somewhere completely different from the raw counts.

Two cautions once you switch to rates. Small denominators produce wild rates: a
municipality of 300 people with 2 cases outranks everywhere else, on noise
alone. And an area's colour describes the area, not the people in it — the
inference from "this district has a high rate" to "this person is at high risk"
is the ecological fallacy, and it is a mistake worth naming out loud when a map
is presented to clinicians.

## Making a crowded map readable

Points at the same location stack on top of each other and hide each other, so a
dense map systematically under-represents its densest areas — exactly backwards.
Two settings help: lower **Opacity (%)** so overlapping points darken visibly
instead of one hiding the rest, and reduce **Point size** when you have many
points.

Beyond a few thousand markers, the honest fix is aggregation rather than
styling. One bubble per commune, sized by count, tells the truth about density
that a thousand overlapping dots cannot.

**Base map** picks the tiles. *Light (Carto)* keeps the background quiet so your
data carries the colour, which is usually what you want; *OpenStreetMap* gives
more context (street names, landmarks) at the cost of visual noise. All online
tiles require network access — pick *None (offline)* on an isolated hospital
network, and points are drawn on a neutral background.

## A worked example

*Where does our ICU recruit from?*

Start from one row per stay, with a patient postcode.

1. **Upstream**, in a dataset or a pipeline: join the postcode to a reference
   table of municipality centroids, then group by municipality to get one row per
   commune with a patient count, its latitude and its longitude. Drop or merge
   communes below your small-count threshold. This step is what makes the map
   both legal and legible.
2. **Latitude** / **Longitude** → the centroid columns.
3. **Size by** → the patient count.
4. **Hover popup fields** → the commune name and the count, so a reader can get
   the exact number without guessing from the circle.
5. **Base map** → *Light (Carto)*.

You now have a catchment map. Expect a large bubble over your own city and a
decreasing halo around it — distance decay, and it is the expected shape.

The interesting part is what breaks that pattern: a distant commune with far more
patients than its distance predicts (a referring hospital, a partnership), or a
nearby gap where a competing centre takes the flow. To turn this into a statement
about *access* rather than volume, add the population per commune upstream and
size by patients per 1000 inhabitants instead — the map will look different, and
that difference is the point.

## Further reading

- [Brownstein JS, Cassa CA & Mandl KD, *No place to hide — reverse identification of patients from published maps*](https://www.nejm.org/doi/full/10.1056/NEJMc061891) — why individual points cannot be published.
- [Zandbergen PA, *Ensuring confidentiality of geocoded health data*](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4590956/) — geographic masking strategies for individual-level data, reviewed.
- [Cassa CA et al., *A context-sensitive approach to anonymizing spatial surveillance data*](https://pubmed.ncbi.nlm.nih.gov/16357353/) — the impact of masking on both privacy and outbreak detection.
- [Krzywinski M & Altman N, *Visualizing samples with box plots*](https://www.nature.com/articles/nmeth.2813) — the general point that a display must not hide the density it claims to show.
