# =============================================================================
# 04_example.py — Example Python script
#
# This is a standalone example of a Python script in Linkr.
# It demonstrates how to use sql_query() to query OMOP CDM data,
# process results with pandas, and export a CSV.
#
# sql_query(sql) is automatically available in Linkr.
# It queries the active DuckDB connection and returns a pandas DataFrame.
# Usage: df = await sql_query("SELECT * FROM person LIMIT 10")
#
# Topic: Feature engineering for ICU mortality prediction
# Output: data/datasets/mortality_dataset.csv
# =============================================================================

import pandas as pd

# ---------------------------------------------------------------------------
# Step 1: Create cohort views (eligible visits, mortality, demographics)
# ---------------------------------------------------------------------------
await sql_query("""
    CREATE OR REPLACE VIEW eligible_visits AS
    SELECT
        v.visit_occurrence_id, v.person_id,
        v.visit_start_date,
        v.visit_start_datetime::TIMESTAMP AS visit_start_datetime,
        v.visit_end_date,
        v.visit_end_datetime::TIMESTAMP AS visit_end_datetime,
        EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP
            - v.visit_start_datetime::TIMESTAMP)) / 3600 AS los_hours
    FROM visit_occurrence v
    WHERE EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP
        - v.visit_start_datetime::TIMESTAMP)) / 3600 >= 24
""")

await sql_query("""
    CREATE OR REPLACE VIEW visit_mortality AS
    SELECT ev.*,
        CASE WHEN d.death_date IS NOT NULL
             AND d.death_date BETWEEN ev.visit_start_date
                                   AND ev.visit_end_date + INTERVAL '1 day'
             THEN 1 ELSE 0 END AS in_hospital_death
    FROM eligible_visits ev
    LEFT JOIN death d ON ev.person_id = d.person_id
""")

await sql_query("""
    CREATE OR REPLACE VIEW cohort AS
    SELECT vm.visit_occurrence_id, vm.person_id, vm.visit_start_datetime,
        EXTRACT(YEAR FROM vm.visit_start_date) - p.year_of_birth AS age,
        p.gender_source_value AS sex, vm.los_hours, vm.in_hospital_death
    FROM visit_mortality vm
    JOIN person p ON vm.person_id = p.person_id
    WHERE EXISTS (
        SELECT 1 FROM measurement m
        WHERE m.visit_occurrence_id = vm.visit_occurrence_id
          AND m.value_as_number IS NOT NULL
          AND m.measurement_datetime::TIMESTAMP >= vm.visit_start_datetime
          AND m.measurement_datetime::TIMESTAMP
              <= vm.visit_start_datetime + INTERVAL '24 hours'
    )
""")

cohort_check = await sql_query("""
    SELECT COUNT(*) AS n_visits, SUM(in_hospital_death) AS n_deaths
    FROM cohort
""")
print(f"Cohort: {cohort_check['n_visits'][0]} visits, "
      f"{cohort_check['n_deaths'][0]} deaths")

# ---------------------------------------------------------------------------
# Configuration: measurements to extract (concept_id → column prefix)
# ---------------------------------------------------------------------------
VITALS = {
    3027018:  "hr",           # Heart rate
    3004249:  "sbp",          # Systolic blood pressure
    3012888:  "dbp",          # Diastolic blood pressure
    3027598:  "mbp",          # Mean blood pressure
    3024171:  "resp_rate",    # Respiratory rate
    40762499: "spo2",         # SpO2 (pulse oximetry)
    3020891:  "temp",         # Body temperature
}

LABS = {
    3000963:  "hemoglobin",   # Hemoglobin
    3023314:  "hematocrit",   # Hematocrit
    3024929:  "platelets",    # Platelets
    3003282:  "wbc",          # White blood cells
    3019550:  "sodium",       # Sodium
    3023103:  "potassium",    # Potassium
    3014576:  "chloride",     # Chloride
    3016293:  "bicarbonate",  # Bicarbonate
    3016723:  "creatinine",   # Creatinine
    3013682:  "bun",          # Blood urea nitrogen
    3004501:  "glucose",      # Glucose
    3037278:  "anion_gap",    # Anion gap
    3015377:  "calcium",      # Calcium
    3012095:  "magnesium",    # Magnesium
    3011904:  "phosphate",    # Phosphate
}

NEURO = {
    3016335:  "gcs_eye",      # Glasgow Coma Scale - Eye
    3009094:  "gcs_verbal",   # Glasgow Coma Scale - Verbal
    3008223:  "gcs_motor",    # Glasgow Coma Scale - Motor
}

ALL_MEASUREMENTS = {**VITALS, **LABS, **NEURO}

# ---------------------------------------------------------------------------
# Step 2: Extract all measurements in the first 24 hours for cohort visits
# ---------------------------------------------------------------------------
concept_ids = ", ".join(str(cid) for cid in ALL_MEASUREMENTS.keys())

measurements_h24 = await sql_query(f"""
    SELECT
        m.visit_occurrence_id,
        m.measurement_concept_id,
        m.value_as_number,
        m.measurement_datetime::TIMESTAMP AS measurement_datetime,
        c.visit_start_datetime
    FROM measurement m
    JOIN cohort c ON m.visit_occurrence_id = c.visit_occurrence_id
    WHERE m.measurement_concept_id IN ({concept_ids})
      AND m.value_as_number IS NOT NULL
      AND m.measurement_datetime::TIMESTAMP >= c.visit_start_datetime
      AND m.measurement_datetime::TIMESTAMP <= c.visit_start_datetime + INTERVAL '24 hours'
""")

print(f"Measurements in H0-H24: {len(measurements_h24)} rows")

# ---------------------------------------------------------------------------
# Step 3: Aggregate — for each visit × measurement, compute summary stats
# ---------------------------------------------------------------------------

# Map concept_id to column name
measurements_h24["feature"] = measurements_h24["measurement_concept_id"].map(ALL_MEASUREMENTS)

# Aggregations: vitals → mean/min/max, labs → first value, neuro → min (worst)
vitals_ids = set(VITALS.keys())
labs_ids = set(LABS.keys())
neuro_ids = set(NEURO.keys())

aggregated_rows = []

for (visit_id, feature), group in measurements_h24.groupby(
    ["visit_occurrence_id", "feature"]
):
    concept_id = group["measurement_concept_id"].iloc[0]
    values = group.sort_values("measurement_datetime")["value_as_number"]

    if concept_id in vitals_ids:
        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_mean", "val": values.mean()})
        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_min",  "val": values.min()})
        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_max",  "val": values.max()})
    elif concept_id in neuro_ids:
        # For GCS, worst = minimum score
        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_min", "val": values.min()})
    elif concept_id in labs_ids:
        # First lab value in the first 24 hours
        aggregated_rows.append({"visit_occurrence_id": visit_id, "col": f"{feature}_first", "val": values.iloc[0]})

agg_df = pd.DataFrame(aggregated_rows)
print(f"Aggregated features: {len(agg_df)} rows, {agg_df['col'].nunique()} distinct columns")

# ---------------------------------------------------------------------------
# Step 4: Pivot to wide format
# ---------------------------------------------------------------------------
wide_features = agg_df.pivot_table(
    index="visit_occurrence_id",
    columns="col",
    values="val",
    aggfunc="first",
).reset_index()

# ---------------------------------------------------------------------------
# Step 5: Merge with cohort demographics
# ---------------------------------------------------------------------------
cohort_df = await sql_query("""
    SELECT visit_occurrence_id, person_id, age, sex, los_hours, in_hospital_death
    FROM cohort
""")

dataset = cohort_df.merge(wide_features, on="visit_occurrence_id", how="left")

# Sort columns: identifiers, demographics, outcome, vitals, labs, neuro
id_cols = ["visit_occurrence_id", "person_id"]
demo_cols = ["age", "sex", "los_hours"]
outcome_cols = ["in_hospital_death"]
feature_cols = sorted([c for c in dataset.columns if c not in id_cols + demo_cols + outcome_cols])
dataset = dataset[id_cols + demo_cols + outcome_cols + feature_cols]

print(f"\nFinal dataset: {dataset.shape[0]} rows x {dataset.shape[1]} columns")
print(f"Deaths: {dataset['in_hospital_death'].sum()} / {len(dataset)} "
      f"({100 * dataset['in_hospital_death'].mean():.1f}%)")
print(f"\nColumns: {list(dataset.columns)}")
print(f"\nMissing values per feature:")
print(dataset[feature_cols].isnull().sum().to_string())

# ---------------------------------------------------------------------------
# Step 6: Export CSV
# ---------------------------------------------------------------------------
output_path = "data/datasets/mortality_dataset.csv"
dataset.to_csv(output_path, index=False)
print(f"\nDataset saved to {output_path}")
