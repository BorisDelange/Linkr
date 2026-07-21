# TODO — concept-mapping skill (future versions)

Roadmap for the next skill versions. Each item, when shipped, becomes a
`CHANGELOG.md` entry + a `version:` bump. Not scheduled work — a backlog.

Both items below trace back to the future-work section of the UCD→RxNorm study:
Delange et al., *A Hybrid Pipeline for Mapping French UCD Drug Codes to RxNorm
with Dosage Preservation*, MIE 2026 — https://pubmed.ncbi.nlm.nih.gov/42175058/

## 1. EDQM Standard Terms alignment for pharmaceutical forms (drug mapping)

**Why.** In that study, failure analysis showed that **most drug-mapping errors
were pharmaceutical-form misalignments**. The paper's own future-work opening:
*"leveraging RUIM's relationships with international multilingual terminologies
(e.g., EDQM Standard Terms for pharmaceutical forms) could address
pharmaceutical form misalignment more systematically than label-based extraction
alone."* Today `mapping-drug.md` extracts the dose form by regex/keyword on the
source label (Step 1 + Step 3a) — brittle and language-bound.

**What EDQM gives us.**
- EDQM Standard Terms = the European reference for pharmaceutical dose forms,
  routes/methods of administration, units of presentation, and containers, for
  human + veterinary use. ~900+ terms in **35 languages including French** —
  i.e. a *multilingual pivot* for the dose form, independent of the source
  label's language. https://standardterms.edqm.eu/
- Dose form is decomposed into 6 controlled characteristics: Basic Dose Form
  (BDF), State of Matter (SOM), Transformation (TRA), Release Characteristics
  (RCA), Intended Site (ISI), Administration Method (AME) — structured form
  matching instead of a free-text keyword list.
- A published **EDQM ↔ RxNorm dose-form alignment** already exists (UNICOM
  project): "Alignment of two standard terminologies for dosage form: RxNorm …
  and EDQM", PMC9395577 — https://pmc.ncbi.nlm.nih.gov/articles/PMC9395577/ .
  Known obstacle: RxNorm dose forms are **lower-granularity** than EDQM, so the
  mapping is many-EDQM → one-RxNorm in places; validation still required.

**Sketch of the change (not designed yet).**
- Add an optional EDQM dose-form reference to the config/knowledge base
  (see item 2): the EDQM term list + the EDQM↔RxNorm form crosswalk.
- In `mapping-drug.md` Step 1/3a, when the national terminology exposes an EDQM
  form (e.g. French UCD via RUIM), resolve the source dose form *through EDQM*
  first, then map EDQM→RxNorm dose form via the crosswalk, instead of
  regex-guessing from the label. Fall back to label extraction only when no
  EDQM link is available.
- Keep the 3-component validation (ingredient + strength + form) — this only
  makes the *form* leg more reliable and multilingual.

**Open questions to research before coding.**
- Is the EDQM↔RxNorm crosswalk redistributable / what licence? (EDQM Standard
  Terms have usage terms; the OMOP vocabulary bundle may already carry some of
  this.)
- Does the OHDSI vocabulary already encode EDQM dose forms or their RxNorm links
  (so we can query them in DuckDB rather than shipping a separate file)?
- For France specifically: how to pull the RUIM→EDQM relation from
  https://smt.esante.gouv.fr/ (RUIM ≈ 132k concepts, mapped toward IDMP/EDQM).

## 2. Internationalisation — national-terminology & reference-mapping registry

**Why.** The skill's drug procedure is already vocabulary-neutral in its logic
(INN + ATC/RxNorm traversal, no UCD/BDPM/CIP hardcoded). But it has **no
knowledge of the national reference mappings** that dramatically raise coverage
and precision — for France, the UCD→CIP→RxNorm reference chain via RUIM/OHDSI
gave the broadest coverage in the paper (41.5% of codes) and is the natural
first stage before similarity + AI. Other countries have their own
national↔RxNorm reference resources. We should stop treating "France/UCD/BDPM"
as an implicit assumption and instead make the set of known national
terminologies + their reference crosswalks an explicit, extensible resource.

**What to build.** A `references/national-terminologies.md` (or a small
structured `references/national-terminologies.json` the skill reads) that, per
country / terminology, records:
- terminology name + code system (e.g. FR: UCD, CIP, BDPM; and the RUIM hub)
- domain(s) it covers (drug, lab, …)
- available **reference mappings** to OMOP standard vocabularies and how to
  obtain them (URL, terminology server, OHDSI vocab tables, licence)
- the recommended pipeline order for that terminology (reference → similarity →
  AI), mirroring the MIE 2026 three-stage design
- multilingual pivots available (e.g. EDQM for forms — links back to item 1)

Then `mapping-drug.md` (and later `mapping-ai.md`) would consult this registry
at the start of a batch: if the source terminology is known, use its reference
crosswalk as the Strategy-0 / pre-computed proposals before falling back to the
generic ATC/RxNorm traversal.

**Seed entries to write first.**
- **France** — UCD, CIP, BDPM; RUIM hub (https://smt.esante.gouv.fr/, ≈132k
  concepts, mapped toward IDMP/EDQM); UCD→CIP→RxNorm reference chain via OHDSI
  Standardized Vocabularies; EDQM for dose forms. Reference: Duclos et al.,
  *Development of a Standardized Drug Nomenclature in France*,
  Stud Health Technol Inform 2025;327:198–202 (doi:10.3233/SHTI250301).
- Leave clearly-marked stubs for other countries so contributors can extend it
  (the paper frames the pipeline as "readily adapted to other national drug
  terminologies").

**Open questions to research before coding.**
- File format: prose `.md` (easier for the agent to reason over) vs structured
  `.json` (queryable, less ambiguous). Likely `.md` with a small table, given
  how the other references are written.
- Overlap with Linkr's existing config (`config.local.json` already points at a
  vocab dir) — the registry is *knowledge*, not per-install paths, so it belongs
  in the skill, not the project config.
