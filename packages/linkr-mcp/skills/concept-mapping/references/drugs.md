# Drugs — RxNorm / RxNorm Extension

Follow this for Drug-domain source concepts (medications, prescriptions). It
replaces `clinical.md` for them. Equivalence levels and comment rules are in
`omop-reference.md`.

## Why drugs are different

"Paracetamol 500 MG Oral Tablet" and "Paracetamol 1000 MG Oral Tablet" look
almost identical to any name similarity, yet they are different drugs. Keep two
things apart:

- **Finding candidates** — which drugs *resemble* the source. Semantic search
  and precomputed scores are good at this: they find the right **ingredient**,
  even from brand names and other languages. They are **blind to strength**.
- **Deciding** — which candidate has the *same* ingredient, strength and form.
  That is what the parsed label and the candidate's components are for.

Scores propose, the components decide. A score never settles a strength: a
two-fold dose difference scores almost the same and is a clinical error.

Evidence (French UCD codes, 287 expert-validated, MIE 2026): BioLORD scores put
the right ingredient in the top 10 for 73.6 % of codes; a plain name search on
the French label reached about 50 %, and 9.7 % on the half of codes that are
brand names or abbreviations. Search by meaning first; word search is the
fallback.

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
| Ingredient | ingredient | the molecule alone (exactMatch, below); otherwise last resort → `skos:broadMatch` |

Vocabulary `RxNorm` or `RxNorm Extension` (international products absent from
US RxNorm), always standard and valid. With a brand name, default to the branded
level; fall back to the Clinical Drug family only when no branded concept fits.
A brand in parentheses after a generic name — `Lorazepam (Ativan)`,
`Drotrecogin (Xigris)`, an order-set item, not a product — is a synonym, even
for a drug sold under one brand only: stay at the generic level and name the
brand in the comment. The branded level is for a source that names the
product (`AUGMENTIN 1 g/125 mg`).

**A label that names only the molecule** (`Epinephrine`, `Amiodarone`: an ICU
administration item, no strength or form) maps to the **Ingredient**, as
`skos:exactMatch` — the source holds nothing more, so nothing is lost. A
Clinical Drug Form adds a form the source does not state: suggest it only when
the metadata shows the form (an infusion rate in mcg/kg/min, a route), as
`skos:narrowMatch`. RxNorm often has two near-identical forms (`Injection`,
`Injectable Solution`): without the source stating which, do not choose. A
combination named alone (`Ampicillin/Sulbactam`) has no single Ingredient:
suggest the combination's Clinical Drug Form as `skos:narrowMatch`, saying
which form it adds.
Packs, boxes (`Clinical Drug Box`, `Branded Drug Box`, `Quant … Box`) and
`Marketed Product` (a box by a manufacturer) only when the source names them.

## 1. Parse the label

Once per concept, from its name and metadata:

| Component | Example |
|---|---|
| Ingredient(s) | paracetamol; amoxicillin + clavulanate → translate to the English INN (paracetamol → acetaminophen, salbutamol → albuterol, aciclovir → acyclovir) |
| Strength | 500 MG, 2 MG/ML, 4 G/500 MG — normalise decimal separator and unit |
| Dose form | Oral Tablet, Injectable Solution |
| Brand | LOXEN, FORXIGA, AUGMENTIN — decides branded vs clinical level |

## 2. Candidates

Carry every plausible ingredient forward: the lists usually span several
strengths and forms of the right one, and step 4 picks.

1. **Suggestions** — `get_source_concept` lists the precomputed candidates
   with names: semantic first, Jaro-Winkler as a tie-breaker.
2. **Semantic search** — `semantic_search_vocabulary`, one call per level the
   batch needs, scope `domains: ["Drug"]`,
   `vocabularies: ["RxNorm", "RxNorm Extension"]` and `concept_classes`:
   - the **ingredients** of the whole batch: the bare INNs in English
     (`lorazepam`, `amoxicillin clavulanate`), `concept_classes: ["Ingredient"]`.
     A text carrying a strength or a form ranks products first and pushes the
     ingredient out of the list;
   - the **products**, for the concepts that give a strength or a form: RxNorm's
     wording (`acetaminophen 500 MG Oral Tablet`; a brand in brackets,
     `dapagliflozin 10 MG Oral Tablet [Forxiga]`),
     `concept_classes: ["Clinical Drug", "Quant Clinical Drug"]` or the branded
     ones.

   A brand name alone (`Tylenol`) does not find its ingredient: search it
   among the branded classes, then read the ingredient from the product's
   components.

## 3. Fallback: word search

When neither gives the ingredient, or no candidate survives step 4:

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

`get_vocabulary_concept` on a drug starts with its **components**: each
ingredient with its strength from OMOP's `drug_strength` (an amount, `500 mg`,
or a concentration, `10000 [U]/5 mL = 2000 [U]/mL`), the dose form and the
brand. Compare the parsed source with these values, never with the concept's
name: names abbreviate (`UNT`, `MG`) and round, the components do not.

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
- the source gives a strength or form, no product fits, but the ingredient is
  unambiguous → the Ingredient, `skos:broadMatch`;
- the source names only the molecule → the Ingredient, `skos:exactMatch`.

Scores: 0.95 for ingredient + strength + form, 0.9 for a molecule-only label
on its Ingredient, 0.75 for ingredient + form, 0.5 for an Ingredient that loses
the source's strength or form.

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
