/**
 * MIMIC-III v1.4 DDL for DuckDB.
 * Source: https://github.com/MIT-LCP/mimic-code/blob/main/mimic-iii/buildmimic/postgres/postgres_create_tables.sql
 *
 * - DROP TABLE statements removed
 * - Partition tables and triggers removed (chartevents_1..17, trigger function)
 * - CONSTRAINT clauses removed (DuckDB supports them but they are not needed for read-only data)
 * - TIMESTAMP(0) simplified to TIMESTAMP
 * - DOUBLE PRECISION changed to DOUBLE
 * - CHAR(n) changed to VARCHAR
 * - Table names lowercased to match convention
 */
export const MIMIC_III_DDL = `-- MIMIC-III v1.4 DDL (DuckDB)
-- https://physionet.org/content/mimiciii-demo/1.4/

-- ============================================================
-- Clinical Data Tables
-- ============================================================

CREATE TABLE admissions (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  admittime TIMESTAMP NOT NULL,
  dischtime TIMESTAMP NOT NULL,
  deathtime TIMESTAMP,
  admission_type VARCHAR(50) NOT NULL,
  admission_location VARCHAR(50) NOT NULL,
  discharge_location VARCHAR(50) NOT NULL,
  insurance VARCHAR(255) NOT NULL,
  language VARCHAR(10),
  religion VARCHAR(50),
  marital_status VARCHAR(50),
  ethnicity VARCHAR(200) NOT NULL,
  edregtime TIMESTAMP,
  edouttime TIMESTAMP,
  diagnosis VARCHAR(255),
  hospital_expire_flag SMALLINT,
  has_chartevents_data SMALLINT NOT NULL
);

CREATE TABLE callout (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  submit_wardid INTEGER,
  submit_careunit VARCHAR(15),
  curr_wardid INTEGER,
  curr_careunit VARCHAR(15),
  callout_wardid INTEGER,
  callout_service VARCHAR(10) NOT NULL,
  request_tele SMALLINT NOT NULL,
  request_resp SMALLINT NOT NULL,
  request_cdiff SMALLINT NOT NULL,
  request_mrsa SMALLINT NOT NULL,
  request_vre SMALLINT NOT NULL,
  callout_status VARCHAR(20) NOT NULL,
  callout_outcome VARCHAR(20) NOT NULL,
  discharge_wardid INTEGER,
  acknowledge_status VARCHAR(20) NOT NULL,
  createtime TIMESTAMP NOT NULL,
  updatetime TIMESTAMP NOT NULL,
  acknowledgetime TIMESTAMP,
  outcometime TIMESTAMP NOT NULL,
  firstreservationtime TIMESTAMP,
  currentreservationtime TIMESTAMP
);

CREATE TABLE caregivers (
  row_id INTEGER NOT NULL,
  cgid INTEGER NOT NULL,
  label VARCHAR(15),
  description VARCHAR(30)
);

CREATE TABLE chartevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  icustay_id INTEGER,
  itemid INTEGER,
  charttime TIMESTAMP,
  storetime TIMESTAMP,
  cgid INTEGER,
  value VARCHAR(255),
  valuenum DOUBLE,
  valueuom VARCHAR(50),
  warning INTEGER,
  error INTEGER,
  resultstatus VARCHAR(50),
  stopped VARCHAR(50)
);

CREATE TABLE cptevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  costcenter VARCHAR(10) NOT NULL,
  chartdate TIMESTAMP,
  cpt_cd VARCHAR(10) NOT NULL,
  cpt_number INTEGER,
  cpt_suffix VARCHAR(5),
  ticket_id_seq INTEGER,
  sectionheader VARCHAR(50),
  subsectionheader VARCHAR(255),
  description VARCHAR(200)
);

CREATE TABLE datetimeevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  icustay_id INTEGER,
  itemid INTEGER NOT NULL,
  charttime TIMESTAMP NOT NULL,
  storetime TIMESTAMP NOT NULL,
  cgid INTEGER NOT NULL,
  value TIMESTAMP,
  valueuom VARCHAR(50) NOT NULL,
  warning SMALLINT,
  error SMALLINT,
  resultstatus VARCHAR(50),
  stopped VARCHAR(50)
);

CREATE TABLE diagnoses_icd (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  seq_num INTEGER,
  icd9_code VARCHAR(10)
);

CREATE TABLE drgcodes (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  drg_type VARCHAR(20) NOT NULL,
  drg_code VARCHAR(20) NOT NULL,
  description VARCHAR(255),
  drg_severity SMALLINT,
  drg_mortality SMALLINT
);

-- ============================================================
-- Dictionary Tables
-- ============================================================

CREATE TABLE d_cpt (
  row_id INTEGER NOT NULL,
  category SMALLINT NOT NULL,
  sectionrange VARCHAR(100) NOT NULL,
  sectionheader VARCHAR(50) NOT NULL,
  subsectionrange VARCHAR(100) NOT NULL,
  subsectionheader VARCHAR(255) NOT NULL,
  codesuffix VARCHAR(5),
  mincodeinsubsection INTEGER NOT NULL,
  maxcodeinsubsection INTEGER NOT NULL
);

CREATE TABLE d_icd_diagnoses (
  row_id INTEGER NOT NULL,
  icd9_code VARCHAR(10) NOT NULL,
  short_title VARCHAR(50) NOT NULL,
  long_title VARCHAR(255) NOT NULL
);

CREATE TABLE d_icd_procedures (
  row_id INTEGER NOT NULL,
  icd9_code VARCHAR(10) NOT NULL,
  short_title VARCHAR(50) NOT NULL,
  long_title VARCHAR(255) NOT NULL
);

CREATE TABLE d_items (
  row_id INTEGER NOT NULL,
  itemid INTEGER NOT NULL,
  label VARCHAR(200),
  abbreviation VARCHAR(100),
  dbsource VARCHAR(20),
  linksto VARCHAR(50),
  category VARCHAR(100),
  unitname VARCHAR(100),
  param_type VARCHAR(30),
  conceptid INTEGER
);

CREATE TABLE d_labitems (
  row_id INTEGER NOT NULL,
  itemid INTEGER NOT NULL,
  label VARCHAR(100) NOT NULL,
  fluid VARCHAR(100) NOT NULL,
  category VARCHAR(100) NOT NULL,
  loinc_code VARCHAR(100)
);

-- ============================================================
-- ICU Tables
-- ============================================================

CREATE TABLE icustays (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  icustay_id INTEGER NOT NULL,
  dbsource VARCHAR(20) NOT NULL,
  first_careunit VARCHAR(20) NOT NULL,
  last_careunit VARCHAR(20) NOT NULL,
  first_wardid SMALLINT NOT NULL,
  last_wardid SMALLINT NOT NULL,
  intime TIMESTAMP NOT NULL,
  outtime TIMESTAMP,
  los DOUBLE
);

CREATE TABLE inputevents_cv (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  icustay_id INTEGER,
  charttime TIMESTAMP,
  itemid INTEGER,
  amount DOUBLE,
  amountuom VARCHAR(30),
  rate DOUBLE,
  rateuom VARCHAR(30),
  storetime TIMESTAMP,
  cgid INTEGER,
  orderid INTEGER,
  linkorderid INTEGER,
  stopped VARCHAR(30),
  newbottle INTEGER,
  originalamount DOUBLE,
  originalamountuom VARCHAR(30),
  originalroute VARCHAR(30),
  originalrate DOUBLE,
  originalrateuom VARCHAR(30),
  originalsite VARCHAR(30)
);

CREATE TABLE inputevents_mv (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  icustay_id INTEGER,
  starttime TIMESTAMP,
  endtime TIMESTAMP,
  itemid INTEGER,
  amount DOUBLE,
  amountuom VARCHAR(30),
  rate DOUBLE,
  rateuom VARCHAR(30),
  storetime TIMESTAMP,
  cgid INTEGER,
  orderid INTEGER,
  linkorderid INTEGER,
  ordercategoryname VARCHAR(100),
  secondaryordercategoryname VARCHAR(100),
  ordercomponenttypedescription VARCHAR(200),
  ordercategorydescription VARCHAR(50),
  patientweight DOUBLE,
  totalamount DOUBLE,
  totalamountuom VARCHAR(50),
  isopenbag SMALLINT,
  continueinnextdept SMALLINT,
  cancelreason SMALLINT,
  statusdescription VARCHAR(30),
  comments_editedby VARCHAR(30),
  comments_canceledby VARCHAR(40),
  comments_date TIMESTAMP,
  originalamount DOUBLE,
  originalrate DOUBLE
);

CREATE TABLE labevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  itemid INTEGER NOT NULL,
  charttime TIMESTAMP,
  value VARCHAR(200),
  valuenum DOUBLE,
  valueuom VARCHAR(20),
  flag VARCHAR(20)
);

CREATE TABLE microbiologyevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  chartdate TIMESTAMP,
  charttime TIMESTAMP,
  spec_itemid INTEGER,
  spec_type_desc VARCHAR(100),
  org_itemid INTEGER,
  org_name VARCHAR(100),
  isolate_num SMALLINT,
  ab_itemid INTEGER,
  ab_name VARCHAR(30),
  dilution_text VARCHAR(10),
  dilution_comparison VARCHAR(20),
  dilution_value DOUBLE,
  interpretation VARCHAR(5)
);

CREATE TABLE noteevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  chartdate TIMESTAMP,
  charttime TIMESTAMP,
  storetime TIMESTAMP,
  category VARCHAR(50),
  description VARCHAR(255),
  cgid INTEGER,
  iserror VARCHAR(1),
  text TEXT
);

CREATE TABLE outputevents (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  icustay_id INTEGER,
  charttime TIMESTAMP,
  itemid INTEGER,
  value DOUBLE,
  valueuom VARCHAR(30),
  storetime TIMESTAMP,
  cgid INTEGER,
  stopped VARCHAR(30),
  newbottle VARCHAR(1),
  iserror INTEGER
);

CREATE TABLE patients (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  gender VARCHAR(5) NOT NULL,
  dob TIMESTAMP NOT NULL,
  dod TIMESTAMP,
  dod_hosp TIMESTAMP,
  dod_ssn TIMESTAMP,
  expire_flag INTEGER NOT NULL
);

CREATE TABLE prescriptions (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  icustay_id INTEGER,
  startdate TIMESTAMP,
  enddate TIMESTAMP,
  drug_type VARCHAR(100) NOT NULL,
  drug VARCHAR(100) NOT NULL,
  drug_name_poe VARCHAR(100),
  drug_name_generic VARCHAR(100),
  formulary_drug_cd VARCHAR(120),
  gsn VARCHAR(200),
  ndc VARCHAR(120),
  prod_strength VARCHAR(120),
  dose_val_rx VARCHAR(120),
  dose_unit_rx VARCHAR(120),
  form_val_disp VARCHAR(120),
  form_unit_disp VARCHAR(120),
  route VARCHAR(120)
);

CREATE TABLE procedureevents_mv (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  icustay_id INTEGER,
  starttime TIMESTAMP,
  endtime TIMESTAMP,
  itemid INTEGER,
  value DOUBLE,
  valueuom VARCHAR(30),
  location VARCHAR(30),
  locationcategory VARCHAR(30),
  storetime TIMESTAMP,
  cgid INTEGER,
  orderid INTEGER,
  linkorderid INTEGER,
  ordercategoryname VARCHAR(100),
  secondaryordercategoryname VARCHAR(100),
  ordercategorydescription VARCHAR(50),
  isopenbag SMALLINT,
  continueinnextdept SMALLINT,
  cancelreason SMALLINT,
  statusdescription VARCHAR(30),
  comments_editedby VARCHAR(30),
  comments_canceledby VARCHAR(30),
  comments_date TIMESTAMP
);

CREATE TABLE procedures_icd (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  seq_num INTEGER NOT NULL,
  icd9_code VARCHAR(10) NOT NULL
);

CREATE TABLE services (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  transfertime TIMESTAMP NOT NULL,
  prev_service VARCHAR(20),
  curr_service VARCHAR(20)
);

CREATE TABLE transfers (
  row_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  icustay_id INTEGER,
  dbsource VARCHAR(20),
  eventtype VARCHAR(20),
  prev_careunit VARCHAR(20),
  curr_careunit VARCHAR(20),
  prev_wardid SMALLINT,
  curr_wardid SMALLINT,
  intime TIMESTAMP,
  outtime TIMESTAMP,
  los DOUBLE
);
`
