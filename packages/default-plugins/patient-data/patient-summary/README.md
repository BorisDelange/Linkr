## Introduction

The header of a patient chart: identifier, gender, age, vital status, how many
hospitalisations and unit stays the record holds, and a bar per stay showing
where the patient was and when.

This is a per-patient widget, not a cohort analysis. It reads the person, visit,
visit detail and death tables mapped in your database schema, for the patient
whose chart is open, and shows what it finds.

![The Patient summary widget: identifier, gender, ages, death status,
hospitalisation and unit-stay counts, above a bar per unit
stay.](attachments/output.png)

Above: one hospitalisation but seven unit stays — emergency, medical/surgical,
PACU, then cardiac intensive care. Both ages read `—` because this extract
carries no year of birth; the widget leaves the tile empty rather than computing
something.

## Settings

None. Fields your schema does not map simply do not appear — no visit-detail
table means no unit-stay tile and no stay bars.

One display choice sits in the widget itself: the stay panel toggles between a
**Gantt timeline** (the default, with zoom, drag-to-zoom and double-click to
reset) and a **text** view listing each visit with its dates, length of stay and
unit rows, and printing the gap between consecutive visits. Right-clicking a
Gantt bar navigates to that visit.

Gender is your schema's own coded value translated to male or female, with the
raw value printed when it matches neither. Race and ethnicity are not displayed.

## Notes on the widget

### How the two ages are computed

> [!WARNING]
> **The age is a year subtraction, and it is not the patient's age today.** Two
> ages are shown — at the *first* visit in the record and at the *last* — each
> derived from the year of birth against the year of that visit. Month and day
> are discarded even when a full birth date is available, so a displayed age can
> be a year out either way. De-identified extracts usually reduce the birth date
> to a year, shift dates by a per-patient offset, or both. Use this tile for
> orientation, never as an analysis variable: compute age in a pipeline, from the
> dates, with the rounding rule your study defines.

"Age at first visit" is the age at the earliest visit *present in this database*,
which is not the age at first contact with your hospital: an extract covering
2015–2024 shows a patient followed since 2003 as first seen in 2015. If the
schema maps no visit table, a single age against today's date is shown instead.

### What the counters count

**Hospitalizations** counts distinct visits; **Unit stays** counts rows in the
visit-detail table. Both follow directly from how your ETL defines a visit — in
particular, whether a transfer between departments ends one visit and opens
another, or continues a single hospitalisation with two unit stays. The same
patient and the same care give two different tiles under the two conventions, so
read these numbers relative to other patients loaded by the same pipeline.

The Gantt view shows the convention directly: bars that meet exactly at a
transfer time reveal an ETL that splits on transfer.

### What the death tile means

It shows a date when one is recorded, and "no" otherwise. That "no" means *no
death recorded in this database* — usually only in-hospital deaths are known,
unless the site links to a death registry.
