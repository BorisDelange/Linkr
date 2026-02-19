/**
 * MIMIC-IV v2.2 complete DDL for DuckDB.
 * Sources:
 *   - Tables: https://github.com/MIT-LCP/mimic-code/blob/main/mimic-iv/buildmimic/postgres/create.sql
 *   - Constraints: https://github.com/MIT-LCP/mimic-code/blob/main/mimic-iv/buildmimic/postgres/constraint.sql
 *
 * Includes: CREATE TABLE, PRIMARY KEY constraints, FOREIGN KEY constraints.
 * Schema prefixes (mimiciv_hosp, mimiciv_icu) removed.
 * DROP CONSTRAINT IF EXISTS statements removed.
 * TIMESTAMP(n) precision simplified to TIMESTAMP. CHAR(n) changed to VARCHAR.
 */
export const MIMIC_IV_DDL = `-- MIMIC-IV v2.2 DDL (DuckDB)
-- https://physionet.org/content/mimic-iv-demo/2.2/

-- ============================================================
-- hosp module
-- ============================================================

CREATE TABLE admissions (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  admittime TIMESTAMP NOT NULL,
  dischtime TIMESTAMP,
  deathtime TIMESTAMP,
  admission_type VARCHAR(40) NOT NULL,
  admit_provider_id VARCHAR(10),
  admission_location VARCHAR(60),
  discharge_location VARCHAR(60),
  insurance VARCHAR(255),
  language VARCHAR(25),
  marital_status VARCHAR(30),
  race VARCHAR(80),
  edregtime TIMESTAMP,
  edouttime TIMESTAMP,
  hospital_expire_flag SMALLINT
);

CREATE TABLE d_hcpcs (
  code VARCHAR(5) NOT NULL,
  category SMALLINT,
  long_description TEXT,
  short_description VARCHAR(180)
);

CREATE TABLE diagnoses_icd (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  seq_num INTEGER NOT NULL,
  icd_code VARCHAR(7),
  icd_version SMALLINT
);

CREATE TABLE d_icd_diagnoses (
  icd_code VARCHAR(7) NOT NULL,
  icd_version SMALLINT NOT NULL,
  long_title VARCHAR(255)
);

CREATE TABLE d_icd_procedures (
  icd_code VARCHAR(7) NOT NULL,
  icd_version SMALLINT NOT NULL,
  long_title VARCHAR(222)
);

CREATE TABLE d_labitems (
  itemid INTEGER NOT NULL,
  label VARCHAR(50),
  fluid VARCHAR(50),
  category VARCHAR(50)
);

CREATE TABLE drgcodes (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  drg_type VARCHAR(4),
  drg_code VARCHAR(10) NOT NULL,
  description VARCHAR(195),
  drg_severity SMALLINT,
  drg_mortality SMALLINT
);

CREATE TABLE emar (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  emar_id VARCHAR(25) NOT NULL,
  emar_seq INTEGER NOT NULL,
  poe_id VARCHAR(25) NOT NULL,
  pharmacy_id INTEGER,
  enter_provider_id VARCHAR(10),
  charttime TIMESTAMP NOT NULL,
  medication TEXT,
  event_txt VARCHAR(100),
  scheduletime TIMESTAMP,
  storetime TIMESTAMP NOT NULL
);

CREATE TABLE emar_detail (
  subject_id INTEGER NOT NULL,
  emar_id VARCHAR(25) NOT NULL,
  emar_seq INTEGER NOT NULL,
  parent_field_ordinal VARCHAR(10),
  administration_type VARCHAR(50),
  pharmacy_id INTEGER,
  barcode_type VARCHAR(4),
  reason_for_no_barcode TEXT,
  complete_dose_not_given VARCHAR(5),
  dose_due VARCHAR(100),
  dose_due_unit VARCHAR(50),
  dose_given VARCHAR(255),
  dose_given_unit VARCHAR(50),
  will_remainder_of_dose_be_given VARCHAR(5),
  product_amount_given VARCHAR(30),
  product_unit VARCHAR(30),
  product_code VARCHAR(30),
  product_description VARCHAR(255),
  product_description_other VARCHAR(255),
  prior_infusion_rate VARCHAR(40),
  infusion_rate VARCHAR(40),
  infusion_rate_adjustment VARCHAR(50),
  infusion_rate_adjustment_amount VARCHAR(30),
  infusion_rate_unit VARCHAR(30),
  route VARCHAR(10),
  infusion_complete VARCHAR(1),
  completion_interval VARCHAR(50),
  new_iv_bag_hung VARCHAR(1),
  continued_infusion_in_other_location VARCHAR(1),
  restart_interval VARCHAR(2305),
  side VARCHAR(10),
  site VARCHAR(255),
  non_formulary_visual_verification VARCHAR(1)
);

CREATE TABLE hcpcsevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  chartdate DATE,
  hcpcs_cd VARCHAR(5) NOT NULL,
  seq_num INTEGER NOT NULL,
  short_description VARCHAR(180)
);

CREATE TABLE labevents (
  labevent_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  specimen_id INTEGER NOT NULL,
  itemid INTEGER NOT NULL,
  order_provider_id VARCHAR(10),
  charttime TIMESTAMP,
  storetime TIMESTAMP,
  value VARCHAR(200),
  valuenum DOUBLE,
  valueuom VARCHAR(20),
  ref_range_lower DOUBLE,
  ref_range_upper DOUBLE,
  flag VARCHAR(10),
  priority VARCHAR(7),
  comments TEXT
);

CREATE TABLE microbiologyevents (
  microevent_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  micro_specimen_id INTEGER NOT NULL,
  order_provider_id VARCHAR(10),
  chartdate TIMESTAMP NOT NULL,
  charttime TIMESTAMP,
  spec_itemid INTEGER NOT NULL,
  spec_type_desc VARCHAR(100) NOT NULL,
  test_seq INTEGER NOT NULL,
  storedate TIMESTAMP,
  storetime TIMESTAMP,
  test_itemid INTEGER,
  test_name VARCHAR(100),
  org_itemid INTEGER,
  org_name VARCHAR(100),
  isolate_num SMALLINT,
  quantity VARCHAR(50),
  ab_itemid INTEGER,
  ab_name VARCHAR(30),
  dilution_text VARCHAR(10),
  dilution_comparison VARCHAR(20),
  dilution_value DOUBLE,
  interpretation VARCHAR(5),
  comments TEXT
);

CREATE TABLE omr (
  subject_id INTEGER NOT NULL,
  chartdate DATE NOT NULL,
  seq_num INTEGER NOT NULL,
  result_name VARCHAR(100) NOT NULL,
  result_value TEXT NOT NULL
);

CREATE TABLE patients (
  subject_id INTEGER NOT NULL,
  gender VARCHAR(1) NOT NULL,
  anchor_age SMALLINT,
  anchor_year SMALLINT NOT NULL,
  anchor_year_group VARCHAR(20) NOT NULL,
  dod DATE
);

CREATE TABLE pharmacy (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  pharmacy_id INTEGER NOT NULL,
  poe_id VARCHAR(25),
  starttime TIMESTAMP,
  stoptime TIMESTAMP,
  medication TEXT,
  proc_type VARCHAR(50) NOT NULL,
  status VARCHAR(50),
  entertime TIMESTAMP NOT NULL,
  verifiedtime TIMESTAMP,
  route VARCHAR(50),
  frequency VARCHAR(50),
  disp_sched VARCHAR(255),
  infusion_type VARCHAR(15),
  sliding_scale VARCHAR(1),
  lockout_interval VARCHAR(50),
  basal_rate REAL,
  one_hr_max VARCHAR(10),
  doses_per_24_hrs REAL,
  duration REAL,
  duration_interval VARCHAR(50),
  expiration_value INTEGER,
  expiration_unit VARCHAR(50),
  expirationdate TIMESTAMP,
  dispensation VARCHAR(50),
  fill_quantity VARCHAR(50)
);

CREATE TABLE poe (
  poe_id VARCHAR(25) NOT NULL,
  poe_seq INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  ordertime TIMESTAMP NOT NULL,
  order_type VARCHAR(25) NOT NULL,
  order_subtype VARCHAR(50),
  transaction_type VARCHAR(15),
  discontinue_of_poe_id VARCHAR(25),
  discontinued_by_poe_id VARCHAR(25),
  order_provider_id VARCHAR(10),
  order_status VARCHAR(15)
);

CREATE TABLE poe_detail (
  poe_id VARCHAR(25) NOT NULL,
  poe_seq INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  field_name VARCHAR(255) NOT NULL,
  field_value TEXT
);

CREATE TABLE prescriptions (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  pharmacy_id INTEGER NOT NULL,
  poe_id VARCHAR(25),
  poe_seq INTEGER,
  order_provider_id VARCHAR(10),
  starttime TIMESTAMP,
  stoptime TIMESTAMP,
  drug_type VARCHAR(20) NOT NULL,
  drug VARCHAR(255) NOT NULL,
  formulary_drug_cd VARCHAR(50),
  gsn VARCHAR(255),
  ndc VARCHAR(25),
  prod_strength VARCHAR(255),
  form_rx VARCHAR(25),
  dose_val_rx VARCHAR(100),
  dose_unit_rx VARCHAR(50),
  form_val_disp VARCHAR(50),
  form_unit_disp VARCHAR(50),
  doses_per_24_hrs REAL,
  route VARCHAR(50)
);

CREATE TABLE procedures_icd (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  seq_num INTEGER NOT NULL,
  chartdate DATE NOT NULL,
  icd_code VARCHAR(7),
  icd_version SMALLINT
);

CREATE TABLE provider (
  provider_id VARCHAR(10) NOT NULL
);

CREATE TABLE services (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  transfertime TIMESTAMP NOT NULL,
  prev_service VARCHAR(10),
  curr_service VARCHAR(10)
);

CREATE TABLE transfers (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER,
  transfer_id INTEGER NOT NULL,
  eventtype VARCHAR(10),
  careunit VARCHAR(255),
  intime TIMESTAMP,
  outtime TIMESTAMP
);

-- ============================================================
-- note module
-- ============================================================

CREATE TABLE discharge (
  note_id VARCHAR(25) NOT NULL,
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  note_type VARCHAR(2) NOT NULL,
  note_seq SMALLINT NOT NULL,
  charttime TIMESTAMP NOT NULL,
  storetime TIMESTAMP,
  text TEXT NOT NULL
);

-- ============================================================
-- icu module
-- ============================================================

CREATE TABLE caregiver (
  caregiver_id INTEGER NOT NULL
);

CREATE TABLE chartevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER NOT NULL,
  caregiver_id INTEGER,
  charttime TIMESTAMP NOT NULL,
  storetime TIMESTAMP,
  itemid INTEGER NOT NULL,
  value VARCHAR(200),
  valuenum FLOAT,
  valueuom VARCHAR(20),
  warning SMALLINT
);

CREATE TABLE d_items (
  itemid INTEGER NOT NULL,
  label VARCHAR(100) NOT NULL,
  abbreviation VARCHAR(50) NOT NULL,
  linksto VARCHAR(30) NOT NULL,
  category VARCHAR(50) NOT NULL,
  unitname VARCHAR(50),
  param_type VARCHAR(20) NOT NULL,
  lownormalvalue FLOAT,
  highnormalvalue FLOAT
);

CREATE TABLE datetimeevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER NOT NULL,
  caregiver_id INTEGER,
  charttime TIMESTAMP NOT NULL,
  storetime TIMESTAMP,
  itemid INTEGER NOT NULL,
  value TIMESTAMP NOT NULL,
  valueuom VARCHAR(20),
  warning SMALLINT
);

CREATE TABLE icustays (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER NOT NULL,
  first_careunit VARCHAR(255),
  last_careunit VARCHAR(255),
  intime TIMESTAMP,
  outtime TIMESTAMP,
  los FLOAT
);

CREATE TABLE ingredientevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER,
  caregiver_id INTEGER,
  starttime TIMESTAMP NOT NULL,
  endtime TIMESTAMP NOT NULL,
  storetime TIMESTAMP,
  itemid INTEGER NOT NULL,
  amount FLOAT,
  amountuom VARCHAR(20),
  rate FLOAT,
  rateuom VARCHAR(20),
  orderid INTEGER NOT NULL,
  linkorderid INTEGER,
  statusdescription VARCHAR(20),
  originalamount FLOAT,
  originalrate FLOAT
);

CREATE TABLE inputevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER,
  caregiver_id INTEGER,
  starttime TIMESTAMP NOT NULL,
  endtime TIMESTAMP NOT NULL,
  storetime TIMESTAMP,
  itemid INTEGER NOT NULL,
  amount FLOAT,
  amountuom VARCHAR(20),
  rate FLOAT,
  rateuom VARCHAR(20),
  orderid INTEGER NOT NULL,
  linkorderid INTEGER,
  ordercategoryname VARCHAR(50),
  secondaryordercategoryname VARCHAR(50),
  ordercomponenttypedescription VARCHAR(100),
  ordercategorydescription VARCHAR(30),
  patientweight FLOAT,
  totalamount FLOAT,
  totalamountuom VARCHAR(50),
  isopenbag SMALLINT,
  continueinnextdept SMALLINT,
  statusdescription VARCHAR(20),
  originalamount FLOAT,
  originalrate FLOAT
);

CREATE TABLE outputevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER NOT NULL,
  caregiver_id INTEGER,
  charttime TIMESTAMP NOT NULL,
  storetime TIMESTAMP NOT NULL,
  itemid INTEGER NOT NULL,
  value FLOAT NOT NULL,
  valueuom VARCHAR(20)
);

CREATE TABLE procedureevents (
  subject_id INTEGER NOT NULL,
  hadm_id INTEGER NOT NULL,
  stay_id INTEGER NOT NULL,
  caregiver_id INTEGER,
  starttime TIMESTAMP NOT NULL,
  endtime TIMESTAMP NOT NULL,
  storetime TIMESTAMP NOT NULL,
  itemid INTEGER NOT NULL,
  value FLOAT,
  valueuom VARCHAR(20),
  location VARCHAR(100),
  locationcategory VARCHAR(50),
  orderid INTEGER,
  linkorderid INTEGER,
  ordercategoryname VARCHAR(50),
  ordercategorydescription VARCHAR(30),
  patientweight FLOAT,
  isopenbag SMALLINT,
  continueinnextdept SMALLINT,
  statusdescription VARCHAR(20),
  originalamount FLOAT,
  originalrate FLOAT
);

-- ============================================================
-- Primary Key Constraints
-- ============================================================

-- hosp
ALTER TABLE admissions ADD CONSTRAINT admissions_pk PRIMARY KEY (hadm_id);
ALTER TABLE d_hcpcs ADD CONSTRAINT d_hcpcs_pk PRIMARY KEY (code);
ALTER TABLE diagnoses_icd ADD CONSTRAINT diagnoses_icd_pk PRIMARY KEY (hadm_id, seq_num, icd_code, icd_version);
ALTER TABLE d_icd_diagnoses ADD CONSTRAINT d_icd_diagnoses_pk PRIMARY KEY (icd_code, icd_version);
ALTER TABLE d_icd_procedures ADD CONSTRAINT d_icd_procedures_pk PRIMARY KEY (icd_code, icd_version);
ALTER TABLE d_labitems ADD CONSTRAINT d_labitems_pk PRIMARY KEY (itemid);
ALTER TABLE emar ADD CONSTRAINT emar_pk PRIMARY KEY (emar_id);
ALTER TABLE hcpcsevents ADD CONSTRAINT hcpcsevents_pk PRIMARY KEY (hadm_id, hcpcs_cd, seq_num);
ALTER TABLE labevents ADD CONSTRAINT labevents_pk PRIMARY KEY (labevent_id);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_pk PRIMARY KEY (microevent_id);
ALTER TABLE patients ADD CONSTRAINT patients_pk PRIMARY KEY (subject_id);
ALTER TABLE pharmacy ADD CONSTRAINT pharmacy_pk PRIMARY KEY (pharmacy_id);
ALTER TABLE poe_detail ADD CONSTRAINT poe_detail_pk PRIMARY KEY (poe_id, field_name);
ALTER TABLE poe ADD CONSTRAINT poe_pk PRIMARY KEY (poe_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_pk PRIMARY KEY (pharmacy_id, drug_type, drug);
ALTER TABLE procedures_icd ADD CONSTRAINT procedures_icd_pk PRIMARY KEY (hadm_id, seq_num, icd_code, icd_version);
ALTER TABLE services ADD CONSTRAINT services_pk PRIMARY KEY (hadm_id, transfertime, curr_service);
ALTER TABLE transfers ADD CONSTRAINT transfers_pk PRIMARY KEY (transfer_id);

-- icu
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_pk PRIMARY KEY (stay_id, itemid, charttime);
ALTER TABLE d_items ADD CONSTRAINT d_items_pk PRIMARY KEY (itemid);
ALTER TABLE icustays ADD CONSTRAINT icustays_pk PRIMARY KEY (stay_id);
ALTER TABLE inputevents ADD CONSTRAINT inputevents_pk PRIMARY KEY (orderid, itemid);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_pk PRIMARY KEY (stay_id, charttime, itemid);
ALTER TABLE procedureevents ADD CONSTRAINT procedureevents_pk PRIMARY KEY (orderid);

-- ============================================================
-- Foreign Key Constraints
-- ============================================================

-- hosp
ALTER TABLE admissions ADD CONSTRAINT admissions_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE diagnoses_icd ADD CONSTRAINT diagnoses_icd_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE diagnoses_icd ADD CONSTRAINT diagnoses_icd_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE drgcodes ADD CONSTRAINT drgcodes_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE drgcodes ADD CONSTRAINT drgcodes_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE emar_detail ADD CONSTRAINT emar_detail_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE emar_detail ADD CONSTRAINT emar_detail_emar_fk FOREIGN KEY (emar_id) REFERENCES emar (emar_id);
ALTER TABLE emar ADD CONSTRAINT emar_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE emar ADD CONSTRAINT emar_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE hcpcsevents ADD CONSTRAINT hcpcsevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE hcpcsevents ADD CONSTRAINT hcpcsevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE hcpcsevents ADD CONSTRAINT hcpcsevents_d_hcpcs_fk FOREIGN KEY (hcpcs_cd) REFERENCES d_hcpcs (code);
ALTER TABLE labevents ADD CONSTRAINT labevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE labevents ADD CONSTRAINT labevents_d_labitems_fk FOREIGN KEY (itemid) REFERENCES d_labitems (itemid);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE microbiologyevents ADD CONSTRAINT microbiologyevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE pharmacy ADD CONSTRAINT pharmacy_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE pharmacy ADD CONSTRAINT pharmacy_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE poe_detail ADD CONSTRAINT poe_detail_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE poe_detail ADD CONSTRAINT poe_detail_poe_fk FOREIGN KEY (poe_id) REFERENCES poe (poe_id);
ALTER TABLE poe ADD CONSTRAINT poe_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE poe ADD CONSTRAINT poe_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE procedures_icd ADD CONSTRAINT procedures_icd_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE procedures_icd ADD CONSTRAINT procedures_icd_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE services ADD CONSTRAINT services_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE services ADD CONSTRAINT services_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE transfers ADD CONSTRAINT transfers_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);

-- icu
ALTER TABLE chartevents ADD CONSTRAINT chartevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_icustays_fk FOREIGN KEY (stay_id) REFERENCES icustays (stay_id);
ALTER TABLE chartevents ADD CONSTRAINT chartevents_d_items_fk FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_icustays_fk FOREIGN KEY (stay_id) REFERENCES icustays (stay_id);
ALTER TABLE datetimeevents ADD CONSTRAINT datetimeevents_d_items_fk FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE icustays ADD CONSTRAINT icustays_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE icustays ADD CONSTRAINT icustays_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE inputevents ADD CONSTRAINT inputevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE inputevents ADD CONSTRAINT inputevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE inputevents ADD CONSTRAINT inputevents_icustays_fk FOREIGN KEY (stay_id) REFERENCES icustays (stay_id);
ALTER TABLE inputevents ADD CONSTRAINT inputevents_d_items_fk FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_icustays_fk FOREIGN KEY (stay_id) REFERENCES icustays (stay_id);
ALTER TABLE outputevents ADD CONSTRAINT outputevents_d_items_fk FOREIGN KEY (itemid) REFERENCES d_items (itemid);
ALTER TABLE procedureevents ADD CONSTRAINT procedureevents_patients_fk FOREIGN KEY (subject_id) REFERENCES patients (subject_id);
ALTER TABLE procedureevents ADD CONSTRAINT procedureevents_admissions_fk FOREIGN KEY (hadm_id) REFERENCES admissions (hadm_id);
ALTER TABLE procedureevents ADD CONSTRAINT procedureevents_icustays_fk FOREIGN KEY (stay_id) REFERENCES icustays (stay_id);
ALTER TABLE procedureevents ADD CONSTRAINT procedureevents_d_items_fk FOREIGN KEY (itemid) REFERENCES d_items (itemid);
`
