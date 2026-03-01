-- =============================================================================
-- 01_extract_icu_data.sql — ICU Activity Dashboard
--
-- Extracts ICU activity data from OMOP CDM tables.
-- This script creates views for each data layer:
--   1. ICU stays (from visit_detail + care_site)
--   2. Demographics (from person + death)
--   3. Measurements (vitals, labs, ventilation parameters)
--   4. Events by domain: CVC, imaging, infections
--
-- Designed for MIMIC-IV Demo (OMOP CDM v5.4) with DuckDB.
--
-- Note: DROP VIEW before CREATE to avoid DuckDB-WASM type mismatch
-- errors when column types change between runs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Identify ICU stays from visit_detail + care_site
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS icu_infections;
DROP VIEW IF EXISTS icu_imaging;
DROP VIEW IF EXISTS icu_cvc;
DROP VIEW IF EXISTS icu_measurements;
DROP VIEW IF EXISTS icu_demographics;
DROP VIEW IF EXISTS icu_stays;

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
ORDER BY vd.person_id, vd.visit_detail_start_datetime;

-- Quick check
SELECT
    COUNT(*) AS n_stays,
    COUNT(DISTINCT person_id) AS n_patients,
    COUNT(DISTINCT icu_unit) AS n_units,
    ROUND(AVG(unit_los), 1) AS mean_los
FROM icu_stays;

-- ---------------------------------------------------------------------------
-- 2. Demographics + hospital stay + mortality
-- ---------------------------------------------------------------------------
CREATE VIEW icu_demographics AS
SELECT
    s.*,
    p.gender_source_value AS sex,
    EXTRACT(YEAR FROM s.unit_admission_datetime) - p.year_of_birth AS age,
    -- Hospital-level dates
    vo.visit_start_datetime::TIMESTAMP AS hospital_admission_datetime,
    vo.visit_end_datetime::TIMESTAMP   AS hospital_discharge_datetime,
    ROUND(EXTRACT(EPOCH FROM (
        vo.visit_end_datetime::TIMESTAMP - vo.visit_start_datetime::TIMESTAMP
    )) / 86400.0, 2) AS hospital_los,
    -- Mortality flags
    CASE WHEN d.death_datetime IS NOT NULL
         AND d.death_datetime::TIMESTAMP
             BETWEEN s.unit_admission_datetime
                 AND s.unit_discharge_datetime + INTERVAL '1 day'
         THEN 1 ELSE 0 END AS deceased_in_icu,
    CASE WHEN d.death_datetime IS NOT NULL
         AND d.death_datetime::TIMESTAMP
             BETWEEN vo.visit_start_datetime::TIMESTAMP
                 AND vo.visit_end_datetime::TIMESTAMP + INTERVAL '1 day'
         THEN 1 ELSE 0 END AS deceased_in_hospital
FROM icu_stays s
JOIN person p ON s.person_id = p.person_id
JOIN visit_occurrence vo ON s.visit_occurrence_id = vo.visit_occurrence_id
LEFT JOIN death d ON s.person_id = d.person_id;

SELECT
    COUNT(*) AS n_stays,
    SUM(deceased_in_icu) AS icu_deaths,
    SUM(deceased_in_hospital) AS hospital_deaths,
    ROUND(AVG(age), 1) AS mean_age
FROM icu_demographics;

-- ---------------------------------------------------------------------------
-- 3. Measurements during ICU stay: vitals, labs, ventilation
-- ---------------------------------------------------------------------------
CREATE VIEW icu_measurements AS
SELECT
    m.visit_occurrence_id,
    s.visit_detail_id,
    m.measurement_concept_id,
    c.concept_name AS measurement_name,
    m.value_as_number,
    m.measurement_datetime::TIMESTAMP AS measurement_datetime
FROM measurement m
JOIN icu_stays s
    ON m.person_id = s.person_id
    AND m.measurement_datetime::TIMESTAMP >= s.unit_admission_datetime
    AND m.measurement_datetime::TIMESTAMP <= s.unit_discharge_datetime
JOIN concept c ON c.concept_id = m.measurement_concept_id
WHERE m.value_as_number IS NOT NULL
  AND m.measurement_concept_id IN (
    -- Vitals
    3027018,  -- Heart rate
    3004249,  -- SBP
    3012888,  -- DBP
    3027598,  -- MBP
    3024171,  -- Respiratory rate
    40762499, -- SpO2
    3020891,  -- Temperature
    -- Labs
    3000963,  -- Hemoglobin
    3023314,  -- Hematocrit
    3024929,  -- Platelets
    3003282,  -- WBC
    3019550,  -- Sodium
    3023103,  -- Potassium
    3016293,  -- Bicarbonate
    3016723,  -- Creatinine
    3013682,  -- BUN
    3004501,  -- Glucose
    3037278,  -- Anion gap
    3015377,  -- Calcium
    3012095,  -- Magnesium
    3011904,  -- Phosphate
    -- Ventilation parameters
    21490854, -- Tidal volume
    3012398,  -- FiO2
    3022875,  -- PEEP
    21490650, -- Peak inspiratory pressure
    36303946  -- Plateau pressure
  );

SELECT
    COUNT(*) AS total_measurements,
    COUNT(DISTINCT visit_detail_id) AS stays_with_measurements,
    COUNT(DISTINCT measurement_concept_id) AS distinct_concepts
FROM icu_measurements;

-- ---------------------------------------------------------------------------
-- 4. Vascular access procedures (CVC, PICC, Port)
-- ---------------------------------------------------------------------------
CREATE VIEW icu_cvc AS
SELECT
    s.visit_detail_id,
    po.procedure_datetime::TIMESTAMP AS event_datetime,
    CASE po.procedure_concept_id
        WHEN 4141149 THEN 'CVC'
        WHEN 4322380 THEN 'PICC'
        WHEN 4197894 THEN 'Port'
        WHEN 4052413 THEN 'Central venous cannula'
    END AS cvc_type
FROM procedure_occurrence po
JOIN icu_stays s
    ON po.person_id = s.person_id
    AND po.procedure_datetime::TIMESTAMP >= s.unit_admission_datetime
    AND po.procedure_datetime::TIMESTAMP <= s.unit_discharge_datetime
WHERE po.procedure_concept_id IN (4141149, 4322380, 4197894, 4052413);

SELECT cvc_type, COUNT(*) AS n FROM icu_cvc GROUP BY cvc_type ORDER BY n DESC;

-- ---------------------------------------------------------------------------
-- 5. Imaging procedures
-- ---------------------------------------------------------------------------
CREATE VIEW icu_imaging AS
SELECT
    s.visit_detail_id,
    po.procedure_datetime::TIMESTAMP AS event_datetime,
    CASE po.procedure_concept_id
        WHEN 4335825 THEN 'Echocardiography'
        WHEN 4037672 THEN 'Ultrasonography'
        WHEN 4163872 THEN 'Chest X-ray'
        WHEN 4163951 THEN 'ECG'
    END AS imaging_type
FROM procedure_occurrence po
JOIN icu_stays s
    ON po.person_id = s.person_id
    AND po.procedure_datetime::TIMESTAMP >= s.unit_admission_datetime
    AND po.procedure_datetime::TIMESTAMP <= s.unit_discharge_datetime
WHERE po.procedure_concept_id IN (4335825, 4037672, 4163872, 4163951);

SELECT imaging_type, COUNT(*) AS n FROM icu_imaging GROUP BY imaging_type ORDER BY n DESC;

-- ---------------------------------------------------------------------------
-- 6. Infections (conditions linked to ICU stays)
--    Separates infection type from pathogen on the same row.
-- ---------------------------------------------------------------------------
CREATE VIEW icu_infections AS
SELECT
    s.visit_detail_id,
    co.condition_start_datetime::TIMESTAMP AS event_datetime,
    -- Infection type (site/syndrome)
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
    -- Pathogen (when specified in the concept)
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
JOIN icu_stays s
    ON co.person_id = s.person_id
    AND co.condition_start_datetime::TIMESTAMP >= s.unit_admission_datetime
    AND co.condition_start_datetime::TIMESTAMP <= s.unit_discharge_datetime + INTERVAL '1 day'
WHERE co.condition_concept_id IN (
    81902, 132797, 255848, 193688, 440320, 438064, 437474, 132736,
    40487064, 440940, 40489908, 40481816, 253790, 40493038, 257315, 259852
);

SELECT infection_type, infection_pathogen, COUNT(*) AS n
FROM icu_infections GROUP BY infection_type, infection_pathogen ORDER BY infection_type, n DESC;
