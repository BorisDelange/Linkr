# ICU Activity Dashboard

## Overview

This project provides an **ICU activity monitoring dashboard** built from the MIMIC-IV demo database (100 patients, OMOP CDM format). It extracts key clinical indicators from routine electronic health record data and presents them as a set of interactive visualizations.

## Data

The dataset is extracted from the **MIMIC-IV Demo** mapped to **OMOP CDM v5.4**. The extraction pipeline:

1. **Identifies ICU stays** from `visit_detail` + `care_site` (172 stays across 7 ICU units)
2. **Joins demographics** (age, sex, race) from `person`
3. **Extracts measurements** (vitals, labs, ventilation parameters) from `measurement`
4. **Detects events**: mechanical ventilation, infections, procedures from OMOP clinical tables
5. **Outputs a long-typed CSV** with stay-level and event-level rows

## Indicator Domains

| Domain | Key Indicators |
|---|---|
| **Demographics** | Age distribution, sex ratio, mortality rate (ICU / hospital) |
| **Admissions & Flow** | Admission timeline, length of stay, ICU unit distribution, readmissions <48h |
| **Mechanical Ventilation** | Ventilation rate, duration, tidal volume/PBW, PEEP, FiO2 |
| **Infections** | Infection types (sepsis, pneumonia, UTI), pathogen distribution |
| **Procedures** | CVC, PICC, arterial lines, tracheostomy, extubation |

## Scripts

| Script | Description |
|---|---|
| `01_extract_icu_data.sql` | SQL queries to identify ICU stays and extract clinical data from OMOP tables |
| `02_build_dataset.py` | Python pipeline to build the wide-format analytical dataset |

## Key Figures (MIMIC-IV Demo)

- **172 ICU stays** from **100 patients**
- **7 ICU units**: MICU, SICU, CVICU, CCU, TSICU, MICU/SICU, Neuro SICU
- **43% mechanically ventilated** (median 25.4h)
- **7.6% ICU mortality**, 13.4% hospital mortality
- **23% readmissions** within 48h
