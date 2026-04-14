# Concept Mapping — Reference

## ConceptMapping type definition

```typescript
interface ConceptMapping {
  id: string                    // UUID v4
  projectId: string             // from project.json "id" field

  // SOURCE (from source-concepts.csv)
  sourceConceptId: number       // row index or concept ID from file
  sourceConceptName: string     // concept_name column
  sourceVocabularyId: string    // terminology column
  sourceDomainId: string        // inferred or empty
  sourceConceptCode: string     // concept_code column
  sourceFrequency?: number      // record_count column
  sourceCategoryId?: string     // full_name from info_json (hierarchical path)
  sourceSubcategoryId?: string
  sourceConceptClassId?: string

  // TARGET (from OMOP vocabulary)
  targetConceptId: number       // concept_id from CONCEPT table
  targetConceptName: string     // concept_name from CONCEPT table
  targetVocabularyId: string    // vocabulary_id (LOINC, SNOMED, RxNorm, etc.)
  targetDomainId: string        // domain_id (Measurement, Condition, Drug, etc.)
  targetConceptCode: string     // concept_code
  targetConceptClassId?: string // concept_class_id
  targetStandardConcept?: string // 'S' (standard) or 'C' (classification)

  // MAPPING METADATA
  conceptSetId?: string         // link to a concept set if applicable
  equivalence: string           // skos:exactMatch | closeMatch | broadMatch | narrowMatch | relatedMatch
  status: string                // unchecked | approved | rejected | flagged | invalid | ignored
  matchScore?: number           // 0-1 confidence score
  comments?: MappingComment[]   // threaded comments — use this for mapping reasoning
  reviews?: MappingReview[]     // reviewer opinions

  // ATTRIBUTION
  mappedBy?: string             // "Claude Opus 4.6" (or current model name)
  mappedOn?: string             // ISO 8601 date
  assignedReviewer?: string
  reviewedBy?: string
  reviewedOn?: string
  reviewComment?: string

  createdAt: string             // ISO 8601 date
  updatedAt: string             // ISO 8601 date
}
```

## Source concepts CSV structure

The exported `source-concepts.csv` has these columns (order may vary):

| Column | Description |
|--------|------------|
| `terminology` | Source vocabulary identifier (e.g., "REA", "LABO") |
| `concept_code` | Local code (e.g., "Parameter_4599") |
| `concept_name` | Human-readable name (may be French or abbreviated) |
| `record_count` | Number of records with this concept |
| `patient_count` | Number of distinct patients |
| `info_json` | JSON string with detailed metadata (see below) |

**Note**: Some exports may also have `category` and `subcategory` columns. Always check the actual CSV header.

## info_json structure

The `info_json` column contains a JSON object with rich metadata about each source concept:

```json
{
  "full_name": "Vital signs / Monitoring / Heart rate",
  "data_source": "OMOP CDM v5.4",
  "data_types": "numerical",

  // For numerical concepts:
  "numerical_data": {
    "mean": 82.3,
    "median": 78.0,
    "min": 20.0,
    "max": 250.0,
    "std": 18.7,
    "unit": "bpm",
    "q1": 68.0,
    "q3": 92.0,
    "percentiles": {"5": 52, "25": 68, "50": 78, "75": 92, "95": 120}
  },

  // For categorical concepts:
  "categorical_data": [
    {"category": "Normal", "count": 1200, "percentage": 75.0},
    {"category": "Abnormal", "count": 400, "percentage": 25.0}
  ],

  "missing_rate": 0.02,
  "measurement_frequency": "hourly",
  "temporal_distribution": {
    "start_date": "2019-01-01",
    "end_date": "2024-06-30",
    "by_year": [
      {"year": 2022, "percentage": 35},
      {"year": 2023, "percentage": 40}
    ]
  },
  "hospital_units": [
    {"unit": "Intensive Care Unit", "percentage": 80},
    {"unit": "Step-Down Unit", "percentage": 20}
  ]
}
```

### How to use info_json for mapping

- **`full_name`**: The hierarchical path reveals the category. Use the first segment to filter concepts (e.g., "Laboratoire", "Respiratoire", "Cardiologie et hemodynamique").
- **`data_types`**: "numerical" → likely Measurement domain. "categorical" → could be Observation, Condition, or administrative.
- **`numerical_data.unit`**: Compare with UCUM units expected by the LOINC code. e.g., if unit is "mmHg" and you map to a LOINC for blood pressure, that's consistent.
- **`numerical_data` ranges**: Help validate mapping. PaO2 should have values ~60-500 mmHg. Heart rate should be ~30-250 bpm.
- **`categorical_data`**: Reveals possible values. If categories are "Oui"/"Non", it's likely a boolean observation. If categories are medication names, it might be a drug exposure.
- **`measurement_frequency`**: "hourly" suggests continuous monitoring (vital signs). "daily" might be lab tests. "monthly or less" might be administrative.

## DuckDB query patterns

### Setup: Load vocabulary and source data

```sql
-- Load OMOP vocabularies (adjust path and format)
CREATE TABLE concept AS SELECT * FROM read_parquet('/path/CONCEPT.parquet');
CREATE TABLE concept_synonym AS SELECT * FROM read_parquet('/path/CONCEPT_SYNONYM.parquet');
CREATE TABLE concept_relationship AS SELECT * FROM read_parquet('/path/CONCEPT_RELATIONSHIP.parquet');
CREATE TABLE concept_ancestor AS SELECT * FROM read_parquet('/path/CONCEPT_ANCESTOR.parquet');

-- Load source data
CREATE TABLE source_concepts AS SELECT * FROM read_csv('/path/source-concepts.csv', auto_detect=true);
CREATE TABLE existing_mappings AS SELECT * FROM read_json('/path/mappings.json', auto_detect=true, format='array');
```

### Strategy 1: Direct name search on concept table

```sql
-- Search by exact or fuzzy name match (case-insensitive)
SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id, standard_concept
FROM concept
WHERE concept_name ILIKE '%heart rate%'
  AND standard_concept = 'S'
  AND invalid_reason IS NULL
ORDER BY
  CASE WHEN vocabulary_id = 'LOINC' THEN 1
       WHEN vocabulary_id = 'SNOMED' THEN 2
       ELSE 3 END,
  length(concept_name)
LIMIT 20;
```

### Strategy 2: Synonym search

```sql
-- Search synonyms for broader coverage
SELECT DISTINCT c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id,
       c.concept_class_id, c.standard_concept, cs.concept_synonym_name
FROM concept_synonym cs
JOIN concept c ON cs.concept_id = c.concept_id
WHERE cs.concept_synonym_name ILIKE '%heart rate%'
  AND c.standard_concept = 'S'
  AND c.invalid_reason IS NULL
ORDER BY length(c.concept_name)
LIMIT 20;
```

### Strategy 3: Keyword combination search

```sql
-- For multi-word concepts, search for key clinical terms
SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id
FROM concept
WHERE standard_concept = 'S'
  AND invalid_reason IS NULL
  AND (
    concept_name ILIKE '%systolic%blood%pressure%'
    OR concept_name ILIKE '%blood%pressure%systolic%'
  )
ORDER BY
  CASE WHEN vocabulary_id = 'LOINC' THEN 1
       WHEN vocabulary_id = 'SNOMED' THEN 2
       ELSE 3 END,
  length(concept_name)
LIMIT 20;
```

### Strategy 4: Find standard concept via "Maps to" relationship

```sql
-- When you find a non-standard concept, find its standard equivalent
SELECT c2.concept_id, c2.concept_name, c2.vocabulary_id, c2.domain_id,
       c2.concept_class_id, c2.standard_concept, cr.relationship_id
FROM concept_relationship cr
JOIN concept c2 ON cr.concept_id_2 = c2.concept_id
WHERE cr.concept_id_1 = <non_standard_concept_id>
  AND cr.relationship_id = 'Maps to'
  AND cr.invalid_reason IS NULL
  AND c2.standard_concept = 'S';
```

### Strategy 5: Explore hierarchy (ancestors/descendants)

```sql
-- Find ancestors (more general concepts)
SELECT c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id,
       ca.min_levels_of_separation, ca.max_levels_of_separation
FROM concept_ancestor ca
JOIN concept c ON ca.ancestor_concept_id = c.concept_id
WHERE ca.descendant_concept_id = <concept_id>
  AND c.standard_concept = 'S'
ORDER BY ca.min_levels_of_separation
LIMIT 10;

-- Find descendants (more specific concepts)
SELECT c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id,
       ca.min_levels_of_separation
FROM concept_ancestor ca
JOIN concept c ON ca.descendant_concept_id = c.concept_id
WHERE ca.ancestor_concept_id = <concept_id>
  AND c.standard_concept = 'S'
ORDER BY ca.min_levels_of_separation
LIMIT 20;
```

### Strategy 6: Fuzzy name matching (Jaro-Winkler)

DuckDB provides built-in string similarity functions. Use `jaro_winkler_similarity()` for fuzzy matching — it works well for clinical term variants (abbreviations, word reordering, typos).

**Important**: Fuzzy search must be done on the **English translation** of the source concept, not the original local name. Translate first, then search.

```sql
-- Fuzzy match on concept names (after translating source to English)
-- Replace 'heart rate' with the English translation of your source concept
SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id,
       jaro_winkler_similarity(lower(concept_name), lower('heart rate')) AS score
FROM concept
WHERE standard_concept = 'S'
  AND invalid_reason IS NULL
  AND jaro_winkler_similarity(lower(concept_name), lower('heart rate')) > 0.85
ORDER BY score DESC
LIMIT 15;
```

```sql
-- Fuzzy match on synonyms (broader coverage)
SELECT DISTINCT c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id,
       cs.concept_synonym_name,
       jaro_winkler_similarity(lower(cs.concept_synonym_name), lower('heart rate')) AS score
FROM concept_synonym cs
JOIN concept c ON cs.concept_id = c.concept_id
WHERE c.standard_concept = 'S'
  AND c.invalid_reason IS NULL
  AND jaro_winkler_similarity(lower(cs.concept_synonym_name), lower('heart rate')) > 0.85
ORDER BY score DESC
LIMIT 15;
```

**Available DuckDB string similarity functions:**

| Function | Returns | Best for |
|----------|---------|----------|
| `jaro_winkler_similarity(a, b)` | 0.0–1.0 (1=exact) | Short clinical terms, prefix-weighted |
| `levenshtein(a, b)` | edit distance (0=exact) | Typo detection |
| `damerau_levenshtein(a, b)` | edit distance with transpositions | Typo + swap detection |
| `jaccard(a, b)` | 0.0–1.0 (1=exact) | Character n-gram overlap |

**Threshold guidelines:**
- `> 0.95`: very high confidence (near-exact match)
- `0.85–0.95`: good candidate, review recommended
- `0.75–0.85`: weak match, may be a partial or broader match
- `< 0.75`: unlikely match

**Performance note**: Fuzzy search on the full `concept` table (4M+ rows) can be slow. Pre-filter with a `WHERE` clause on `domain_id`, `vocabulary_id`, or a simple `ILIKE` on partial keywords to reduce the search space before applying fuzzy scoring.

```sql
-- Optimized: pre-filter by domain + partial keyword, then fuzzy rank
SELECT concept_id, concept_name, vocabulary_id, concept_class_id,
       jaro_winkler_similarity(lower(concept_name), lower('respiratory rate')) AS score
FROM concept
WHERE standard_concept = 'S'
  AND invalid_reason IS NULL
  AND domain_id = 'Measurement'
  AND (concept_name ILIKE '%respir%' OR concept_name ILIKE '%breath%')
ORDER BY score DESC
LIMIT 15;
```

### List categories from info_json

```sql
-- Extract categories from full_name for filtering
SELECT
  split_part(info_json::JSON->>'full_name', ' / ', 1) AS category,
  split_part(info_json::JSON->>'full_name', ' / ', 2) AS subcategory,
  count(*) AS concept_count,
  sum(record_count) AS total_records
FROM source_concepts
GROUP BY 1, 2
ORDER BY total_records DESC;
```

### Find unmapped concepts

```sql
-- Concepts not yet mapped
SELECT sc.*
FROM source_concepts sc
LEFT JOIN existing_mappings em
  ON sc.concept_code = em.sourceConceptCode
  AND sc.terminology = em.sourceVocabularyId
WHERE em.id IS NULL
ORDER BY sc.record_count DESC;
```

### Extract info_json fields for a concept

```sql
SELECT
  concept_name,
  concept_code,
  record_count,
  patient_count,
  info_json::JSON->>'full_name' AS full_name,
  info_json::JSON->>'data_types' AS data_types,
  info_json::JSON->>'measurement_frequency' AS frequency,
  info_json::JSON->'numerical_data'->>'unit' AS unit,
  info_json::JSON->'numerical_data'->>'mean' AS mean_value,
  info_json::JSON->'numerical_data'->>'median' AS median_value,
  info_json::JSON->'numerical_data'->>'min' AS min_value,
  info_json::JSON->'numerical_data'->>'max' AS max_value
FROM source_concepts
WHERE concept_name = 'Frequence_cardiaque';
```

## UUID generation

Use `uuidgen` (macOS built-in) or Python:

```bash
# macOS
uuidgen | tr '[:upper:]' '[:lower:]'

# Python
python3 -c "import uuid; print(uuid.uuid4())"
```

## Writing mappings.json

The file is a JSON array of ConceptMapping objects. To append new mappings:

```bash
# Read existing, append new, write back
python3 -c "
import json, sys

with open('mappings.json', 'r') as f:
    mappings = json.load(f)

new_mappings = json.loads(sys.argv[1])
mappings.extend(new_mappings)

with open('mappings.json', 'w') as f:
    json.dump(mappings, f, indent=2, ensure_ascii=False)

print(f'Added {len(new_mappings)} mappings. Total: {len(mappings)}')
" '<JSON_ARRAY_OF_NEW_MAPPINGS>'
```

For large batches, prefer writing via a Python script to avoid shell escaping issues.

## Domain heuristics from info_json

Use these rules to infer the likely OMOP domain:

1. **Measurement** (most common for ICU data):
   - `data_types` = "numerical"
   - `full_name` contains: Laboratoire, Monitorage, Cardiologie, Respiratoire, Neurologie, Néphrologie
   - Has `numerical_data` with unit

2. **Drug**:
   - `full_name` starts with "Medicaments" or "Prescriptions"
   - `categorical_data` values are drug names or dosages

3. **Procedure**:
   - `full_name` contains: Anesthesie, Soins, Pansements
   - Describes an action performed on the patient

4. **Observation**:
   - `data_types` = "categorical" with Yes/No or coded values
   - Administrative or nursing observations

5. **Condition**:
   - Diagnostic codes (ICD-10, CIM-10)
   - `full_name` references diagnoses

6. **Device**:
   - `full_name` contains: Catheters, Sondes, Drains
   - Describes medical devices

7. **Unmappable / Ignore**:
   - Bed identifiers (A002, A003, ...)
   - Internal system codes
   - Administrative workflow steps
