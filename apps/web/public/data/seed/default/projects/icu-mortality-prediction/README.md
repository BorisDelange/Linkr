# Early Prediction of In-Hospital Mortality in the ICU Using First-24-Hour Data

## Background

Mortality prediction in the intensive care unit (ICU) is central to clinical decision-making, resource allocation, and benchmarking of care quality. Established severity scores — APACHE II, SAPS II, SOFA — have been widely adopted but present well-known limitations: they were developed on historical cohorts, rely on fixed variable sets, and use pre-defined weighting schemes that do not adapt to local case-mix. Several studies have shown that logistic regression and machine learning models trained on routinely collected electronic health record (EHR) data can match or outperform these traditional scores.

This project explores whether predictive models fitted on variables available within the **first 24 hours** of ICU admission can effectively discriminate between survivors and non-survivors — using only data from the OMOP Common Data Model.

## Objective

Develop and evaluate predictive models for **in-hospital mortality** among ICU patients, using demographics and physiological measurements collected during the first 24 hours of stay (H0–H24).

## Data

The dataset is the **MIMIC-IV demo** (version 2.2), a freely available subset of the MIMIC-IV clinical database, mapped to the **OMOP CDM v5.4** format. It contains 100 unique patients with ICU stays at Beth Israel Deaconess Medical Center (Boston, USA).

After applying inclusion criteria (hospital stay $\geq$ 24 h, at least one measurement in H0–H24), the final cohort comprises **242 ICU visits** from 100 patients, with **13 deaths** (5.4% mortality rate).

## Scripts

The project contains two **self-contained study notebooks** and three **example scripts** (one per file type).

### 1. Exploratory Data Analysis (`01_eda_mortality.ipynb`)

**Self-contained** Jupyter notebook performing the full EDA pipeline:

- OMOP concept exploration (domains, vocabularies, available measurements)
- Cohort extraction via SQL (eligible visits $\geq$ 24h, mortality flag, demographics)
- Feature engineering (H0–H24 measurements: vitals mean/min/max, labs first value, GCS worst)
- Wide-format dataset export (one row per visit, ~45 features)
- Cohort overview: demographics, age/sex distributions, admission timeline
- Feature distributions by outcome (vitals, labs, GCS)
- Missing data analysis and patterns by outcome
- Correlation matrix and multicollinearity detection
- Table 1 with descriptive statistics
- Univariate associations (point-biserial correlation)
- Outlier detection with clinical plausibility ranges

### 2. Machine Learning Pipeline (`02_ml_mortality.qmd`)

**Self-contained** Quarto R report with full ML pipeline:

- Cohort extraction & feature engineering (same as notebook 1)
- Data preparation: feature selection, median imputation
- Train/test split (75/25 stratified)
- Logistic regression (baseline) with odds ratios
- Decision tree (rpart)
- Model comparison: ROC curves, confusion matrix
- Calibration analysis
- Feature importance (standardized coefficients + tree importance)
- Threshold analysis (sensitivity/specificity/F1 trade-offs)

### 3–5. Example scripts

Standalone examples demonstrating each file type (each can be run independently):

| Script | Language | Description |
|---|---|---|
| `03_example.sql` | SQL | Cohort extraction from OMOP CDM tables |
| `04_example.py` | Python | Cohort + feature engineering + CSV export (`sql_query()` + pandas) |
| `05_example.R` | R | Cohort + feature engineering + statistics + logistic regression (`sql_query()`) |

## Features extracted

| Category | Variables | Aggregation |
|---|---|---|
| **Vital signs** (7) | Heart rate, SBP, DBP, MBP, respiratory rate, SpO$_2$, temperature | Mean, min, max |
| **Laboratory** (15) | Hemoglobin, hematocrit, platelets, WBC, Na, K, Cl, HCO$_3$, creatinine, BUN, glucose, anion gap, Ca, Mg, phosphate | First value |
| **Neurological** (3) | GCS eye, verbal, motor | Minimum |

The OMOP long-format data is pivoted into a **one-row-per-visit wide dataset** (242 rows $\times$ ~45 columns).

## Limitations

- **Small sample size**: 100 patients / 13 deaths limits statistical power and generalizability
- **Demo dataset**: MIMIC-IV demo is a convenience sample
- **Single-center data**: Beth Israel Deaconess Medical Center only
- **H0–H24 only**: no time-series modeling, no features after 24h
- **Median imputation**: simple approach, no multiple imputation
- **No external validation**: single-center, no temporal split

## References

1. Johnson, A. et al. *MIMIC-IV, a freely accessible electronic health record dataset.* Sci Data 10, 1 (2023).
2. Knaus, W.A. et al. *APACHE II: a severity of disease classification system.* Crit Care Med 13, 818–829 (1985).
3. Le Gall, J.R. et al. *A new Simplified Acute Physiology Score (SAPS II).* JAMA 270, 2957–2963 (1993).
