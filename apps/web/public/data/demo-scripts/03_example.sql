-- =============================================================================
-- 01_cohort_extraction.sql
-- Mortality prediction project — Step 1: Cohort extraction
--
-- Selects hospital stays >= 24 hours with at least one measurement in the
-- first 24 hours. Computes demographics and in-hospital mortality outcome.
--
-- Output: VIEW cohort (one row per eligible visit)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Eligible visits: hospital stays lasting at least 24 hours
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW eligible_visits AS
SELECT
    v.visit_occurrence_id,
    v.person_id,
    v.visit_concept_id,
    v.visit_start_date,
    v.visit_start_datetime::TIMESTAMP AS visit_start_datetime,
    v.visit_end_date,
    v.visit_end_datetime::TIMESTAMP   AS visit_end_datetime,
    v.discharge_to_concept_id,
    -- Length of stay in hours
    EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP - v.visit_start_datetime::TIMESTAMP)) / 3600
        AS los_hours
FROM visit_occurrence v
WHERE
    -- Stay >= 24 hours
    EXTRACT(EPOCH FROM (v.visit_end_datetime::TIMESTAMP - v.visit_start_datetime::TIMESTAMP)) / 3600 >= 24;

-- ---------------------------------------------------------------------------
-- 2. In-hospital mortality: match death date within the visit window
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW visit_mortality AS
SELECT
    ev.*,
    CASE
        WHEN d.death_date IS NOT NULL
         AND d.death_date BETWEEN ev.visit_start_date
                               AND ev.visit_end_date + INTERVAL '1 day'
        THEN 1
        ELSE 0
    END AS in_hospital_death
FROM eligible_visits ev
LEFT JOIN death d ON ev.person_id = d.person_id;

-- ---------------------------------------------------------------------------
-- 3. Demographics: age at admission, sex
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW cohort AS
SELECT
    vm.visit_occurrence_id,
    vm.person_id,
    vm.visit_start_datetime,
    -- Age = visit year - birth year (MIMIC dates are shifted but internally consistent)
    EXTRACT(YEAR FROM vm.visit_start_date) - p.year_of_birth AS age,
    p.gender_source_value                                     AS sex,
    vm.los_hours,
    vm.in_hospital_death
FROM visit_mortality vm
JOIN person p ON vm.person_id = p.person_id
-- Keep only visits that have at least one numeric measurement in H0-H24
WHERE EXISTS (
    SELECT 1
    FROM measurement m
    WHERE m.visit_occurrence_id = vm.visit_occurrence_id
      AND m.value_as_number IS NOT NULL
      AND m.measurement_datetime::TIMESTAMP >= vm.visit_start_datetime
      AND m.measurement_datetime::TIMESTAMP <= vm.visit_start_datetime + INTERVAL '24 hours'
);

-- ---------------------------------------------------------------------------
-- Quick check
-- ---------------------------------------------------------------------------
SELECT
    COUNT(*)                                       AS n_visits,
    COUNT(DISTINCT person_id)                      AS n_patients,
    SUM(in_hospital_death)                         AS n_deaths,
    ROUND(100.0 * SUM(in_hospital_death) / COUNT(*), 1) AS mortality_pct,
    ROUND(AVG(age), 1)                             AS mean_age,
    ROUND(AVG(los_hours), 1)                       AS mean_los_hours
FROM cohort;
