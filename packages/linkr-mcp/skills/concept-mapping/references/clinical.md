# Clinical concepts — measurements, conditions, procedures, observations

Follow this for every non-drug source concept. For drugs, read `drugs.md`.
Equivalence levels, comment rules and domain hints are in `omop-reference.md`.

## 1. Understand the source concept

From `get_source_concept`:

1. **Name** — translate to English if it is French, local or abbreviated
   (`FC` → heart rate, `PAS` → systolic arterial pressure, `GDS` → blood gas).
2. **Metadata** (`info_json`):
   - category path (`full_name`, `category`): the clinical area — laboratory,
     monitoring, respiratory…
   - `data_types`: numeric → usually Measurement; categorical → Observation,
     Condition, or a measurement with coded answers.
   - `unit` and the value distribution (`numeric_data`: min, percentiles,
     median, max): they validate a target and split near-identical ones
     (mg/dL vs mmol/L, arterial vs venous ranges).
   - `categorical_data`: the values reveal what the concept really is
     (Oui/Non → a yes/no observation; drug names → a drug exposure).
   - `hospital_units`, `measurement_frequency`: context (ICU monitoring every
     hour vs a daily lab).
3. **Domain** — infer it (see *Domain hints* in `omop-reference.md`).
4. **Existing mappings** — if the concept is already mapped, skip it unless the
   user asked to review it.

## 2. Find candidates

Stop when you have about three strong candidates.

1. **Suggestions** — `get_source_concept` lists precomputed scores
   (`semantic/biolord`, `syntactic/jaro-winkler`) and earlier AI suggestions,
   with target names. A biolord score above 0.85 in the right domain is a strong
   lead: verify it, never accept it on the score alone.
2. **Name search** — `search_vocabulary` with the English name, filtered by the
   domain you inferred (`domains: ["Measurement"]`) and, when you know it, the
   vocabulary (`LOINC` for labs and vital signs, `SNOMED` for findings and
   procedures). Synonym hits come back too.
3. **Keyword decomposition** — for compound names, search the clinical
   keywords separately and in combination (`systolic arterial pressure` →
   `systolic blood pressure`, then `arterial pressure systolic`).
4. **Web search**, if your client has one — for a lab test with a known LOINC,
   a clinical score (SOFA, GCS, APACHE), or an ambiguous abbreviation.
5. **Hierarchy** — `get_vocabulary_concept` on a candidate: ancestors for a
   more general concept, descendants for a more specific one, `Maps to` from a
   non-standard concept to its standard target.

## 3. Choose

Judge every candidate on:

1. **Meaning** — the same clinical idea?
2. **Granularity** — as specific as the source allows, no more.
3. **Domain** — consistent with the data type.
4. **Unit** — for a measurement, the LOINC property matches the source unit
   (mass/volume for g/L, substance/volume for mmol/L, rate for /min).
5. **Status** — standard (`S`) and valid; a non-standard hit leads to its
   `Maps to` target.

Give each kept candidate an equivalence and a score (your confidence, 0–1):
0.85+ for a verified exact match, 0.6–0.8 for a close match with a stated
difference, lower for alternatives. Write the comment per `omop-reference.md`.

## 4. Edge cases

- **No good target** (too specific, administrative, no OMOP equivalent): write
  nothing, and list it in the batch summary with the reason. In mappings mode,
  offer `status: "ignored"` (bed identifiers, internal codes) or `"flagged"`.
- **Two equally good targets**: suggest both with close scores; in mappings
  mode, ask the user.
- **A value coded as its own concept** ("Assist/Control", "Intubated"): see
  *A variable, or one of its values?* in `omop-reference.md`.
- **A code whose meaning cannot be recovered** (single letters, anonymised
  placeholders, specimen-tube or billing flags): do not search for it; report
  it as not interpretable.
- **A drug in a clinical batch**: set it aside for `drugs.md`.

## 5. Presenting

Suggestions mode — one table per batch, after writing it:

```
| Source | Target | Equivalence | Score | Comment |
|---|---|---|---|---|
| REA/hr Fréquence cardiaque | 3027018 Heart rate [LOINC 8867-4] | exactMatch | 0.95 | … |
```

Mappings mode — one concept at a time, then wait:

```
Source: <name> [<vocabulary>/<code>] — <category>
  <type> · unit <unit> · range <p5–p95> · <records> records

1 (recommended) <concept_id> <name> [<vocabulary> <code>] — <domain>, <class>
  <equivalence> — <reasoning>
2 <alternative>

→ 1 / 2 / another concept id / flag / ignore / skip
```
