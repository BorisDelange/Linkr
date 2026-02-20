# =============================================================================
# 02_feature_engineering.py
# Mortality prediction project — Step 2: Feature engineering
#
# Reads the cohort view created by 01_cohort_extraction.sql, extracts
# measurements from the first 24 hours, pivots from OMOP long format
# to one-row-per-visit wide format, and exports a CSV.
#
# Uses sql_query(sql) which is automatically available in Linkr.
# It queries the active DuckDB connection and returns a pandas DataFrame.
# Usage: df = await sql_query("SELECT * FROM person LIMIT 10")
#
# Input:  DuckDB views (cohort, measurement, concept)
# Output: data/datasets/mortality_dataset.csv
# =============================================================================

import pandas as pd

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
# Step 1: Extract all measurements in the first 24 hours for cohort visits
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
# Step 2: Aggregate — for each visit × measurement, compute summary stats
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
# Step 3: Pivot to wide format
# ---------------------------------------------------------------------------
wide_features = agg_df.pivot_table(
    index="visit_occurrence_id",
    columns="col",
    values="val",
    aggfunc="first",
).reset_index()

# ---------------------------------------------------------------------------
# Step 4: Merge with cohort demographics
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
# Step 5: Export CSV
# ---------------------------------------------------------------------------
output_path = "data/datasets/mortality_dataset.csv"
dataset.to_csv(output_path, index=False)
print(f"\nDataset saved to {output_path}")
