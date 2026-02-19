/**
 * OMOP CDM v5.4 complete DDL for DuckDB.
 * Source: https://github.com/OHDSI/CommonDataModel/tree/main/inst/ddl/5.4/duckdb
 *
 * Includes: CREATE TABLE, FOREIGN KEY constraints, indices.
 * Primary keys are inline in CREATE TABLE statements.
 * Schema placeholder (@cdmDatabaseSchema) removed.
 * HINT comments removed (distribution hints for MPP engines, ignored by DuckDB).
 */
export const OMOP_54_DDL = `-- OMOP CDM v5.4 DDL (DuckDB)
-- https://github.com/OHDSI/CommonDataModel

-- ============================================================
-- Clinical Data Tables
-- ============================================================

CREATE TABLE person (
  person_id integer NOT NULL PRIMARY KEY,
  gender_concept_id integer NOT NULL,
  year_of_birth integer NOT NULL,
  month_of_birth integer NULL,
  day_of_birth integer NULL,
  birth_datetime TIMESTAMP NULL,
  race_concept_id integer NOT NULL,
  ethnicity_concept_id integer NOT NULL,
  location_id integer NULL,
  provider_id integer NULL,
  care_site_id integer NULL,
  person_source_value varchar(50) NULL,
  gender_source_value varchar(50) NULL,
  gender_source_concept_id integer NULL,
  race_source_value varchar(50) NULL,
  race_source_concept_id integer NULL,
  ethnicity_source_value varchar(50) NULL,
  ethnicity_source_concept_id integer NULL
);

CREATE TABLE observation_period (
  observation_period_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  observation_period_start_date date NOT NULL,
  observation_period_end_date date NOT NULL,
  period_type_concept_id integer NOT NULL
);

CREATE TABLE visit_occurrence (
  visit_occurrence_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  visit_concept_id integer NOT NULL,
  visit_start_date date NOT NULL,
  visit_start_datetime TIMESTAMP NULL,
  visit_end_date date NOT NULL,
  visit_end_datetime TIMESTAMP NULL,
  visit_type_concept_id integer NOT NULL,
  provider_id integer NULL,
  care_site_id integer NULL,
  visit_source_value varchar(50) NULL,
  visit_source_concept_id integer NULL,
  admitted_from_concept_id integer NULL,
  admitted_from_source_value varchar(50) NULL,
  discharged_to_concept_id integer NULL,
  discharged_to_source_value varchar(50) NULL,
  preceding_visit_occurrence_id integer NULL
);

CREATE TABLE visit_detail (
  visit_detail_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  visit_detail_concept_id integer NOT NULL,
  visit_detail_start_date date NOT NULL,
  visit_detail_start_datetime TIMESTAMP NULL,
  visit_detail_end_date date NOT NULL,
  visit_detail_end_datetime TIMESTAMP NULL,
  visit_detail_type_concept_id integer NOT NULL,
  provider_id integer NULL,
  care_site_id integer NULL,
  visit_detail_source_value varchar(50) NULL,
  visit_detail_source_concept_id integer NULL,
  admitted_from_concept_id integer NULL,
  admitted_from_source_value varchar(50) NULL,
  discharged_to_source_value varchar(50) NULL,
  discharged_to_concept_id integer NULL,
  preceding_visit_detail_id integer NULL,
  parent_visit_detail_id integer NULL,
  visit_occurrence_id integer NOT NULL
);

CREATE TABLE condition_occurrence (
  condition_occurrence_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  condition_concept_id integer NOT NULL,
  condition_start_date date NOT NULL,
  condition_start_datetime TIMESTAMP NULL,
  condition_end_date date NULL,
  condition_end_datetime TIMESTAMP NULL,
  condition_type_concept_id integer NOT NULL,
  condition_status_concept_id integer NULL,
  stop_reason varchar(20) NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  condition_source_value varchar(50) NULL,
  condition_source_concept_id integer NULL,
  condition_status_source_value varchar(50) NULL
);

CREATE TABLE drug_exposure (
  drug_exposure_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  drug_concept_id integer NOT NULL,
  drug_exposure_start_date date NOT NULL,
  drug_exposure_start_datetime TIMESTAMP NULL,
  drug_exposure_end_date date NOT NULL,
  drug_exposure_end_datetime TIMESTAMP NULL,
  verbatim_end_date date NULL,
  drug_type_concept_id integer NOT NULL,
  stop_reason varchar(20) NULL,
  refills integer NULL,
  quantity NUMERIC NULL,
  days_supply integer NULL,
  sig TEXT NULL,
  route_concept_id integer NULL,
  lot_number varchar(50) NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  drug_source_value varchar(50) NULL,
  drug_source_concept_id integer NULL,
  route_source_value varchar(50) NULL,
  dose_unit_source_value varchar(50) NULL
);

CREATE TABLE procedure_occurrence (
  procedure_occurrence_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  procedure_concept_id integer NOT NULL,
  procedure_date date NOT NULL,
  procedure_datetime TIMESTAMP NULL,
  procedure_end_date date NULL,
  procedure_end_datetime TIMESTAMP NULL,
  procedure_type_concept_id integer NOT NULL,
  modifier_concept_id integer NULL,
  quantity integer NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  procedure_source_value varchar(50) NULL,
  procedure_source_concept_id integer NULL,
  modifier_source_value varchar(50) NULL
);

CREATE TABLE device_exposure (
  device_exposure_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  device_concept_id integer NOT NULL,
  device_exposure_start_date date NOT NULL,
  device_exposure_start_datetime TIMESTAMP NULL,
  device_exposure_end_date date NULL,
  device_exposure_end_datetime TIMESTAMP NULL,
  device_type_concept_id integer NOT NULL,
  unique_device_id varchar(255) NULL,
  production_id varchar(255) NULL,
  quantity integer NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  device_source_value varchar(50) NULL,
  device_source_concept_id integer NULL,
  unit_concept_id integer NULL,
  unit_source_value varchar(50) NULL,
  unit_source_concept_id integer NULL
);

CREATE TABLE measurement (
  measurement_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  measurement_concept_id integer NOT NULL,
  measurement_date date NOT NULL,
  measurement_datetime TIMESTAMP NULL,
  measurement_time varchar(10) NULL,
  measurement_type_concept_id integer NOT NULL,
  operator_concept_id integer NULL,
  value_as_number NUMERIC NULL,
  value_as_concept_id integer NULL,
  unit_concept_id integer NULL,
  range_low NUMERIC NULL,
  range_high NUMERIC NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  measurement_source_value varchar(50) NULL,
  measurement_source_concept_id integer NULL,
  unit_source_value varchar(50) NULL,
  unit_source_concept_id integer NULL,
  value_source_value varchar(50) NULL,
  measurement_event_id integer NULL,
  meas_event_field_concept_id integer NULL
);

CREATE TABLE observation (
  observation_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  observation_concept_id integer NOT NULL,
  observation_date date NOT NULL,
  observation_datetime TIMESTAMP NULL,
  observation_type_concept_id integer NOT NULL,
  value_as_number NUMERIC NULL,
  value_as_string varchar(60) NULL,
  value_as_concept_id integer NULL,
  qualifier_concept_id integer NULL,
  unit_concept_id integer NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  observation_source_value varchar(50) NULL,
  observation_source_concept_id integer NULL,
  unit_source_value varchar(50) NULL,
  qualifier_source_value varchar(50) NULL,
  value_source_value varchar(50) NULL,
  observation_event_id integer NULL,
  obs_event_field_concept_id integer NULL
);

CREATE TABLE death (
  person_id integer NOT NULL,
  death_date date NOT NULL,
  death_datetime TIMESTAMP NULL,
  death_type_concept_id integer NULL,
  cause_concept_id integer NULL,
  cause_source_value varchar(50) NULL,
  cause_source_concept_id integer NULL
);

CREATE TABLE note (
  note_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  note_date date NOT NULL,
  note_datetime TIMESTAMP NULL,
  note_type_concept_id integer NOT NULL,
  note_class_concept_id integer NOT NULL,
  note_title varchar(250) NULL,
  note_text TEXT NOT NULL,
  encoding_concept_id integer NOT NULL,
  language_concept_id integer NOT NULL,
  provider_id integer NULL,
  visit_occurrence_id integer NULL,
  visit_detail_id integer NULL,
  note_source_value varchar(50) NULL,
  note_event_id integer NULL,
  note_event_field_concept_id integer NULL
);

CREATE TABLE note_nlp (
  note_nlp_id integer NOT NULL PRIMARY KEY,
  note_id integer NOT NULL,
  section_concept_id integer NULL,
  snippet varchar(250) NULL,
  "offset" varchar(50) NULL,
  lexical_variant varchar(250) NOT NULL,
  note_nlp_concept_id integer NULL,
  note_nlp_source_concept_id integer NULL,
  nlp_system varchar(250) NULL,
  nlp_date date NOT NULL,
  nlp_datetime TIMESTAMP NULL,
  term_exists varchar(1) NULL,
  term_temporal varchar(50) NULL,
  term_modifiers varchar(2000) NULL
);

CREATE TABLE specimen (
  specimen_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  specimen_concept_id integer NOT NULL,
  specimen_type_concept_id integer NOT NULL,
  specimen_date date NOT NULL,
  specimen_datetime TIMESTAMP NULL,
  quantity NUMERIC NULL,
  unit_concept_id integer NULL,
  anatomic_site_concept_id integer NULL,
  disease_status_concept_id integer NULL,
  specimen_source_id varchar(50) NULL,
  specimen_source_value varchar(50) NULL,
  unit_source_value varchar(50) NULL,
  anatomic_site_source_value varchar(50) NULL,
  disease_status_source_value varchar(50) NULL
);

CREATE TABLE fact_relationship (
  domain_concept_id_1 integer NOT NULL,
  fact_id_1 integer NOT NULL,
  domain_concept_id_2 integer NOT NULL,
  fact_id_2 integer NOT NULL,
  relationship_concept_id integer NOT NULL
);

-- ============================================================
-- Health System Tables
-- ============================================================

CREATE TABLE location (
  location_id integer NOT NULL PRIMARY KEY,
  address_1 varchar(50) NULL,
  address_2 varchar(50) NULL,
  city varchar(50) NULL,
  state varchar(2) NULL,
  zip varchar(9) NULL,
  county varchar(20) NULL,
  location_source_value varchar(50) NULL,
  country_concept_id integer NULL,
  country_source_value varchar(80) NULL,
  latitude NUMERIC NULL,
  longitude NUMERIC NULL
);

CREATE TABLE care_site (
  care_site_id integer NOT NULL PRIMARY KEY,
  care_site_name varchar(255) NULL,
  place_of_service_concept_id integer NULL,
  location_id integer NULL,
  care_site_source_value varchar(50) NULL,
  place_of_service_source_value varchar(50) NULL
);

CREATE TABLE provider (
  provider_id integer NOT NULL PRIMARY KEY,
  provider_name varchar(255) NULL,
  npi varchar(20) NULL,
  dea varchar(20) NULL,
  specialty_concept_id integer NULL,
  care_site_id integer NULL,
  year_of_birth integer NULL,
  gender_concept_id integer NULL,
  provider_source_value varchar(50) NULL,
  specialty_source_value varchar(50) NULL,
  specialty_source_concept_id integer NULL,
  gender_source_value varchar(50) NULL,
  gender_source_concept_id integer NULL
);

-- ============================================================
-- Health Economics Tables
-- ============================================================

CREATE TABLE payer_plan_period (
  payer_plan_period_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  payer_plan_period_start_date date NOT NULL,
  payer_plan_period_end_date date NOT NULL,
  payer_concept_id integer NULL,
  payer_source_value varchar(50) NULL,
  payer_source_concept_id integer NULL,
  plan_concept_id integer NULL,
  plan_source_value varchar(50) NULL,
  plan_source_concept_id integer NULL,
  sponsor_concept_id integer NULL,
  sponsor_source_value varchar(50) NULL,
  sponsor_source_concept_id integer NULL,
  family_source_value varchar(50) NULL,
  stop_reason_concept_id integer NULL,
  stop_reason_source_value varchar(50) NULL,
  stop_reason_source_concept_id integer NULL
);

CREATE TABLE cost (
  cost_id integer NOT NULL PRIMARY KEY,
  cost_event_id integer NOT NULL,
  cost_domain_id varchar(20) NOT NULL,
  cost_type_concept_id integer NOT NULL,
  currency_concept_id integer NULL,
  total_charge NUMERIC NULL,
  total_cost NUMERIC NULL,
  total_paid NUMERIC NULL,
  paid_by_payer NUMERIC NULL,
  paid_by_patient NUMERIC NULL,
  paid_patient_copay NUMERIC NULL,
  paid_patient_coinsurance NUMERIC NULL,
  paid_patient_deductible NUMERIC NULL,
  paid_by_primary NUMERIC NULL,
  paid_ingredient_cost NUMERIC NULL,
  paid_dispensing_fee NUMERIC NULL,
  payer_plan_period_id integer NULL,
  amount_allowed NUMERIC NULL,
  revenue_code_concept_id integer NULL,
  revenue_code_source_value varchar(50) NULL,
  drg_concept_id integer NULL,
  drg_source_value varchar(3) NULL
);

-- ============================================================
-- Derived Element Tables
-- ============================================================

CREATE TABLE drug_era (
  drug_era_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  drug_concept_id integer NOT NULL,
  drug_era_start_date date NOT NULL,
  drug_era_end_date date NOT NULL,
  drug_exposure_count integer NULL,
  gap_days integer NULL
);

CREATE TABLE dose_era (
  dose_era_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  drug_concept_id integer NOT NULL,
  unit_concept_id integer NOT NULL,
  dose_value NUMERIC NOT NULL,
  dose_era_start_date date NOT NULL,
  dose_era_end_date date NOT NULL
);

CREATE TABLE condition_era (
  condition_era_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  condition_concept_id integer NOT NULL,
  condition_era_start_date date NOT NULL,
  condition_era_end_date date NOT NULL,
  condition_occurrence_count integer NULL
);

CREATE TABLE episode (
  episode_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  episode_concept_id integer NOT NULL,
  episode_start_date date NOT NULL,
  episode_start_datetime TIMESTAMP NULL,
  episode_end_date date NULL,
  episode_end_datetime TIMESTAMP NULL,
  episode_parent_id integer NULL,
  episode_number integer NULL,
  episode_object_concept_id integer NOT NULL,
  episode_type_concept_id integer NOT NULL,
  episode_source_value varchar(50) NULL,
  episode_source_concept_id integer NULL
);

CREATE TABLE episode_event (
  episode_id integer NOT NULL,
  event_id integer NOT NULL,
  episode_event_field_concept_id integer NOT NULL
);

-- ============================================================
-- Metadata Tables
-- ============================================================

CREATE TABLE metadata (
  metadata_id integer NOT NULL PRIMARY KEY,
  metadata_concept_id integer NOT NULL,
  metadata_type_concept_id integer NOT NULL,
  name varchar(250) NOT NULL,
  value_as_string varchar(250) NULL,
  value_as_concept_id integer NULL,
  value_as_number NUMERIC NULL,
  metadata_date date NULL,
  metadata_datetime TIMESTAMP NULL
);

CREATE TABLE cdm_source (
  cdm_source_name varchar(255) NOT NULL,
  cdm_source_abbreviation varchar(25) NOT NULL,
  cdm_holder varchar(255) NOT NULL,
  source_description TEXT NULL,
  source_documentation_reference varchar(255) NULL,
  cdm_etl_reference varchar(255) NULL,
  source_release_date date NOT NULL,
  cdm_release_date date NOT NULL,
  cdm_version varchar(10) NULL,
  cdm_version_concept_id integer NOT NULL,
  vocabulary_version varchar(20) NOT NULL
);

-- ============================================================
-- Vocabulary Tables
-- ============================================================

CREATE TABLE concept (
  concept_id integer NOT NULL PRIMARY KEY,
  concept_name varchar(255) NOT NULL,
  domain_id varchar(20) NOT NULL,
  vocabulary_id varchar(20) NOT NULL,
  concept_class_id varchar(20) NOT NULL,
  standard_concept varchar(1) NULL,
  concept_code varchar(50) NOT NULL,
  valid_start_date date NOT NULL,
  valid_end_date date NOT NULL,
  invalid_reason varchar(1) NULL
);

CREATE TABLE vocabulary (
  vocabulary_id varchar(20) NOT NULL PRIMARY KEY,
  vocabulary_name varchar(255) NOT NULL,
  vocabulary_reference varchar(255) NULL,
  vocabulary_version varchar(255) NULL,
  vocabulary_concept_id integer NOT NULL
);

CREATE TABLE domain (
  domain_id varchar(20) NOT NULL PRIMARY KEY,
  domain_name varchar(255) NOT NULL,
  domain_concept_id integer NOT NULL
);

CREATE TABLE concept_class (
  concept_class_id varchar(20) NOT NULL PRIMARY KEY,
  concept_class_name varchar(255) NOT NULL,
  concept_class_concept_id integer NOT NULL
);

CREATE TABLE concept_relationship (
  concept_id_1 integer NOT NULL,
  concept_id_2 integer NOT NULL,
  relationship_id varchar(20) NOT NULL,
  valid_start_date date NOT NULL,
  valid_end_date date NOT NULL,
  invalid_reason varchar(1) NULL
);

CREATE TABLE relationship (
  relationship_id varchar(20) NOT NULL PRIMARY KEY,
  relationship_name varchar(255) NOT NULL,
  is_hierarchical varchar(1) NOT NULL,
  defines_ancestry varchar(1) NOT NULL,
  reverse_relationship_id varchar(20) NOT NULL,
  relationship_concept_id integer NOT NULL
);

CREATE TABLE concept_synonym (
  concept_id integer NOT NULL,
  concept_synonym_name varchar(1000) NOT NULL,
  language_concept_id integer NOT NULL
);

CREATE TABLE concept_ancestor (
  ancestor_concept_id integer NOT NULL,
  descendant_concept_id integer NOT NULL,
  min_levels_of_separation integer NOT NULL,
  max_levels_of_separation integer NOT NULL
);

CREATE TABLE source_to_concept_map (
  source_code varchar(50) NOT NULL,
  source_concept_id integer NOT NULL,
  source_vocabulary_id varchar(20) NOT NULL,
  source_code_description varchar(255) NULL,
  target_concept_id integer NOT NULL,
  target_vocabulary_id varchar(20) NOT NULL,
  valid_start_date date NOT NULL,
  valid_end_date date NOT NULL,
  invalid_reason varchar(1) NULL
);

CREATE TABLE drug_strength (
  drug_concept_id integer NOT NULL,
  ingredient_concept_id integer NOT NULL,
  amount_value NUMERIC NULL,
  amount_unit_concept_id integer NULL,
  numerator_value NUMERIC NULL,
  numerator_unit_concept_id integer NULL,
  denominator_value NUMERIC NULL,
  denominator_unit_concept_id integer NULL,
  box_size integer NULL,
  valid_start_date date NOT NULL,
  valid_end_date date NOT NULL,
  invalid_reason varchar(1) NULL
);

-- ============================================================
-- Cohort Tables
-- ============================================================

CREATE TABLE cohort (
  cohort_definition_id integer NOT NULL,
  subject_id integer NOT NULL,
  cohort_start_date date NOT NULL,
  cohort_end_date date NOT NULL
);

CREATE TABLE cohort_definition (
  cohort_definition_id integer NOT NULL PRIMARY KEY,
  cohort_definition_name varchar(255) NOT NULL,
  cohort_definition_description TEXT NULL,
  definition_type_concept_id integer NOT NULL,
  cohort_definition_syntax TEXT NULL,
  subject_concept_id integer NOT NULL,
  cohort_initiation_date date NULL
);

-- ============================================================
-- Foreign Key Constraints
-- ============================================================

-- person
ALTER TABLE person ADD CONSTRAINT fpk_person_gender_concept_id FOREIGN KEY (gender_concept_id) REFERENCES concept (concept_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_race_concept_id FOREIGN KEY (race_concept_id) REFERENCES concept (concept_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_ethnicity_concept_id FOREIGN KEY (ethnicity_concept_id) REFERENCES concept (concept_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_location_id FOREIGN KEY (location_id) REFERENCES location (location_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_care_site_id FOREIGN KEY (care_site_id) REFERENCES care_site (care_site_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_gender_source_concept_id FOREIGN KEY (gender_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_race_source_concept_id FOREIGN KEY (race_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE person ADD CONSTRAINT fpk_person_ethnicity_source_concept_id FOREIGN KEY (ethnicity_source_concept_id) REFERENCES concept (concept_id);

-- observation_period
ALTER TABLE observation_period ADD CONSTRAINT fpk_observation_period_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE observation_period ADD CONSTRAINT fpk_observation_period_period_type_concept_id FOREIGN KEY (period_type_concept_id) REFERENCES concept (concept_id);

-- visit_occurrence
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_visit_concept_id FOREIGN KEY (visit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_visit_type_concept_id FOREIGN KEY (visit_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_care_site_id FOREIGN KEY (care_site_id) REFERENCES care_site (care_site_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_visit_source_concept_id FOREIGN KEY (visit_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_admitted_from_concept_id FOREIGN KEY (admitted_from_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_discharged_to_concept_id FOREIGN KEY (discharged_to_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_occurrence ADD CONSTRAINT fpk_visit_occurrence_preceding_visit_occurrence_id FOREIGN KEY (preceding_visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);

-- visit_detail
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_visit_detail_concept_id FOREIGN KEY (visit_detail_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_visit_detail_type_concept_id FOREIGN KEY (visit_detail_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_care_site_id FOREIGN KEY (care_site_id) REFERENCES care_site (care_site_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_visit_detail_source_concept_id FOREIGN KEY (visit_detail_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_admitted_from_concept_id FOREIGN KEY (admitted_from_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_discharged_to_concept_id FOREIGN KEY (discharged_to_concept_id) REFERENCES concept (concept_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_preceding_visit_detail_id FOREIGN KEY (preceding_visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_parent_visit_detail_id FOREIGN KEY (parent_visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE visit_detail ADD CONSTRAINT fpk_visit_detail_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);

-- condition_occurrence
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_condition_concept_id FOREIGN KEY (condition_concept_id) REFERENCES concept (concept_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_condition_type_concept_id FOREIGN KEY (condition_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_condition_status_concept_id FOREIGN KEY (condition_status_concept_id) REFERENCES concept (concept_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE condition_occurrence ADD CONSTRAINT fpk_condition_occurrence_condition_source_concept_id FOREIGN KEY (condition_source_concept_id) REFERENCES concept (concept_id);

-- drug_exposure
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_drug_concept_id FOREIGN KEY (drug_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_drug_type_concept_id FOREIGN KEY (drug_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_route_concept_id FOREIGN KEY (route_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE drug_exposure ADD CONSTRAINT fpk_drug_exposure_drug_source_concept_id FOREIGN KEY (drug_source_concept_id) REFERENCES concept (concept_id);

-- procedure_occurrence
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_procedure_concept_id FOREIGN KEY (procedure_concept_id) REFERENCES concept (concept_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_procedure_type_concept_id FOREIGN KEY (procedure_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_modifier_concept_id FOREIGN KEY (modifier_concept_id) REFERENCES concept (concept_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE procedure_occurrence ADD CONSTRAINT fpk_procedure_occurrence_procedure_source_concept_id FOREIGN KEY (procedure_source_concept_id) REFERENCES concept (concept_id);

-- device_exposure
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_device_concept_id FOREIGN KEY (device_concept_id) REFERENCES concept (concept_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_device_type_concept_id FOREIGN KEY (device_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_device_source_concept_id FOREIGN KEY (device_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_unit_concept_id FOREIGN KEY (unit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE device_exposure ADD CONSTRAINT fpk_device_exposure_unit_source_concept_id FOREIGN KEY (unit_source_concept_id) REFERENCES concept (concept_id);

-- measurement
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_measurement_concept_id FOREIGN KEY (measurement_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_measurement_type_concept_id FOREIGN KEY (measurement_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_operator_concept_id FOREIGN KEY (operator_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_value_as_concept_id FOREIGN KEY (value_as_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_unit_concept_id FOREIGN KEY (unit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_measurement_source_concept_id FOREIGN KEY (measurement_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_unit_source_concept_id FOREIGN KEY (unit_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE measurement ADD CONSTRAINT fpk_measurement_meas_event_field_concept_id FOREIGN KEY (meas_event_field_concept_id) REFERENCES concept (concept_id);

-- observation
ALTER TABLE observation ADD CONSTRAINT fpk_observation_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_observation_concept_id FOREIGN KEY (observation_concept_id) REFERENCES concept (concept_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_observation_type_concept_id FOREIGN KEY (observation_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_value_as_concept_id FOREIGN KEY (value_as_concept_id) REFERENCES concept (concept_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_qualifier_concept_id FOREIGN KEY (qualifier_concept_id) REFERENCES concept (concept_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_unit_concept_id FOREIGN KEY (unit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_observation_source_concept_id FOREIGN KEY (observation_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE observation ADD CONSTRAINT fpk_observation_obs_event_field_concept_id FOREIGN KEY (obs_event_field_concept_id) REFERENCES concept (concept_id);

-- death
ALTER TABLE death ADD CONSTRAINT fpk_death_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE death ADD CONSTRAINT fpk_death_death_type_concept_id FOREIGN KEY (death_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE death ADD CONSTRAINT fpk_death_cause_concept_id FOREIGN KEY (cause_concept_id) REFERENCES concept (concept_id);
ALTER TABLE death ADD CONSTRAINT fpk_death_cause_source_concept_id FOREIGN KEY (cause_source_concept_id) REFERENCES concept (concept_id);

-- note
ALTER TABLE note ADD CONSTRAINT fpk_note_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_note_type_concept_id FOREIGN KEY (note_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_note_class_concept_id FOREIGN KEY (note_class_concept_id) REFERENCES concept (concept_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_encoding_concept_id FOREIGN KEY (encoding_concept_id) REFERENCES concept (concept_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_language_concept_id FOREIGN KEY (language_concept_id) REFERENCES concept (concept_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_provider_id FOREIGN KEY (provider_id) REFERENCES provider (provider_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_visit_occurrence_id FOREIGN KEY (visit_occurrence_id) REFERENCES visit_occurrence (visit_occurrence_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_visit_detail_id FOREIGN KEY (visit_detail_id) REFERENCES visit_detail (visit_detail_id);
ALTER TABLE note ADD CONSTRAINT fpk_note_note_event_field_concept_id FOREIGN KEY (note_event_field_concept_id) REFERENCES concept (concept_id);

-- note_nlp
ALTER TABLE note_nlp ADD CONSTRAINT fpk_note_nlp_section_concept_id FOREIGN KEY (section_concept_id) REFERENCES concept (concept_id);
ALTER TABLE note_nlp ADD CONSTRAINT fpk_note_nlp_note_nlp_concept_id FOREIGN KEY (note_nlp_concept_id) REFERENCES concept (concept_id);
ALTER TABLE note_nlp ADD CONSTRAINT fpk_note_nlp_note_nlp_source_concept_id FOREIGN KEY (note_nlp_source_concept_id) REFERENCES concept (concept_id);

-- specimen
ALTER TABLE specimen ADD CONSTRAINT fpk_specimen_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE specimen ADD CONSTRAINT fpk_specimen_specimen_concept_id FOREIGN KEY (specimen_concept_id) REFERENCES concept (concept_id);
ALTER TABLE specimen ADD CONSTRAINT fpk_specimen_specimen_type_concept_id FOREIGN KEY (specimen_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE specimen ADD CONSTRAINT fpk_specimen_unit_concept_id FOREIGN KEY (unit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE specimen ADD CONSTRAINT fpk_specimen_anatomic_site_concept_id FOREIGN KEY (anatomic_site_concept_id) REFERENCES concept (concept_id);
ALTER TABLE specimen ADD CONSTRAINT fpk_specimen_disease_status_concept_id FOREIGN KEY (disease_status_concept_id) REFERENCES concept (concept_id);

-- fact_relationship
ALTER TABLE fact_relationship ADD CONSTRAINT fpk_fact_relationship_domain_concept_id_1 FOREIGN KEY (domain_concept_id_1) REFERENCES concept (concept_id);
ALTER TABLE fact_relationship ADD CONSTRAINT fpk_fact_relationship_domain_concept_id_2 FOREIGN KEY (domain_concept_id_2) REFERENCES concept (concept_id);
ALTER TABLE fact_relationship ADD CONSTRAINT fpk_fact_relationship_relationship_concept_id FOREIGN KEY (relationship_concept_id) REFERENCES concept (concept_id);

-- location
ALTER TABLE location ADD CONSTRAINT fpk_location_country_concept_id FOREIGN KEY (country_concept_id) REFERENCES concept (concept_id);

-- care_site
ALTER TABLE care_site ADD CONSTRAINT fpk_care_site_place_of_service_concept_id FOREIGN KEY (place_of_service_concept_id) REFERENCES concept (concept_id);
ALTER TABLE care_site ADD CONSTRAINT fpk_care_site_location_id FOREIGN KEY (location_id) REFERENCES location (location_id);

-- provider
ALTER TABLE provider ADD CONSTRAINT fpk_provider_specialty_concept_id FOREIGN KEY (specialty_concept_id) REFERENCES concept (concept_id);
ALTER TABLE provider ADD CONSTRAINT fpk_provider_care_site_id FOREIGN KEY (care_site_id) REFERENCES care_site (care_site_id);
ALTER TABLE provider ADD CONSTRAINT fpk_provider_gender_concept_id FOREIGN KEY (gender_concept_id) REFERENCES concept (concept_id);
ALTER TABLE provider ADD CONSTRAINT fpk_provider_specialty_source_concept_id FOREIGN KEY (specialty_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE provider ADD CONSTRAINT fpk_provider_gender_source_concept_id FOREIGN KEY (gender_source_concept_id) REFERENCES concept (concept_id);

-- payer_plan_period
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_payer_concept_id FOREIGN KEY (payer_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_payer_source_concept_id FOREIGN KEY (payer_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_plan_concept_id FOREIGN KEY (plan_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_plan_source_concept_id FOREIGN KEY (plan_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_sponsor_concept_id FOREIGN KEY (sponsor_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_sponsor_source_concept_id FOREIGN KEY (sponsor_source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_stop_reason_concept_id FOREIGN KEY (stop_reason_concept_id) REFERENCES concept (concept_id);
ALTER TABLE payer_plan_period ADD CONSTRAINT fpk_payer_plan_period_stop_reason_source_concept_id FOREIGN KEY (stop_reason_source_concept_id) REFERENCES concept (concept_id);

-- cost
ALTER TABLE cost ADD CONSTRAINT fpk_cost_cost_domain_id FOREIGN KEY (cost_domain_id) REFERENCES domain (domain_id);
ALTER TABLE cost ADD CONSTRAINT fpk_cost_cost_type_concept_id FOREIGN KEY (cost_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE cost ADD CONSTRAINT fpk_cost_currency_concept_id FOREIGN KEY (currency_concept_id) REFERENCES concept (concept_id);
ALTER TABLE cost ADD CONSTRAINT fpk_cost_revenue_code_concept_id FOREIGN KEY (revenue_code_concept_id) REFERENCES concept (concept_id);
ALTER TABLE cost ADD CONSTRAINT fpk_cost_drg_concept_id FOREIGN KEY (drg_concept_id) REFERENCES concept (concept_id);

-- drug_era
ALTER TABLE drug_era ADD CONSTRAINT fpk_drug_era_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE drug_era ADD CONSTRAINT fpk_drug_era_drug_concept_id FOREIGN KEY (drug_concept_id) REFERENCES concept (concept_id);

-- dose_era
ALTER TABLE dose_era ADD CONSTRAINT fpk_dose_era_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE dose_era ADD CONSTRAINT fpk_dose_era_drug_concept_id FOREIGN KEY (drug_concept_id) REFERENCES concept (concept_id);
ALTER TABLE dose_era ADD CONSTRAINT fpk_dose_era_unit_concept_id FOREIGN KEY (unit_concept_id) REFERENCES concept (concept_id);

-- condition_era
ALTER TABLE condition_era ADD CONSTRAINT fpk_condition_era_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE condition_era ADD CONSTRAINT fpk_condition_era_condition_concept_id FOREIGN KEY (condition_concept_id) REFERENCES concept (concept_id);

-- episode
ALTER TABLE episode ADD CONSTRAINT fpk_episode_person_id FOREIGN KEY (person_id) REFERENCES person (person_id);
ALTER TABLE episode ADD CONSTRAINT fpk_episode_episode_concept_id FOREIGN KEY (episode_concept_id) REFERENCES concept (concept_id);
ALTER TABLE episode ADD CONSTRAINT fpk_episode_episode_object_concept_id FOREIGN KEY (episode_object_concept_id) REFERENCES concept (concept_id);
ALTER TABLE episode ADD CONSTRAINT fpk_episode_episode_type_concept_id FOREIGN KEY (episode_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE episode ADD CONSTRAINT fpk_episode_episode_source_concept_id FOREIGN KEY (episode_source_concept_id) REFERENCES concept (concept_id);

-- episode_event
ALTER TABLE episode_event ADD CONSTRAINT fpk_episode_event_episode_id FOREIGN KEY (episode_id) REFERENCES episode (episode_id);
ALTER TABLE episode_event ADD CONSTRAINT fpk_episode_event_episode_event_field_concept_id FOREIGN KEY (episode_event_field_concept_id) REFERENCES concept (concept_id);

-- metadata
ALTER TABLE metadata ADD CONSTRAINT fpk_metadata_metadata_concept_id FOREIGN KEY (metadata_concept_id) REFERENCES concept (concept_id);
ALTER TABLE metadata ADD CONSTRAINT fpk_metadata_metadata_type_concept_id FOREIGN KEY (metadata_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE metadata ADD CONSTRAINT fpk_metadata_value_as_concept_id FOREIGN KEY (value_as_concept_id) REFERENCES concept (concept_id);

-- cdm_source
ALTER TABLE cdm_source ADD CONSTRAINT fpk_cdm_source_cdm_version_concept_id FOREIGN KEY (cdm_version_concept_id) REFERENCES concept (concept_id);

-- concept
ALTER TABLE concept ADD CONSTRAINT fpk_concept_domain_id FOREIGN KEY (domain_id) REFERENCES domain (domain_id);
ALTER TABLE concept ADD CONSTRAINT fpk_concept_vocabulary_id FOREIGN KEY (vocabulary_id) REFERENCES vocabulary (vocabulary_id);
ALTER TABLE concept ADD CONSTRAINT fpk_concept_concept_class_id FOREIGN KEY (concept_class_id) REFERENCES concept_class (concept_class_id);

-- vocabulary
ALTER TABLE vocabulary ADD CONSTRAINT fpk_vocabulary_vocabulary_concept_id FOREIGN KEY (vocabulary_concept_id) REFERENCES concept (concept_id);

-- domain
ALTER TABLE domain ADD CONSTRAINT fpk_domain_domain_concept_id FOREIGN KEY (domain_concept_id) REFERENCES concept (concept_id);

-- concept_class
ALTER TABLE concept_class ADD CONSTRAINT fpk_concept_class_concept_class_concept_id FOREIGN KEY (concept_class_concept_id) REFERENCES concept (concept_id);

-- concept_relationship
ALTER TABLE concept_relationship ADD CONSTRAINT fpk_concept_relationship_concept_id_1 FOREIGN KEY (concept_id_1) REFERENCES concept (concept_id);
ALTER TABLE concept_relationship ADD CONSTRAINT fpk_concept_relationship_concept_id_2 FOREIGN KEY (concept_id_2) REFERENCES concept (concept_id);
ALTER TABLE concept_relationship ADD CONSTRAINT fpk_concept_relationship_relationship_id FOREIGN KEY (relationship_id) REFERENCES relationship (relationship_id);

-- relationship
ALTER TABLE relationship ADD CONSTRAINT fpk_relationship_relationship_concept_id FOREIGN KEY (relationship_concept_id) REFERENCES concept (concept_id);

-- concept_synonym
ALTER TABLE concept_synonym ADD CONSTRAINT fpk_concept_synonym_concept_id FOREIGN KEY (concept_id) REFERENCES concept (concept_id);
ALTER TABLE concept_synonym ADD CONSTRAINT fpk_concept_synonym_language_concept_id FOREIGN KEY (language_concept_id) REFERENCES concept (concept_id);

-- concept_ancestor
ALTER TABLE concept_ancestor ADD CONSTRAINT fpk_concept_ancestor_ancestor_concept_id FOREIGN KEY (ancestor_concept_id) REFERENCES concept (concept_id);
ALTER TABLE concept_ancestor ADD CONSTRAINT fpk_concept_ancestor_descendant_concept_id FOREIGN KEY (descendant_concept_id) REFERENCES concept (concept_id);

-- source_to_concept_map
ALTER TABLE source_to_concept_map ADD CONSTRAINT fpk_source_to_concept_map_source_concept_id FOREIGN KEY (source_concept_id) REFERENCES concept (concept_id);
ALTER TABLE source_to_concept_map ADD CONSTRAINT fpk_source_to_concept_map_target_concept_id FOREIGN KEY (target_concept_id) REFERENCES concept (concept_id);
ALTER TABLE source_to_concept_map ADD CONSTRAINT fpk_source_to_concept_map_target_vocabulary_id FOREIGN KEY (target_vocabulary_id) REFERENCES vocabulary (vocabulary_id);

-- drug_strength
ALTER TABLE drug_strength ADD CONSTRAINT fpk_drug_strength_drug_concept_id FOREIGN KEY (drug_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_strength ADD CONSTRAINT fpk_drug_strength_ingredient_concept_id FOREIGN KEY (ingredient_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_strength ADD CONSTRAINT fpk_drug_strength_amount_unit_concept_id FOREIGN KEY (amount_unit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_strength ADD CONSTRAINT fpk_drug_strength_numerator_unit_concept_id FOREIGN KEY (numerator_unit_concept_id) REFERENCES concept (concept_id);
ALTER TABLE drug_strength ADD CONSTRAINT fpk_drug_strength_denominator_unit_concept_id FOREIGN KEY (denominator_unit_concept_id) REFERENCES concept (concept_id);

-- cohort_definition
ALTER TABLE cohort_definition ADD CONSTRAINT fpk_cohort_definition_definition_type_concept_id FOREIGN KEY (definition_type_concept_id) REFERENCES concept (concept_id);
ALTER TABLE cohort_definition ADD CONSTRAINT fpk_cohort_definition_subject_concept_id FOREIGN KEY (subject_concept_id) REFERENCES concept (concept_id);

-- ============================================================
-- Indices
-- ============================================================

-- Clinical data
CREATE INDEX idx_person_id ON person (person_id ASC);
CREATE INDEX idx_gender ON person (gender_concept_id ASC);
CREATE INDEX idx_observation_period_id_1 ON observation_period (person_id ASC);
CREATE INDEX idx_visit_person_id_1 ON visit_occurrence (person_id ASC);
CREATE INDEX idx_visit_concept_id_1 ON visit_occurrence (visit_concept_id ASC);
CREATE INDEX idx_visit_det_person_id_1 ON visit_detail (person_id ASC);
CREATE INDEX idx_visit_det_concept_id_1 ON visit_detail (visit_detail_concept_id ASC);
CREATE INDEX idx_visit_det_occ_id ON visit_detail (visit_occurrence_id ASC);
CREATE INDEX idx_condition_person_id_1 ON condition_occurrence (person_id ASC);
CREATE INDEX idx_condition_concept_id_1 ON condition_occurrence (condition_concept_id ASC);
CREATE INDEX idx_condition_visit_id_1 ON condition_occurrence (visit_occurrence_id ASC);
CREATE INDEX idx_drug_person_id_1 ON drug_exposure (person_id ASC);
CREATE INDEX idx_drug_concept_id_1 ON drug_exposure (drug_concept_id ASC);
CREATE INDEX idx_drug_visit_id_1 ON drug_exposure (visit_occurrence_id ASC);
CREATE INDEX idx_procedure_person_id_1 ON procedure_occurrence (person_id ASC);
CREATE INDEX idx_procedure_concept_id_1 ON procedure_occurrence (procedure_concept_id ASC);
CREATE INDEX idx_procedure_visit_id_1 ON procedure_occurrence (visit_occurrence_id ASC);
CREATE INDEX idx_device_person_id_1 ON device_exposure (person_id ASC);
CREATE INDEX idx_device_concept_id_1 ON device_exposure (device_concept_id ASC);
CREATE INDEX idx_device_visit_id_1 ON device_exposure (visit_occurrence_id ASC);
CREATE INDEX idx_measurement_person_id_1 ON measurement (person_id ASC);
CREATE INDEX idx_measurement_concept_id_1 ON measurement (measurement_concept_id ASC);
CREATE INDEX idx_measurement_visit_id_1 ON measurement (visit_occurrence_id ASC);
CREATE INDEX idx_observation_person_id_1 ON observation (person_id ASC);
CREATE INDEX idx_observation_concept_id_1 ON observation (observation_concept_id ASC);
CREATE INDEX idx_observation_visit_id_1 ON observation (visit_occurrence_id ASC);
CREATE INDEX idx_death_person_id_1 ON death (person_id ASC);
CREATE INDEX idx_note_person_id_1 ON note (person_id ASC);
CREATE INDEX idx_note_concept_id_1 ON note (note_type_concept_id ASC);
CREATE INDEX idx_note_visit_id_1 ON note (visit_occurrence_id ASC);
CREATE INDEX idx_note_nlp_note_id_1 ON note_nlp (note_id ASC);
CREATE INDEX idx_note_nlp_concept_id_1 ON note_nlp (note_nlp_concept_id ASC);
CREATE INDEX idx_specimen_person_id_1 ON specimen (person_id ASC);
CREATE INDEX idx_specimen_concept_id_1 ON specimen (specimen_concept_id ASC);
CREATE INDEX idx_fact_relationship_id1 ON fact_relationship (domain_concept_id_1 ASC);
CREATE INDEX idx_fact_relationship_id2 ON fact_relationship (domain_concept_id_2 ASC);
CREATE INDEX idx_fact_relationship_id3 ON fact_relationship (relationship_concept_id ASC);

-- Health system
CREATE INDEX idx_location_id_1 ON location (location_id ASC);
CREATE INDEX idx_care_site_id_1 ON care_site (care_site_id ASC);
CREATE INDEX idx_provider_id_1 ON provider (provider_id ASC);

-- Health economics
CREATE INDEX idx_period_person_id_1 ON payer_plan_period (person_id ASC);
CREATE INDEX idx_cost_event_id ON cost (cost_event_id ASC);

-- Derived elements
CREATE INDEX idx_drug_era_person_id_1 ON drug_era (person_id ASC);
CREATE INDEX idx_drug_era_concept_id_1 ON drug_era (drug_concept_id ASC);
CREATE INDEX idx_dose_era_person_id_1 ON dose_era (person_id ASC);
CREATE INDEX idx_dose_era_concept_id_1 ON dose_era (drug_concept_id ASC);
CREATE INDEX idx_condition_era_person_id_1 ON condition_era (person_id ASC);
CREATE INDEX idx_condition_era_concept_id_1 ON condition_era (condition_concept_id ASC);
CREATE INDEX idx_metadata_concept_id_1 ON metadata (metadata_concept_id ASC);

-- Vocabularies
CREATE INDEX idx_concept_concept_id ON concept (concept_id ASC);
CREATE INDEX idx_concept_code ON concept (concept_code ASC);
CREATE INDEX idx_concept_vocabluary_id ON concept (vocabulary_id ASC);
CREATE INDEX idx_concept_domain_id ON concept (domain_id ASC);
CREATE INDEX idx_concept_class_id ON concept (concept_class_id ASC);
CREATE INDEX idx_vocabulary_vocabulary_id ON vocabulary (vocabulary_id ASC);
CREATE INDEX idx_domain_domain_id ON domain (domain_id ASC);
CREATE INDEX idx_concept_class_class_id ON concept_class (concept_class_id ASC);
CREATE INDEX idx_concept_relationship_id_1 ON concept_relationship (concept_id_1 ASC);
CREATE INDEX idx_concept_relationship_id_2 ON concept_relationship (concept_id_2 ASC);
CREATE INDEX idx_concept_relationship_id_3 ON concept_relationship (relationship_id ASC);
CREATE INDEX idx_relationship_rel_id ON relationship (relationship_id ASC);
CREATE INDEX idx_concept_synonym_id ON concept_synonym (concept_id ASC);
CREATE INDEX idx_concept_ancestor_id_1 ON concept_ancestor (ancestor_concept_id ASC);
CREATE INDEX idx_concept_ancestor_id_2 ON concept_ancestor (descendant_concept_id ASC);
CREATE INDEX idx_source_to_concept_map_3 ON source_to_concept_map (target_concept_id ASC);
CREATE INDEX idx_source_to_concept_map_1 ON source_to_concept_map (source_vocabulary_id ASC);
CREATE INDEX idx_source_to_concept_map_2 ON source_to_concept_map (target_vocabulary_id ASC);
CREATE INDEX idx_source_to_concept_map_c ON source_to_concept_map (source_code ASC);
CREATE INDEX idx_drug_strength_id_1 ON drug_strength (drug_concept_id ASC);
CREATE INDEX idx_drug_strength_id_2 ON drug_strength (ingredient_concept_id ASC);
`
