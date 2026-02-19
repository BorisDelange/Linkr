/**
 * MIMIC-III v1.4 complete DDL for DuckDB.
 * Sources:
 *   - Tables: https://github.com/MIT-LCP/mimic-code/blob/main/mimic-iii/buildmimic/postgres/postgres_create_tables.sql
 *   - Constraints: https://github.com/MIT-LCP/mimic-code/blob/main/mimic-iii/buildmimic/postgres/postgres_add_constraints.sql
 *
 * Includes: CREATE TABLE, FOREIGN KEY constraints.
 * MIMIC-III uses row_id as surrogate PK for most tables (not declared as PK in official DDL).
 * Schema prefixes removed. DROP CONSTRAINT IF EXISTS removed.
 * TIMESTAMP(0) simplified to TIMESTAMP. DOUBLE PRECISION changed to DOUBLE. CHAR(n) changed to VARCHAR.
 * Table names lowercased to match convention.
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

-- ============================================================
-- Foreign Key Constraints
-- ============================================================

-- admissions
ALTER TABLE admissions ADD CONSTRAINT admissions_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);

-- callout
ALTER TABLE callout ADD CONSTRAINT callout_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE callout ADD CONSTRAINT callout_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- chartevents
ALTER TABLE chartevents ADD CONSTRAINT chartevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_fk_itemid FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);

-- cptevents
ALTER TABLE cptevents ADD CONSTRAINT cptevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE cptevents ADD CONSTRAINT cptevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- datetimeevents
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_fk_itemid FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);

-- diagnoses_icd
ALTER TABLE diagnoses_icd ADD CONSTRAINT diagnoses_icd_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE diagnoses_icd ADD CONSTRAINT diagnoses_icd_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- drgcodes
ALTER TABLE drgcodes ADD CONSTRAINT drgcodes_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE drgcodes ADD CONSTRAINT drgcodes_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- icustays
ALTER TABLE icustays ADD CONSTRAINT icustays_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE icustays ADD CONSTRAINT icustays_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- inputevents_cv
ALTER TABLE inputevents_cv ADD CONSTRAINT inputevents_cv_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE inputevents_cv ADD CONSTRAINT inputevents_cv_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE inputevents_cv ADD CONSTRAINT inputevents_cv_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);
ALTER TABLE inputevents_cv ADD CONSTRAINT inputevents_cv_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);

-- inputevents_mv
ALTER TABLE inputevents_mv ADD CONSTRAINT inputevents_mv_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE inputevents_mv ADD CONSTRAINT inputevents_mv_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE inputevents_mv ADD CONSTRAINT inputevents_mv_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);
ALTER TABLE inputevents_mv ADD CONSTRAINT inputevents_mv_fk_itemid FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE inputevents_mv ADD CONSTRAINT inputevents_mv_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);

-- labevents
ALTER TABLE labevents ADD CONSTRAINT labevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE labevents ADD CONSTRAINT labevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE labevents ADD CONSTRAINT labevents_fk_itemid FOREIGN KEY (itemid) REFERENCES d_labitems (itemid);

-- microbiologyevents
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_fk_spec_itemid FOREIGN KEY (spec_itemid) REFERENCES d_items (itemid);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_fk_org_itemid FOREIGN KEY (org_itemid) REFERENCES d_items (itemid);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_fk_ab_itemid FOREIGN KEY (ab_itemid) REFERENCES d_items (itemid);

-- noteevents
ALTER TABLE noteevents ADD CONSTRAINT noteevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE noteevents ADD CONSTRAINT noteevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE noteevents ADD CONSTRAINT noteevents_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);

-- outputevents
ALTER TABLE outputevents ADD CONSTRAINT outputevents_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_fk_itemid FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);

-- prescriptions
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);

-- procedureevents_mv
ALTER TABLE procedureevents_mv ADD CONSTRAINT procedureevents_mv_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE procedureevents_mv ADD CONSTRAINT procedureevents_mv_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE procedureevents_mv ADD CONSTRAINT procedureevents_mv_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);
ALTER TABLE procedureevents_mv ADD CONSTRAINT procedureevents_mv_fk_itemid FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE procedureevents_mv ADD CONSTRAINT procedureevents_mv_fk_cgid FOREIGN KEY (cgid) REFERENCES caregivers (cgid);

-- procedures_icd
ALTER TABLE procedures_icd ADD CONSTRAINT procedures_icd_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE procedures_icd ADD CONSTRAINT procedures_icd_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- services
ALTER TABLE services ADD CONSTRAINT services_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE services ADD CONSTRAINT services_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);

-- transfers
ALTER TABLE transfers ADD CONSTRAINT transfers_fk_subject_id FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE transfers ADD CONSTRAINT transfers_fk_hadm_id FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE transfers ADD CONSTRAINT transfers_fk_icustay_id FOREIGN KEY (icustay_id) REFERENCES icustays (icustay_id);
`
