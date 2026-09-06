# Data overview

Every event a patient has, laid out on one time axis and grouped by the source
table it came from and the concept it records. Each row is a concept — a
laboratory analyte, a drug, a monitoring signal — and the shading along it says
how densely that concept was recorded at that moment. Zoom in far enough and the
bands stop being a density and become the individual events.

It answers a question you should ask before every analysis and almost never can:
**what does this patient's record actually contain, and over what period?** A
cohort query tells you a patient has a lactate; it does not tell you that the
lactate exists on day 1 and day 9 and nowhere in between, that the ventilator
data stops halfway through the stay, or that the whole medication table starts
three days after admission because that is when the unit went live on the
prescribing software.

Reading one patient's record end to end is also the fastest way to catch an ETL
problem. Aggregate quality checks tell you a table has 4.2 million rows; a
single patient chart tells you that the rows arrive in a shape no clinician
would recognise.

![The Data overview widget: source tables down the left with their concept
counts, density bands across the width, and the patient's unit transfers along
the top.](attachments/output.png)

Above: one stay, read as a record rather than as a patient. Chart events carry
223 concepts and 3578 rows; labs, inputs, prescriptions and procedures each have
their own band. The transfers strip along the top says which unit the patient
was in at any moment — and the visible interruptions in the bands are the thing
to be careful with: they say the data stops there, not that nothing happened.

## What you need

Nothing beyond a patient and a mapped schema. The widget reads the OMOP tables
your project's active database exposes — measurements, observations, drug
exposures, procedures, conditions, visits — and builds its rows from whatever it
finds. There are no columns to pick: it is a view onto the record, not a chart
over a dataset.

Six settings change what it shows:

- **Group by concept class** adds a level between a source table and its
  concepts, using the vocabulary's own class (OMOP `concept_class_id`, MIMIC
  `category`). On a measurement table with hundreds of analytes this turns an
  unreadable list into a handful of collapsible families. It is ignored when the
  active schema has no class column.
- **Show unit stays** draws a lane for the ward the patient was in over time. It
  needs a visit-detail table in the schema mapping; without one, the lane simply
  does not appear.
- **Mark death** puts a vertical marker at the death recorded in the record, if
  there is one — the single most useful landmark for reading everything to its
  left.
- **Row height** trades detail for coverage. *Compact* fits more concepts
  individually before the figure has to fold them together; *Large* shows fewer,
  but readably.
- **Sync time range** shares the visible window with the other synced widgets on
  the board, so a timeline of vital signs and this overview scroll together.
- **Range selector** keeps a strip under the chart showing the whole record with
  the visible window as a draggable box — worth leaving on, because it is the
  only thing that tells you how much of the stay you are *not* looking at.

## Empty space is missing data, not a quiet patient

> [!WARNING]
> **A gap in a band means no record was written, not that nothing happened.** A
> stretch with no creatinine can mean nobody ordered one, that the patient had
> left the unit, that the analyte came from a device that never fed the
> warehouse, or that the ETL dropped it. The widget cannot distinguish these.
> Turn **Show unit stays** on before reading any gap: it at least tells you
> whether the patient was present.

## Reading the bands

Colour intensity along a row is a count of events per pixel of time, so the same
row looks continuous during a monitored period and sparse during a quieter one
without any change in practice. Zoom in — drag across the chart — and the bands
resolve into the individual events with their timestamps.

A row that is dense and then simply stops while its neighbours continue is worth
a look: on one patient that is a clinical event, but repeated across patients it
usually points at the source table's extract window rather than at care.

Concepts are ranked by event count, and the ones that do not fit are folded into
an **Other** row that names how many are hidden above and below. **Row height**
trades detail for coverage: *Compact* fits more concepts individually before
folding, *Large* shows fewer but more readably.

## Checking a stay after a pipeline run

The widget is the fastest way to see what a single patient's record actually
contains after an ETL change. Open one long, complex stay with **Group by
concept class** on and **Range selector** on, and read down the source tables: a
table missing entirely, a concept family that appears only after a certain date,
or a row that stops mid-stay are all visible in seconds and hard to catch in
aggregate checks.

With **Sync time range** on, this widget shares its window with the timelines on
the same board, so you can line up the record's coverage against the measurements
you are plotting.

## Further reading

- [The Book of OHDSI, *Data Quality*](https://ohdsi.github.io/TheBookOfOhdsi/DataQuality.html) — systematic checks over an OMOP database, the level above single-patient inspection.
- [Kahn MG et al., *A harmonized data quality assessment terminology and framework*](https://pmc.ncbi.nlm.nih.gov/articles/PMC5051581/) — the conformance / completeness / plausibility vocabulary for what you are looking at.
- [Weiskopf NG & Weng C, *Methods and dimensions of electronic health record data quality assessment*](https://pmc.ncbi.nlm.nih.gov/articles/PMC3555312/) — completeness, correctness and currency defined.
- [OMOP CDM v5.4 specification](https://ohdsi.github.io/CommonDataModel/cdm54.html) — the source tables whose rows become the bands.
