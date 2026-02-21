# ETL Comparison Tab — Notes for later

## Changes made (2026-02-22)

### 1. Deduplication of concept_relationship fan-out (scripts 05-12)
- Created `tmp_icd_concept_map` with `QUALIFY ROW_NUMBER()` in script 05, reused in 06 and 09
- Added `ROW_NUMBER()` dedup to temp tables: `tmp_pr_ndc_concept`, `tmp_pr_gcpt_concept`, `tmp_pr_route_concept` (script 07)
- Added `QUALIFY ROW_NUMBER()` to `tmp_d_labitems_concept`, `tmp_chartevents_concept` (script 08)
- Added nested dedup to `tmp_meas_unit_concept` (script 08)
- Added `ROW_NUMBER()` to `tmp_obs_value_concept` (script 09)
- Added `QUALIFY ROW_NUMBER()` to `tmp_d_micro_concept` (script 11)
- Script 12 now reuses deduplicated `tmp_chartevents_concept` from script 08

### 2. Fixed `src.charttime` bug in script 08
- The ambulatory visit JOIN in the labevents INSERT referenced `src.charttime` but the column was renamed to `start_datetime` in `tmp_labevents_clean`.

### 3. Fixed comparison logic for N:1 mappings
- Old: compared individual sourceRows vs targetRows → false "More" when multiple source concepts map to same target
- New: aggregates total sourceRows per target_concept_id before comparing
- Removed 10% tolerance — now uses exact match (any difference shows "fewer" or "more")

## Remaining issues to investigate

### 14 "More" concepts (after dedup + aggregation fix)
- Example: Respiratory Rate (LOINC 3024171) — 13,913 sourceRows vs 15,244 targetRows
- Likely causes:
  1. Same standard concept reached via DIFFERENT source vocabularies (e.g., d_items AND d_labitems both map to same LOINC)
  2. The aggregation only sums sourceRows from STCM entries, but some clinical rows may have `*_concept_id` set without a corresponding STCM entry (e.g., hardcoded concept IDs in ETL scripts like visit_type, gender, etc.)
  3. Some rows may have `*_source_concept_id = 0` but valid `*_concept_id` (unmapped source but known target)

### Possible fix approaches
- Extend aggregation to also consider cross-vocabulary source concepts (d_items + d_labitems → same LOINC)
- Or accept these as expected: N:1 mapping means target always >= sum of tracked sources
- Could add a "delta" column showing the exact difference instead of just status badges

### ETL_FILES_VERSION = 11
