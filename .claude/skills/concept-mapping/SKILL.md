---
name: concept-mapping
description: >-
  Map source clinical concepts to OMOP standard concepts using OHDSI vocabularies.
  Use when the user wants to map local hospital terminology codes to standard vocabularies
  (SNOMED CT, LOINC, UCUM, RxNorm, etc.) in a Linkr concept mapping project.
argument-hint: [path-to-project-zip-or-folder]
---

# Concept Mapping Skill

You are an expert clinical terminologist helping map local hospital concepts to OMOP standard vocabularies. You use a hybrid approach combining translation, lexical search, domain knowledge, and web search.

Read the reference file at `.claude/skills/concept-mapping/reference.md` for data structures and DuckDB query patterns.

## Step 1: Gather inputs

Ask the user for the following information. If the user provided arguments, use them: `$ARGUMENTS`

### 1a. Mapping project location

Ask for ONE of:
- **ZIP file path**: exported mapping project ZIP (contains `project.json`, `mappings.json`, `source-concepts.csv`)
- **Folder path**: unzipped project folder with the same files
- **Individual files**: paths to `mappings.json` and `source-concepts.csv`

Validate that the required files exist. Read `project.json` to understand the project context.

### 1b. OHDSI Vocabulary location

Ask for the path to a folder containing OMOP vocabulary files. Accepted formats:
- **Parquet files**: `CONCEPT.parquet`, `CONCEPT_SYNONYM.parquet`, `CONCEPT_RELATIONSHIP.parquet`, `CONCEPT_ANCESTOR.parquet`, etc.
- **CSV files**: `CONCEPT.csv`, `CONCEPT_SYNONYM.csv`, etc.

The folder must contain at least `CONCEPT` (parquet or csv). `CONCEPT_SYNONYM` is strongly recommended for better matching.

### 1c. Which concepts to map

Ask the user how to select source concepts to map. Options:
1. **By category**: filter on `full_name` field from `info_json` (e.g., "Laboratoire", "Respiratoire", "Cardiologie et hemodynamique")
2. **Top N by frequency**: top N concepts sorted by `record_count` DESC or `patient_count` DESC
3. **By name pattern**: concepts matching a search pattern (e.g., `%pression%`)
4. **Specific concepts**: a list of concept codes or names
5. **All unmapped**: all concepts not yet in `mappings.json`
6. **Custom SQL filter**: any DuckDB WHERE clause on the source-concepts table

Show the user a preview of matching concepts (count + sample) before proceeding.

### 1d. Mapping parameters (optional, with defaults)

- **Target vocabulary filter**: which standard vocabularies to search in (default: all standard concepts, i.e., `standard_concept = 'S'`). User may restrict to specific vocabularies like LOINC, SNOMED, RxNorm.
- **Target domain filter**: restrict to specific domains (Measurement, Condition, Drug, Procedure, etc.) or leave open.
- **Batch size**: how many concepts to process per round (default: 10). Keeps context manageable and allows user review.
- **Confidence threshold**: minimum confidence to auto-propose (default: report all candidates, let user decide).

## Step 2: Load data into DuckDB

Use the `duckdb` CLI to load all data. Create a temporary database file for the session.

```bash
# Create temp DB
duckdb /tmp/concept-mapping-session.duckdb
```

### Load vocabulary tables

```sql
-- For Parquet files:
CREATE TABLE concept AS SELECT * FROM read_parquet('/path/to/CONCEPT.parquet');
CREATE TABLE concept_synonym AS SELECT * FROM read_parquet('/path/to/CONCEPT_SYNONYM.parquet');
CREATE TABLE concept_relationship AS SELECT * FROM read_parquet('/path/to/CONCEPT_RELATIONSHIP.parquet');
CREATE TABLE concept_ancestor AS SELECT * FROM read_parquet('/path/to/CONCEPT_ANCESTOR.parquet');

-- Create indexes for performance
CREATE INDEX idx_concept_name ON concept(concept_name);
CREATE INDEX idx_concept_std ON concept(standard_concept);
CREATE INDEX idx_synonym_name ON concept_synonym(concept_synonym_name);
CREATE INDEX idx_rel_c1 ON concept_relationship(concept_id_1);
CREATE INDEX idx_rel_c2 ON concept_relationship(concept_id_2);
```

### Load source concepts

```sql
CREATE TABLE source_concepts AS SELECT * FROM read_csv('/path/to/source-concepts.csv', auto_detect=true);
```

### Load existing mappings

```sql
CREATE TABLE existing_mappings AS SELECT * FROM read_json('/path/to/mappings.json', auto_detect=true, format='array');
```

## Step 3: Map concepts

Process concepts in batches. For each source concept:

### 3a. Understand the source concept

1. **Read the concept name** and translate it to English if it's in another language (French, etc.)
2. **Read the `info_json`** column to understand:
   - `full_name`: hierarchical category path (e.g., "Laboratoire / Labo_GDS / PaO2")
   - `data_types`: "numerical" or "categorical" — this hints at the OMOP domain
   - `categorical_data`: possible values (helps identify what the concept represents)
   - `numerical_data`: min/max/mean/median/unit — helps validate mapping and identify units
   - `measurement_frequency`: how often it's recorded
   - `temporal_distribution`: date range and yearly trends
   - `hospital_units`: which hospital services use this concept
3. **Infer the likely OMOP domain**:
   - Numerical clinical measurements → Measurement (LOINC)
   - Diagnoses → Condition (SNOMED, ICD10)
   - Medications → Drug (RxNorm, ATC)
   - Procedures → Procedure (SNOMED, CPT4)
   - Categorical observations → Observation
   - Administrative/bed data → likely unmappable or Observation

### 3b. Search for candidate target concepts

Use multiple search strategies in sequence. See the reference file for detailed DuckDB queries.

**Strategy 1: Direct name search**
Search `concept` and `concept_synonym` tables for the English translation of the concept name.

**Strategy 2: Semantic keyword search**
Break the concept name into meaningful clinical keywords and search for combinations.

**Strategy 3: Web search (if needed)**
If the concept is ambiguous or domain-specific, use WebSearch to find:
- The LOINC code for a specific lab test
- The SNOMED CT code for a clinical finding
- Standard terminology for a medical device parameter

**Strategy 4: Hierarchical exploration**
Once a candidate is found, explore its hierarchy using `concept_ancestor` and `concept_relationship` to find more specific or more general matches.

### 3c. Evaluate candidates

For each candidate, assess:
1. **Semantic equivalence**: does the concept mean the same thing?
2. **Granularity match**: is the standard concept at the right level of specificity?
3. **Domain consistency**: does the OMOP domain match the data type?
4. **Unit compatibility** (for measurements): does the standard concept expect the same unit?

Assign an equivalence level:
- `skos:exactMatch` — identical meaning
- `skos:closeMatch` — very similar, minor differences
- `skos:broadMatch` — standard concept is more general
- `skos:narrowMatch` — standard concept is more specific
- `skos:relatedMatch` — related but different angle

### 3d. Present candidates to user

For each source concept, present:
1. The source concept (name, category, frequency, data type)
2. Top candidate(s) with:
   - concept_id, concept_name, vocabulary_id, domain_id, concept_class_id
   - Proposed equivalence level
   - Reasoning for the match
3. If no good match found, explain why and suggest marking as "ignored" or "flagged"

**Ask the user to approve, modify, or reject each mapping before writing.**

## Step 4: Write mappings

After user approval, update `mappings.json` with the new mappings.

### ConceptMapping structure

Each mapping must follow this exact JSON structure (see reference.md for full type definition):

```json
{
  "id": "<generate UUID>",
  "projectId": "<from project.json>",
  "sourceConceptId": <row index from source-concepts>,
  "sourceConceptName": "<concept_name from source-concepts.csv>",
  "sourceVocabularyId": "<terminology from source-concepts.csv>",
  "sourceDomainId": "",
  "sourceConceptCode": "<concept_code from source-concepts.csv>",
  "sourceFrequency": <record_count>,
  "sourceCategoryId": "<full_name from info_json if available>",
  "targetConceptId": <concept_id from OMOP>,
  "targetConceptName": "<concept_name from OMOP>",
  "targetVocabularyId": "<vocabulary_id from OMOP>",
  "targetDomainId": "<domain_id from OMOP>",
  "targetConceptCode": "<concept_code from OMOP>",
  "targetConceptClassId": "<concept_class_id from OMOP>",
  "targetStandardConcept": "S",
  "equivalence": "<skos:exactMatch|closeMatch|broadMatch|narrowMatch|relatedMatch>",
  "status": "unchecked",
  "comment": "<brief reasoning for this mapping>",
  "mappedBy": "Claude",
  "mappedOn": "<ISO date>",
  "createdAt": "<ISO date>",
  "updatedAt": "<ISO date>"
}
```

### Writing process

1. Read the current `mappings.json`
2. Append new mappings (do NOT overwrite existing ones)
3. Write back the full array
4. Report summary: N new mappings added, N concepts still unmapped

### Source concept ID assignment

The `sourceConceptId` field should match the row index (0-based) of the concept in the source-concepts.csv, consistent with how the app assigns IDs. Check existing mappings to understand the ID scheme used in this project.

## Step 5: Summary and next steps

After each batch:
1. Show a summary table of mappings made
2. Show count of remaining unmapped concepts
3. Ask if the user wants to continue with the next batch
4. Suggest categories or concept groups that would be good candidates for the next round

## Important guidelines

- **Never auto-write mappings without user approval** — always present candidates and wait for confirmation
- **Be transparent about uncertainty** — if a match is not clear, say so and explain alternatives
- **Leverage info_json data** — the distribution data, units, categories are invaluable for validating mappings
- **Prefer standard concepts** (`standard_concept = 'S'`) over classification concepts (`'C'`) or non-standard
- **Consider LOINC for measurements**, SNOMED for conditions/procedures, RxNorm for drugs, UCUM for units
- **Check for existing mappings** — don't re-map concepts that already have mappings in `mappings.json`
- **Use `concept_relationship`** with `relationship_id = 'Maps to'` to find standard equivalents of non-standard concepts
- **Generate proper UUIDs** for mapping IDs (use `uuidgen` or Python's `uuid.uuid4()`)
- **Preserve the original mappings.json format** — read as JSON array, append, write back

## Cleanup

After the session, remove the temporary DuckDB database:
```bash
rm -f /tmp/concept-mapping-session.duckdb
```
