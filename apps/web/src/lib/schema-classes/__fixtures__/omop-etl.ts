import type { SchemaMapping } from '@/types/schema-mapping'
import { mappingV1ToV2 } from '../v1'
import { eavMapping } from './drug-acceptance'

/** The EAV warehouse of the drug acceptance test, with patients and stays. */
export const eavSource: SchemaMapping = {
  ...eavMapping,
  patient: {
    from: { schema: 'eav', table: 'patients', alias: 'p' },
    fields: { patient_id: 'p.patient_id', birth_date: 'p.birth_date', gender_source_value: 'p.sex', death_datetime: 'p.died_at' },
    genderValues: { male: 'M', female: 'F' },
  },
  visit: {
    from: { schema: 'eav', table: 'stays', alias: 's' },
    fields: { visit_id: 's.stay_id', patient_id: 's.patient_id', start_datetime: 's.admitted_at', end_datetime: 's.discharged_at', care_site_id: 's.ward_id', care_site_name: 's.ward_name' },
  },
}

/** OMOP 5.4 as the public preset describes it (v1, converted like any import). */
export const omopTarget: SchemaMapping = mappingV1ToV2({
  presetId: 'omop-cdm-5.4',
  presetLabel: { en: 'OMOP CDM 5.4' },
  patientTable: { table: 'person', idColumn: 'person_id', birthDateColumn: 'birth_datetime', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
  deathTable: { table: 'death', patientIdColumn: 'person_id', dateColumn: 'death_datetime' },
  visitTable: {
    table: 'visit_occurrence', idColumn: 'visit_occurrence_id', patientIdColumn: 'person_id',
    startDateColumn: 'visit_start_datetime', endDateColumn: 'visit_end_datetime', typeColumn: 'visit_source_value',
    careSiteColumn: 'care_site_id', careSiteNameTable: 'care_site', careSiteNameIdColumn: 'care_site_id', careSiteNameColumn: 'care_site_name',
  },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', codeColumn: 'concept_code', terminologyIdColumn: 'vocabulary_id' }],
  eventTables: {
    Drug: {
      table: 'drug_exposure', conceptIdColumn: 'drug_concept_id', sourceConceptIdColumn: 'drug_source_concept_id', patientIdColumn: 'person_id',
      dateColumn: 'drug_exposure_start_datetime', endDateColumn: 'drug_exposure_end_datetime', valueColumn: 'quantity',
      routeColumn: 'route_source_value', routeConceptIdColumn: 'route_concept_id',
    },
    Measurement: {
      table: 'measurement', conceptIdColumn: 'measurement_concept_id', sourceConceptIdColumn: 'measurement_source_concept_id', patientIdColumn: 'person_id',
      dateColumn: 'measurement_datetime', valueColumn: 'value_as_number',
    },
  },
  genderValues: { male: '8507', female: '8532', unknown: '0' },
})

/** The OMOP 5.4 DDL of the tables involved, as the preset ships it. */
export const omopDdl = `
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

CREATE TABLE death (
  person_id integer NOT NULL,
  death_date date NOT NULL,
  death_datetime TIMESTAMP NULL,
  death_type_concept_id integer NULL,
  cause_concept_id integer NULL,
  cause_source_value varchar(50) NULL,
  cause_source_concept_id integer NULL
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

CREATE TABLE care_site (
  care_site_id integer NOT NULL PRIMARY KEY,
  care_site_name varchar(255) NULL,
  place_of_service_concept_id integer NULL,
  location_id integer NULL,
  care_site_source_value varchar(50) NULL,
  place_of_service_source_value varchar(50) NULL
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

CREATE TABLE measurement (
  measurement_id integer NOT NULL PRIMARY KEY,
  person_id integer NOT NULL,
  measurement_concept_id integer NOT NULL,
  measurement_date date NOT NULL,
  measurement_datetime TIMESTAMP NULL,
  measurement_type_concept_id integer NOT NULL,
  value_as_number NUMERIC NULL,
  measurement_source_value varchar(50) NULL,
  measurement_source_concept_id integer NULL
);
`
