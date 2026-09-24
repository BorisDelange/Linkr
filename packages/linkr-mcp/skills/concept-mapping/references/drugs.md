# Drugs — RxNorm / RxNorm Extension

Follow this for Drug-domain source concepts (medications, prescriptions). It
replaces `clinical.md` for them. Equivalence levels and comment rules are in
`omop-reference.md`.

## Why drugs are different

"Paracetamol 500 MG Oral Tablet" and "Paracetamol 1000 MG Oral Tablet" look
almost identical to any name similarity, yet they are different drugs. Keep two
things apart:

- **Finding candidates** — which drugs *resemble* the source. Precomputed
  scores are good at this: they find the right **ingredient**, even from brand
  names and other languages. They are **blind to strength**.
- **Deciding** — which candidate has the *same* ingredient, strength and form.
  That is what the parsed label is for.

Scores propose, the components decide. A score never settles a strength: a
two-fold dose difference scores almost the same and is a clinical error.

Evidence (French UCD codes, 287 expert-validated, MIE 2026): BioLORD scores put
the right ingredient in the top 10 for 73.6 % of codes; a plain name search on
the French label reached about 50 %, and 9.7 % on the half of codes that are
brand names or abbreviations. Use suggestions first; searching is the fallback.

## Target the most granular standard concept

Map to the most specific standard concept the source supports:

| Concept class | Carries | When the source gives… |
|---|---|---|
| Branded Drug Box | brand + strength + form + pack | a brand and a pack/box |
| Quant Branded Drug | brand + quantified strength + form | a brand and a volume (5 MG/ML in 10 ML) |
| Branded Drug | brand + strength + form | a brand, strength and form |
| Quant Clinical Drug | ingredient + quantified strength + form | a volume, no brand |
| Clinical Drug | ingredient + strength + form | generic name, strength and form |
| Clinical Drug Form | ingredient + form | no readable strength |
| Ingredient | ingredient | last resort → `skos:broadMatch` |

Vocabulary `RxNorm` or `RxNorm Extension` (international products absent from
US RxNorm), always standard and valid. With a brand name, default to the branded
level; fall back to the Clinical Drug family only when no branded concept fits.

## 1. Parse the label

Once per concept, from its name and metadata:

| Component | Example |
|---|---|
| Ingredient(s) | paracetamol; amoxicillin + clavulanate → translate to the English INN (paracetamol → acetaminophen, salbutamol → albuterol, aciclovir → acyclovir) |
| Strength | 500 MG, 2 MG/ML, 4 G/500 MG — normalise decimal separator and unit |
| Dose form | Oral Tablet, Injectable Solution |
| Brand | LOXEN, FORXIGA, AUGMENTIN — decides branded vs clinical level |

## 2. Candidates from suggestions

`get_source_concept` lists precomputed candidates with names: biolord first,
Jaro-Winkler as a tie-breaker. Carry every plausible ingredient forward — the
list usually spans several strengths and forms of the right one; step 4 picks.

## 3. Fallback: search

Only when there are no suggestions, or none survives step 4:

- **Ingredient** — `search_vocabulary` with the INN,
  `concept_classes: ["Ingredient"]`, `vocabularies: ["RxNorm", "RxNorm Extension"]`.
  A brand name missing from RxNorm often resolves through a synonym (same call,
  no class filter), or through the web if your client has search.
- **Products** — `search_vocabulary` with RxNorm's own wording
  (`acetaminophen 500 MG Oral Tablet`), `concept_classes` set to the level you
  target (`["Clinical Drug", "Quant Clinical Drug"]` or the branded ones).
- **Around a concept** — `get_vocabulary_concept` for its `Maps to`, its
  ancestors (the ingredient) and its descendants (products).

## 4. Validate and pick

| Component | Must |
|---|---|
| Ingredient | Be the same INN — all of them, for a combination. |
| Strength | Be equal or mathematically equivalent (500 MG = 0.5 G; 2 MG/ML = 200 MG/100 ML). Never approximate. |
| Form | Be the same form; only wording variants of it count ("oral tablet" ≈ "tablet"). |

Equivalence:

- ingredient, strength and form match → `skos:exactMatch`;
- same ingredient and strength, related but different form (orodispersible vs
  plain tablet) → `skos:closeMatch`, naming the difference;
- no strength in the source, ingredient and form match a Clinical Drug Form →
  `skos:narrowMatch` or `skos:broadMatch` as the direction dictates;
- no product fits but the ingredient is unambiguous → the Ingredient,
  `skos:broadMatch`.

Scores: 0.95 for ingredient + strength + form, 0.75 for ingredient + form, 0.5
for ingredient only.

## Stop — do not map

- **The strength differs** and is not equivalent. Never pick the nearest dose.
- Homeopathic or diluted products with no clear INN (mark ignored with a reason
  in mappings mode).
- A drug class, not a drug ("beta-blockers").
- A combination with an ingredient you cannot resolve.

A combination maps to the combination product; list its ingredients in the
comment.

## Presenting

For each drug, show the parsed components against the chosen target:

```
Source: <name> [<vocabulary>/<code>] — parsed: <INN> · <strength> · <form> · brand <brand|—>
  → <concept_id> <name> [<vocabulary>, <class>]
    ingredient ✓ · strength ✓ 500 MG · form ✓ Oral Tablet · biolord 0.91
    <equivalence> — <comment>
```
