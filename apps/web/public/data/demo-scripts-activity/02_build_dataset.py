# =============================================================================
# 02_build_dataset.py — ICU Activity Dashboard
#
# Builds a long-typed CSV from OMOP CDM data for the ICU activity dashboard.
# Each ICU stay gets a "stay" row (demographics, measurements, outcomes)
# plus event rows with domain-typed columns:
#   - cvc_type: CVC, PICC, Port, Central venous cannula
#   - imaging_type: Echocardiography, Chest X-ray, ECG, Ultrasonography
#   - respiratory_support: Mechanical ventilation (VNI, O2 if available)
#   - infection_type: Sepsis, Pneumonia, UTI, Bacteremia, etc.
#   - infection_pathogen: E. coli, MRSA, Klebsiella, etc. (same row as type)
#
# sql_query(sql) is automatically available in Linkr.
# It queries the active DuckDB connection and returns a pandas DataFrame.
# Usage: df = await sql_query("SELECT * FROM person LIMIT 10")
#
# Output: data/datasets/icu_activity.csv
# =============================================================================

import pandas as pd
import numpy as np

# Helper: sql_query() returns datetimes as strings in Pyodide/WASM.
# Convert datetime columns after each query.
def ensure_datetime(df, cols):
    """Convert string columns to pandas Timestamps (in-place)."""
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], utc=True)
    return df

def fmt_dt(val):
    """Format a datetime value (Timestamp or string) as 'YYYY-MM-DD HH:MM'."""
    if pd.isna(val) or val == '':
        return ''
    if isinstance(val, str):
        return val[:16]  # already formatted
    return val.strftime('%Y-%m-%d %H:%M')

# ---------------------------------------------------------------------------
# Step 1: Identify ICU stays (create view + fetch into DataFrame)
# ---------------------------------------------------------------------------
# Create the icu_stays view so downstream queries can JOIN it.
# This makes the script self-contained (no need to run 01_extract_icu_data.sql first).
await sql_query("DROP VIEW IF EXISTS icu_stays")
await sql_query("""
    CREATE VIEW icu_stays AS
    SELECT
        vd.visit_detail_id,
        vd.person_id,
        vd.visit_occurrence_id,
        vd.visit_detail_start_datetime::TIMESTAMP AS unit_admission_datetime,
        vd.visit_detail_end_datetime::TIMESTAMP   AS unit_discharge_datetime,
        ROUND(EXTRACT(EPOCH FROM (
            vd.visit_detail_end_datetime::TIMESTAMP
            - vd.visit_detail_start_datetime::TIMESTAMP
        )) / 86400.0, 2) AS unit_los,
        cs.care_site_name AS icu_unit,
        vd.admitting_source_value  AS origin_ward,
        vd.discharge_to_source_value AS destination_ward
    FROM visit_detail vd
    LEFT JOIN care_site cs ON cs.care_site_id = vd.care_site_id
    WHERE cs.care_site_name LIKE '%Intensive Care%'
       OR cs.care_site_name LIKE '%ICU%'
       OR cs.care_site_name LIKE '%CCU%'
""")
icu_stays = await sql_query("SELECT * FROM icu_stays ORDER BY person_id, unit_admission_datetime")
print(f"ICU stays: {len(icu_stays)} ({icu_stays['person_id'].nunique()} patients)")

# ---------------------------------------------------------------------------
# Step 2: Demographics + hospital stay + mortality
# ---------------------------------------------------------------------------
stays = await sql_query("""
    SELECT
        vd.visit_detail_id,
        vd.person_id,
        vd.visit_occurrence_id,
        p.gender_source_value AS sex,
        EXTRACT(YEAR FROM vd.visit_detail_start_datetime) - p.year_of_birth AS age,
        cs.care_site_name AS icu_unit,
        vd.admitting_source_value AS origin_ward,
        vd.discharge_to_source_value AS destination_ward,
        vo.visit_start_datetime::TIMESTAMP AS hospital_admission_datetime,
        vo.visit_end_datetime::TIMESTAMP   AS hospital_discharge_datetime,
        ROUND(EXTRACT(EPOCH FROM (
            vo.visit_end_datetime::TIMESTAMP - vo.visit_start_datetime::TIMESTAMP
        )) / 86400.0, 2) AS hospital_los,
        vd.visit_detail_start_datetime::TIMESTAMP AS unit_admission_datetime,
        vd.visit_detail_end_datetime::TIMESTAMP   AS unit_discharge_datetime,
        ROUND(EXTRACT(EPOCH FROM (
            vd.visit_detail_end_datetime::TIMESTAMP
            - vd.visit_detail_start_datetime::TIMESTAMP
        )) / 86400.0, 2) AS unit_los,
        CASE WHEN d.death_datetime IS NOT NULL
             AND d.death_datetime::TIMESTAMP
                 BETWEEN vd.visit_detail_start_datetime::TIMESTAMP
                     AND vd.visit_detail_end_datetime::TIMESTAMP + INTERVAL '1 day'
             THEN 1 ELSE 0 END AS deceased_in_icu,
        CASE WHEN d.death_datetime IS NOT NULL
             AND d.death_datetime::TIMESTAMP
                 BETWEEN vo.visit_start_datetime::TIMESTAMP
                     AND vo.visit_end_datetime::TIMESTAMP + INTERVAL '1 day'
             THEN 1 ELSE 0 END AS deceased_in_hospital,
        c.concept_name AS visit_type
    FROM visit_detail vd
    JOIN person p ON vd.person_id = p.person_id
    JOIN visit_occurrence vo ON vd.visit_occurrence_id = vo.visit_occurrence_id
    LEFT JOIN death d ON vd.person_id = d.person_id
    LEFT JOIN care_site cs ON cs.care_site_id = vd.care_site_id
    LEFT JOIN concept c ON c.concept_id = vd.visit_detail_concept_id
    WHERE cs.care_site_name LIKE '%Intensive Care%'
       OR cs.care_site_name LIKE '%ICU%'
       OR cs.care_site_name LIKE '%CCU%'
    ORDER BY vd.person_id, vd.visit_detail_start_datetime
""")

ensure_datetime(stays, [
    'hospital_admission_datetime', 'hospital_discharge_datetime',
    'unit_admission_datetime', 'unit_discharge_datetime',
])

# Readmission flag (<48h from previous discharge for same patient)
stays = stays.sort_values(['person_id', 'unit_admission_datetime'])
stays['is_readmission_48h'] = 0
for pid in stays['person_id'].unique():
    mask = stays['person_id'] == pid
    patient_stays = stays.loc[mask].copy()
    if len(patient_stays) > 1:
        for i in range(1, len(patient_stays)):
            prev_discharge = patient_stays.iloc[i-1]['unit_discharge_datetime']
            curr_admission = patient_stays.iloc[i]['unit_admission_datetime']
            if (curr_admission - prev_discharge).total_seconds() < 48 * 3600:
                stays.loc[patient_stays.index[i], 'is_readmission_48h'] = 1

print(f"Demographics: {len(stays)} stays, {stays['deceased_in_icu'].sum()} ICU deaths")

# ---------------------------------------------------------------------------
# Step 3: Measurements — aggregate per stay
# ---------------------------------------------------------------------------
MEAS_MAP = {
    3027018: 'heart_rate', 3004249: 'sbp', 3012888: 'dbp', 3027598: 'mbp',
    3024171: 'respiratory_rate', 40762499: 'spo2', 3020891: 'temperature',
    3000963: 'hemoglobin', 3023314: 'hematocrit', 3024929: 'platelets',
    3003282: 'wbc', 3019550: 'sodium', 3023103: 'potassium',
    3016293: 'bicarbonate', 3016723: 'creatinine', 3013682: 'bun',
    3004501: 'glucose', 3037278: 'anion_gap', 3015377: 'calcium',
    3012095: 'magnesium', 3011904: 'phosphate',
    21490854: 'tidal_volume', 3022875: 'peep', 21490753: 'minute_volume',
    21490650: 'peak_inspiratory_pressure', 36303946: 'plateau_pressure',
    3024882: 'fio2', 3017594: 'tidal_volume_spontaneous',
}

concept_ids = ', '.join(str(cid) for cid in MEAS_MAP.keys())

measurements = await sql_query(f"""
    SELECT s.visit_detail_id, m.measurement_concept_id,
           m.value_as_number, m.measurement_datetime::TIMESTAMP AS meas_dt
    FROM measurement m
    JOIN icu_stays s ON m.person_id = s.person_id
        AND m.measurement_datetime::TIMESTAMP >= s.unit_admission_datetime
        AND m.measurement_datetime::TIMESTAMP <= s.unit_discharge_datetime
    WHERE m.value_as_number IS NOT NULL
      AND m.measurement_concept_id IN ({concept_ids})
""")
ensure_datetime(measurements, ['meas_dt'])
measurements['feature'] = measurements['measurement_concept_id'].map(MEAS_MAP)
print(f"Measurements: {len(measurements)} rows")

VITALS = {'heart_rate', 'sbp', 'dbp', 'mbp', 'respiratory_rate', 'spo2', 'temperature'}
LABS = {'hemoglobin', 'hematocrit', 'platelets', 'wbc', 'sodium', 'potassium',
        'bicarbonate', 'creatinine', 'bun', 'glucose', 'anion_gap', 'calcium',
        'magnesium', 'phosphate'}
VENT = {'tidal_volume', 'fio2', 'peep', 'peak_inspiratory_pressure', 'plateau_pressure'}

agg_rows = []
for (vid, feat), grp in measurements.groupby(['visit_detail_id', 'feature']):
    vals = grp.sort_values('meas_dt')['value_as_number']
    if feat in VITALS:
        agg_rows.append({'visit_detail_id': vid, 'col': f'mean_{feat}', 'val': round(vals.mean(), 2)})
    elif feat in LABS:
        agg_rows.append({'visit_detail_id': vid, 'col': f'first_{feat}', 'val': round(vals.iloc[0], 2)})
        if feat == 'creatinine':
            agg_rows.append({'visit_detail_id': vid, 'col': 'max_creatinine', 'val': round(vals.max(), 2)})
    elif feat in VENT:
        agg_rows.append({'visit_detail_id': vid, 'col': f'mean_{feat}', 'val': round(vals.mean(), 2)})

meas_pivot = pd.DataFrame(agg_rows).pivot_table(
    index='visit_detail_id', columns='col', values='val', aggfunc='first'
).reset_index()

# GCS total
gcs_map = {3016335: 'gcs_eye', 3009094: 'gcs_verbal', 3008223: 'gcs_motor'}
gcs_ids = ', '.join(str(k) for k in gcs_map.keys())
gcs_meas = await sql_query(f"""
    SELECT s.visit_detail_id, m.measurement_concept_id, MIN(m.value_as_number) AS min_val
    FROM measurement m
    JOIN icu_stays s ON m.person_id = s.person_id
        AND m.measurement_datetime::TIMESTAMP >= s.unit_admission_datetime
        AND m.measurement_datetime::TIMESTAMP <= s.unit_discharge_datetime
    WHERE m.value_as_number IS NOT NULL AND m.measurement_concept_id IN ({gcs_ids})
    GROUP BY s.visit_detail_id, m.measurement_concept_id
""")
if len(gcs_meas) > 0:
    gcs_meas['feature'] = gcs_meas['measurement_concept_id'].map(gcs_map)
    gcs_pivot = gcs_meas.pivot_table(index='visit_detail_id', columns='feature', values='min_val').reset_index()
    gcs_cols = ['gcs_eye', 'gcs_verbal', 'gcs_motor']
    if all(c in gcs_pivot.columns for c in gcs_cols):
        gcs_pivot['gcs_total_min'] = gcs_pivot[gcs_cols].sum(axis=1)
        meas_pivot = meas_pivot.merge(gcs_pivot[['visit_detail_id', 'gcs_total_min']], on='visit_detail_id', how='left')

# Ventilation detection + duration
vent_ids = [21490854, 3022875, 21490650, 36303946]
vent_data = await sql_query(f"""
    SELECT s.visit_detail_id,
           MIN(m.measurement_datetime::TIMESTAMP) AS ventilation_start,
           MAX(m.measurement_datetime::TIMESTAMP) AS ventilation_end,
           COUNT(*) AS vent_count
    FROM measurement m
    JOIN icu_stays s ON m.person_id = s.person_id
        AND m.measurement_datetime::TIMESTAMP >= s.unit_admission_datetime
        AND m.measurement_datetime::TIMESTAMP <= s.unit_discharge_datetime
    WHERE m.value_as_number IS NOT NULL
      AND m.measurement_concept_id IN ({', '.join(str(v) for v in vent_ids)})
    GROUP BY s.visit_detail_id
""")
ensure_datetime(vent_data, ['ventilation_start', 'ventilation_end'])
vent_data['mechanical_ventilation'] = 1
vent_data['ventilation_duration_hours'] = (
    (vent_data['ventilation_end'] - vent_data['ventilation_start']).dt.total_seconds() / 3600
).round(1)
print(f"Ventilation: {len(vent_data)} stays")

# Merge into stays
stays = stays.merge(meas_pivot, on='visit_detail_id', how='left')
stays = stays.merge(
    vent_data[['visit_detail_id', 'mechanical_ventilation', 'ventilation_duration_hours',
               'ventilation_start', 'ventilation_end']],
    on='visit_detail_id', how='left'
)
stays['mechanical_ventilation'] = stays['mechanical_ventilation'].fillna(0).astype(int)

# ---------------------------------------------------------------------------
# Step 4: Domain-typed events
# ---------------------------------------------------------------------------

# Helper: ensure a DataFrame has expected columns even when empty
def ensure_columns(df, cols):
    """Add missing columns (as NaN) so downstream code can always filter."""
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    return df

# CVC (vascular access)
cvc_events = await sql_query("""
    SELECT s.visit_detail_id,
           po.procedure_datetime::TIMESTAMP AS event_datetime,
           CASE po.procedure_concept_id
               WHEN 4141149 THEN 'CVC'
               WHEN 4322380 THEN 'PICC'
               WHEN 4197894 THEN 'Port'
               WHEN 4052413 THEN 'Central venous cannula'
           END AS cvc_type
    FROM procedure_occurrence po
    JOIN icu_stays s ON po.person_id = s.person_id
        AND po.procedure_datetime::TIMESTAMP >= s.unit_admission_datetime
        AND po.procedure_datetime::TIMESTAMP <= s.unit_discharge_datetime
    WHERE po.procedure_concept_id IN (4141149, 4322380, 4197894, 4052413)
""")
ensure_columns(cvc_events, ['visit_detail_id', 'event_datetime', 'cvc_type'])
ensure_datetime(cvc_events, ['event_datetime'])
print(f"CVC events: {len(cvc_events)}")

# Imaging
imaging_events = await sql_query("""
    SELECT s.visit_detail_id,
           po.procedure_datetime::TIMESTAMP AS event_datetime,
           CASE po.procedure_concept_id
               WHEN 4335825 THEN 'Echocardiography'
               WHEN 4037672 THEN 'Ultrasonography'
               WHEN 4163872 THEN 'Chest X-ray'
               WHEN 4163951 THEN 'ECG'
           END AS imaging_type
    FROM procedure_occurrence po
    JOIN icu_stays s ON po.person_id = s.person_id
        AND po.procedure_datetime::TIMESTAMP >= s.unit_admission_datetime
        AND po.procedure_datetime::TIMESTAMP <= s.unit_discharge_datetime
    WHERE po.procedure_concept_id IN (4335825, 4037672, 4163872, 4163951)
""")
ensure_columns(imaging_events, ['visit_detail_id', 'event_datetime', 'imaging_type'])
ensure_datetime(imaging_events, ['event_datetime'])
print(f"Imaging events: {len(imaging_events)}")

# Infections (type + pathogen separated)
infection_events = await sql_query("""
    SELECT s.visit_detail_id,
           co.condition_start_datetime::TIMESTAMP AS event_datetime,
           CASE co.condition_concept_id
               WHEN 81902    THEN 'Urinary tract infection'
               WHEN 132797   THEN 'Sepsis'
               WHEN 255848   THEN 'Pneumonia'
               WHEN 437474   THEN 'Postoperative infection'
               WHEN 132736   THEN 'Bacteremia'
               WHEN 40487064 THEN 'Sepsis'
               WHEN 40489908 THEN 'Sepsis'
               WHEN 40493038 THEN 'Sepsis'
               WHEN 253790   THEN 'Pneumonia'
               WHEN 257315   THEN 'Pneumonia'
               WHEN 259852   THEN 'Pneumonia'
               WHEN 193688   THEN 'Infection'
               WHEN 440320   THEN 'Infection'
               WHEN 438064   THEN 'Infection'
               WHEN 440940   THEN 'Infection'
               WHEN 40481816 THEN 'Infection'
           END AS infection_type,
           CASE co.condition_concept_id
               WHEN 40487064 THEN 'E. coli'
               WHEN 40489908 THEN 'Streptococcus'
               WHEN 40493038 THEN 'Gram-negative'
               WHEN 253790   THEN 'Klebsiella'
               WHEN 259852   THEN 'Staphylococcus'
               WHEN 193688   THEN 'C. difficile'
               WHEN 440320   THEN 'E. coli'
               WHEN 438064   THEN 'Pseudomonas'
               WHEN 440940   THEN 'MRSA'
               WHEN 40481816 THEN 'MSSA'
               ELSE NULL
           END AS infection_pathogen
    FROM condition_occurrence co
    JOIN icu_stays s ON co.person_id = s.person_id
        AND co.condition_start_datetime::TIMESTAMP >= s.unit_admission_datetime
        AND co.condition_start_datetime::TIMESTAMP <= s.unit_discharge_datetime + INTERVAL '1 day'
    WHERE co.condition_concept_id IN (
        81902, 132797, 255848, 193688, 440320, 438064, 437474, 132736,
        40487064, 440940, 40489908, 40481816, 253790, 40493038, 257315, 259852
    )
""")
ensure_columns(infection_events, ['visit_detail_id', 'event_datetime', 'infection_type', 'infection_pathogen'])
ensure_datetime(infection_events, ['event_datetime'])
print(f"Infection events: {len(infection_events)}")

# ---------------------------------------------------------------------------
# Step 5: Build long-typed output with domain columns
# ---------------------------------------------------------------------------
STAY_FIELDS = [
    'person_id', 'visit_occurrence_id', 'visit_detail_id',
    'sex', 'age', 'icu_unit',
    'origin_ward', 'destination_ward',
    'hospital_admission_datetime', 'hospital_discharge_datetime', 'hospital_los',
    'unit_admission_datetime', 'unit_discharge_datetime', 'unit_los',
    'deceased_in_icu', 'deceased_in_hospital', 'is_readmission_48h', 'visit_type',
]

MEAS_FIELDS = [
    'mean_heart_rate', 'mean_respiratory_rate', 'mean_spo2',
    'mean_sbp', 'mean_dbp', 'mean_mbp', 'mean_temperature',
    'first_creatinine', 'max_creatinine', 'first_potassium', 'first_sodium',
    'first_hemoglobin', 'first_hematocrit', 'first_platelets', 'first_wbc',
    'first_glucose', 'first_bun', 'first_bicarbonate',
    'first_anion_gap', 'first_magnesium', 'first_calcium', 'first_phosphate',
    'gcs_total_min',
    'mechanical_ventilation', 'ventilation_duration_hours',
    'mean_tidal_volume', 'mean_peep', 'mean_fio2',
    'mean_peak_inspiratory_pressure', 'mean_plateau_pressure',
]

EVENT_FIELDS = [
    'event_start_datetime', 'event_end_datetime',
    'cvc_type', 'imaging_type', 'respiratory_support',
    'infection_type', 'infection_pathogen',
]

available_meas = [c for c in MEAS_FIELDS if c in stays.columns]
ALL_FIELDS = STAY_FIELDS + available_meas + EVENT_FIELDS

def fmt(val):
    if pd.isna(val): return ''
    if isinstance(val, pd.Timestamp): return fmt_dt(val)
    if isinstance(val, float): return round(val, 2)
    return val

all_rows = []
for _, row in stays.iterrows():
    base = {f: fmt(row.get(f, '')) for f in STAY_FIELDS + available_meas}
    vid = row['visit_detail_id']

    # Stay row
    all_rows.append({**{f: '' for f in ALL_FIELDS}, **base})

    # Ventilation event
    if row.get('mechanical_ventilation', 0) == 1:
        evt = {f: '' for f in EVENT_FIELDS}
        evt['respiratory_support'] = 'Mechanical ventilation'
        if pd.notna(row.get('ventilation_start')):
            evt['event_start_datetime'] = fmt_dt(row['ventilation_start'])
        if pd.notna(row.get('ventilation_end')):
            evt['event_end_datetime'] = fmt_dt(row['ventilation_end'])
        all_rows.append({**{f: '' for f in ALL_FIELDS}, **base, **evt})

    # CVC events
    for _, e in cvc_events[cvc_events['visit_detail_id'] == vid].iterrows():
        evt = {f: '' for f in EVENT_FIELDS}
        evt['cvc_type'] = e['cvc_type']
        if pd.notna(e['event_datetime']):
            evt['event_start_datetime'] = fmt_dt(e['event_datetime'])
        all_rows.append({**{f: '' for f in ALL_FIELDS}, **base, **evt})

    # Imaging events
    for _, e in imaging_events[imaging_events['visit_detail_id'] == vid].iterrows():
        evt = {f: '' for f in EVENT_FIELDS}
        evt['imaging_type'] = e['imaging_type']
        if pd.notna(e['event_datetime']):
            evt['event_start_datetime'] = fmt_dt(e['event_datetime'])
        all_rows.append({**{f: '' for f in ALL_FIELDS}, **base, **evt})

    # Infection events (type + pathogen on the same row)
    for _, e in infection_events[infection_events['visit_detail_id'] == vid].iterrows():
        evt = {f: '' for f in EVENT_FIELDS}
        evt['infection_type'] = e['infection_type']
        if pd.notna(e.get('infection_pathogen')):
            evt['infection_pathogen'] = e['infection_pathogen']
        if pd.notna(e['event_datetime']):
            evt['event_start_datetime'] = fmt_dt(e['event_datetime'])
        all_rows.append({**{f: '' for f in ALL_FIELDS}, **base, **evt})

df_out = pd.DataFrame(all_rows, columns=ALL_FIELDS)

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
has_event = (df_out['cvc_type'] != '') | (df_out['imaging_type'] != '') | \
            (df_out['respiratory_support'] != '') | (df_out['infection_type'] != '')
stay_df = df_out[~has_event]
print(f"\n{'='*50}")
print(f"Dataset: {len(df_out)} rows x {len(ALL_FIELDS)} columns")
print(f"  Stay rows:       {len(stay_df)}")
print(f"  CVC events:      {(df_out['cvc_type'] != '').sum()}")
print(f"  Imaging:         {(df_out['imaging_type'] != '').sum()}")
print(f"  Resp. support:   {(df_out['respiratory_support'] != '').sum()}")
print(f"  Infections:      {(df_out['infection_type'] != '').sum()}")
print(f"{'='*50}")

# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
output_path = "data/datasets/icu_activity.csv"
df_out.to_csv(output_path, index=False)
print(f"\nSaved to {output_path}")
