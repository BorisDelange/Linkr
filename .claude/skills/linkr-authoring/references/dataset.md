# Dataset

A dataset is a CSV plus the column metadata the app reads. You supply the CSV text and a
name; ids, types and `_tree.json` are derived.

Fields: `describe_entity_schema("dataset")`.

## Column ids are derived from names

`mean SpO2 (%)` → `col_mean_spo2`. Deterministic on client and server alike, which is
what lets an export→reimport keep every filter and widget config pointing at the right
column. Two names normalising to the same slug get `_2`, `_3` in header order.

Never write ids yourself. A hand-written `col-0` is the legacy positional scheme: the
app still reads it, but a re-export renames it and orphans whatever pointed at it.

## Types

Inferred from the values, conservatively — a column that is not unambiguously numeric,
boolean or a date stays a string. `0`/`1` reads as boolean. Override per column with
`types: {"patient_id": "string"}` when the inference is wrong; an id column of digits is
the usual case, since a numeric id gets aggregated as a number.

## Writing clinically coherent data

This is the part no tool does for you. Synthetic rows should survive a clinician's
glance:

- ranges that exist in life (an ICU length of stay of 400 days does not);
- correlations that hold — a high SOFA with zero organ support reads as broken;
- a mortality rate in the plausible band for the unit you are portraying;
- missing values where they are genuinely missing in practice, not everywhere or nowhere;
- dates ordered: admission before discharge, discharge before death.

Around 200 rows is enough for a demo. State plainly, in the README, that the data is
synthetic.

## Layout

`datasets/<name>/<name>.csv` plus one entry in `datasets/_tree.json`. Widgets address
the dataset as `<name>.csv`.

Data files are gitignored by default in a generated tree; the app re-includes them per
file through "mark for versioning".
