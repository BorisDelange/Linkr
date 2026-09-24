# Reference — equivalence, comments, metadata, domains

A lookup shared by `clinical.md`, `drugs.md` and `data-dictionary.md`.

## Equivalence (SKOS, as SSSOM uses it)

| Value | Meaning | Example |
|---|---|---|
| `skos:exactMatch` | Same meaning, nothing lost. | "Heart rate" → LOINC 8867-4 Heart rate |
| `skos:closeMatch` | Same thing, a qualifier lost or different (method, device, specimen, site, timing). | point-of-care glucose → glucose in blood |
| `skos:broadMatch` | The target is more general. | "arterial lactate" → Lactate in blood |
| `skos:narrowMatch` | The target is more specific. | "lactate" (no specimen) → Lactate in arterial blood |
| `skos:relatedMatch` | Related, from another angle. | a device setting → the measured value |

**Default to `closeMatch`, not `exactMatch`.** Use exactMatch only when the two
are fully equivalent.

## The comment

The comment is what a reviewer reads to accept or reject your pick without
redoing your work.

- **In the user's language** (French if you speak French with them). One
  language per comment.
- **One or two full sentences.** No telegraphic notes.
- **No unexplained abbreviation**: write "the Serum or Plasma variant", "per the
  concept set's Mapping Notes", "the observed distribution is consistent" — not
  `S/P`, `per note`, `dist. ok`.
- **Cite only what decided**, and concretely:
  - unit — *"unit g/L matches the target's mass/volume property"*, not *"unit ok"*;
  - distribution — *"observed 25–50 g/L is consistent with serum albumin"*;
  - specimen, method, site, timing — *"the source is an arterial blood gas, so
    the arterial LOINC was chosen over the venous one"*.
- **For any inexact match, say precisely what is lost or differs** — mandatory:
  - broadMatch — *"the target is more general: it does not record the arterial
    site of the source"*;
  - narrowMatch — *"the target is more specific than the source, which does not
    state the specimen"*;
  - closeMatch — *"same measurement; the source's point-of-care method is not
    reflected in the target"*.
- **For a dictionary target chosen per its Mapping Notes**, say so in words:
  *"chosen as the concept set's default target per its Mapping Notes"*.

Bad → good:
- `Serum albumin g/L ; default S/P per note` → *"Serum albumin; the Serum or
  Plasma variant is the concept set's default target per its Mapping Notes;
  unit g/L matches."*
- `broad, unit ok` → *"broadMatch: the target is generic heart rate and does not
  capture the source's pulse-oximetry method; unit (beats/min) matches."*

## Reading the metadata (`info_json`)

What Linkr's extraction writes (older files may use `numerical_data` with the
unit inside it):

| Field | Tells you |
|---|---|
| `full_name` | The label or category path (`Laboratoire / GDS / PaO2`). |
| `data_types` | `numeric` or `categorical`. |
| `unit` | The most frequent unit. Compare with the LOINC property. |
| `numeric_data` | min, p5, p25, median, mean, p75, p95, max, sd — does the range fit the target? PaO2 about 60–500 mmHg, heart rate 30–250 /min. |
| `categorical_data` | Values with counts: yes/no → an observation; drug names → a drug exposure; codes → maybe a measurement with coded answers. |
| `measurement_frequency` | Hourly → continuous monitoring; daily → a lab; rare → administrative. |
| `hospital_units` | The wards: context for ambiguous labels. |
| `missing_rate`, `records_per_patient`, `temporal_distribution` | Data quality and usage; rarely decide a target. |

A value distribution that does not fit the target (wrong order of magnitude,
another unit) is a strong sign the mapping is wrong, even with a high name
score.

## Domain hints

1. **Measurement** (most ICU data) — numeric with a unit; laboratory,
   monitoring, cardiology, respiratory, neurology, nephrology categories.
2. **Drug** — medication or prescription categories; values that are drug names
   or doses.
3. **Procedure** — an action on the patient: anaesthesia, care, dressings.
4. **Observation** — categorical yes/no or coded values; nursing and
   administrative observations.
5. **Condition** — diagnoses (ICD-10 / CIM-10 codes).
6. **Device** — catheters, probes, drains.
7. **Not to map** — bed identifiers, internal system codes, workflow steps.

## Suggestion methods

| Method | Source |
|---|---|
| `syntactic/jaro-winkler`, `syntactic/token-sort`, `syntactic/ngram-idf` | Name similarity (precomputed). |
| `semantic/biolord` | Embedding similarity (precomputed). |
| `ai/<model>` | An agent's suggestion, with equivalence and comment — yours are written this way. |
