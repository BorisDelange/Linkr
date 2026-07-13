# ICU Activity

A synthetic demonstration project showing ICU activity, severity, and outcomes.
All data is fabricated for demo purposes — no real patients.

## Data

- **ICU stays** (`icu-stays.csv`, 220 rows) — one row per ICU stay:
  - `person_id`, `age`, `sex`, `icu_unit`
  - `sofa_score` (severity, 0–20), `los_days` (length of stay)
  - `mechanical_ventilation` (0/1), `deceased_in_icu` (0/1)
  - `admission_datetime`

Age, SOFA, ventilation, and mortality are correlated so the charts and KPIs show
realistic gradients (older / higher-SOFA patients have higher mortality).

## Dashboard — ICU Activity

- **Demographics** — unique patients, ICU mortality, age distribution by sex,
  stays per unit.
- **Severity & outcomes** — median SOFA, ventilation rate, LOS distribution,
  mortality by unit.

Sidebar filters: sex, ICU unit, age range.

## Analysis (Lab › IDE)

- `mortality_analysis.py` — reproduces the mortality KPI and breaks it down by
  SOFA band.
- `los_summary.r` — length-of-stay and ventilation summary by unit.
