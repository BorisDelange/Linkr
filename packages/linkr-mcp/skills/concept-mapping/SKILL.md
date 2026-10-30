---
name: concept-mapping
description: >-
  Maps a hospital's local terminology codes to OMOP standard concepts (LOINC,
  SNOMED CT, RxNorm, UCUM…) inside a Linkr concept-mapping project, through the
  Linkr MCP server. Use when the user asks to map, align or suggest OMOP
  concepts for source concepts, to work through a mapping project, or to align
  source codes onto a data dictionary (concept sets). Reads the source concepts
  and their metadata, searches the OMOP vocabulary, and leaves AI suggestions
  (or, on explicit confirmation, mappings) for review in Linkr.
license: AGPL-3.0-or-later
compatibility: >-
  Needs the Linkr MCP server (packages/linkr-mcp) connected with the user's
  Linkr API key. Works with any model and any MCP client that loads Agent Skills.
metadata:
  version: "2.2.0"
  citation: Linkr concept-mapping skill v2.2.0
---

# Concept mapping with Linkr

You map **source concepts** (a hospital's local codes, with their metadata) to
**standard OMOP concepts**, inside a Linkr mapping project. Everything goes
through the Linkr MCP tools: you never handle files, and every write lands in
the app, where a human reviews it.

Versioned for citation: cite **"Linkr concept-mapping skill v&lt;version&gt;"**
with `metadata.version` above. Any change to this folder bumps the version
(SemVer) and adds a dated `CHANGELOG.md` entry in the same change.

## The tools

| Tool | Use |
|---|---|
| `list_mapping_projects` | Find the project (start here). |
| `get_mapping_project` | Progress, vocabulary database, suggestions file, source categories. |
| `list_source_concepts` | A page of source concepts: filter by `status` (unmapped by default), `category`, `search`, `with_suggestions`, `without_ai_suggestions`; sorted by frequency. |
| `get_source_concept` | Source concepts in full — a whole batch at once with `concept_codes`: metadata, existing mappings, precomputed and AI suggestions. |
| `semantic_search_vocabulary` | **Candidate search by meaning** (embeddings): synonyms, paraphrases, brand names, loose translations a word search misses. The whole batch in one call (up to 50 texts); narrow it by domain, vocabulary, concept class. Needs an embedding configuration with an index; see `references/precompute.md`. |
| `search_vocabulary` | Candidate search by words, code or id, standard concepts by default; filters by domain, vocabulary, class; `concept_set_id` for a data dictionary. |
| `get_vocabulary_concept` | Targets in detail — a batch's finalists in one call with `concept_ids`: relationships (`Maps to`…), ancestors, and for a drug its components (each ingredient's strength, the dose form, the brand). One `concept_id` gives the full card (synonyms, descendants). |
| `list_concept_sets` / `get_concept_set` | Data dictionaries of the workspace and their Mapping Notes. |
| `find_sources_for_targets` | The reverse lookup: source concepts that suggestions link to given targets (ids or a concept set). |
| `add_ai_suggestions` | **Default output.** Suggestions shown in the app's Suggestions panel (category AI). |
| `create_mappings` | Mappings (status unchecked). **Only for picks the user confirmed one by one.** |
| `remove_ai_suggestions` | Withdraw your suggestions (all of a model's, or some concepts'), e.g. after a wrong batch. |
| `list_mappings` / `delete_mappings` | The project's mappings with their ids, and deleting some — **only on the user's yes**, e.g. a mapping written by mistake. Mappings someone reviewed or commented are refused unless the user confirms again. |
| `list_suggestion_engines` | The embedding configurations and the state of their index: whether `semantic_search_vocabulary` can run, and over which concepts. |

If these tools are not in your tool list, the server exposes them through its
gateway: call them by name with `run_linkr_read_tool` (the `list_`, `get_`,
`search_` and `find_` ones, `semantic_search_vocabulary` included),
`run_linkr_write_tool` (`add_ai_suggestions`, `create_mappings`) or
`run_linkr_delete_tool` (`remove_ai_suggestions`, `delete_mappings`), e.g.
`run_linkr_read_tool({ tool: "list_source_concepts", arguments: { mapping_project_id: "…" } })`.
`find_linkr_tools({ names: ["list_source_concepts"] })` gives a tool's arguments.

The calls of a batch, with their arguments (every tool takes `mapping_project_id`):

```
list_source_concepts      { mapping_project_id, category, without_ai_suggestions: true, limit: 10 }
get_source_concept        { mapping_project_id, concept_codes: ["d_items/220045", …] }
semantic_search_vocabulary{ mapping_project_id, config: "biolord", texts: ["heart rate", …],
                            domains: ["Measurement"], vocabularies: ["LOINC"], limit: 10 }
get_vocabulary_concept    { mapping_project_id, concept_ids: [3027018, …] }
add_ai_suggestions        { mapping_project_id, suggestions: [{ concept_code: "d_items/220045",
                            concept_id: 3027018, score: 0.9, equivalence: "skos:exactMatch",
                            comment: "…" }, …] }
```

## Step 1 — Find the project and agree on the session

1. `list_mapping_projects`, then `get_mapping_project` on the one the user
   means, and `list_suggestion_engines` (`mapping_project_id`) once: note
   which configuration's index covers which domains, and name it as `config`
   in every semantic search when there are several. Tell them in one sentence where
   it stands, e.g. *"MIMIC-IV Demo: 1786 of 5636 mapped, precomputed
   suggestions from Jaro-Winkler and BioLORD, semantic search available,
   vocabulary ATHENA."*
   If the project has no precomputed suggestions, recommend computing them in
   Linkr before mapping (see the last section) and ask whether to wait or to
   go on with semantic search alone.
2. If the vocabulary database is reported unusable, stop and relay the fix to
   the user (import an ATHENA export in Linkr: Warehouse › Vocabularies › OHDSI vocabularies —
   the vocabularies are shared by every mapping project of the workspace).
   A database project is read from its extraction only: until the user has run
   it (mapping project › Source concepts tab), the source-concept tools refuse
   with "not been extracted yet". Relay that and stop. An extraction can be
   paused, and what it has extracted so far is readable at once; one run with
   metadata off has no counts or metadata — suggest a run with metadata when it
   would decide between targets.
3. Ask, once per session, and keep the answers — skip what the user's request
   already settles:
   - **Output** — *suggestions* (default: `add_ai_suggestions`, a reviewer
     accepts or rejects them in Linkr) or *mappings* (`create_mappings`, every
     concept confirmed by the user before it is written).
   - **Scope** — which concepts: a category, the most frequent unmapped ones, a
     name pattern, specific codes, or those with precomputed suggestions
     (`with_suggestions`). `get_mapping_project` gives each category's unmapped
     count; show the count and a few examples before starting, and say so when
     the scope holds fewer concepts than asked, or when its concepts have no
     records (dictionary entries never used in the data: worth knowing before
     spending effort on them).
   - **Candidates per concept** (suggestions only, default 3) and whether they
     want to see each batch before it is written (default: no — the review
     happens in Linkr).
   - **Data dictionary** — if they mention concept sets or a dictionary, read
     `references/data-dictionary.md` now.

Your suggestions are signed `ai/<model>`. When `get_mapping_project` says your
client sets the model, leave `model` out of `add_ai_suggestions`. Otherwise
give your exact model identifier — and if nothing in this conversation states
it, ask the user: never guess it from what you believe you are.

## Step 2 — Map, batch by batch

Batches of about 10 concepts. In suggestions mode, list them with
`without_ai_suggestions: true`: writing suggestions does not change a
concept's status, so the plain unmapped list would give the same batch again
(and leaves the concepts another assistant took). Concepts are listed as `vocabulary/code`
(`d_labitems/50812`); tools take that token, or the code alone as
`concept_code` with `vocabulary_id` beside it. If the user has a scores
computation running for the project, its candidates show only once it ends:
ask whether to wait for it (`get_job_status` with `wait_seconds: 50`, repeated
until it ends) or to go on without them.

1. Read the whole batch with **one** `get_source_concept` call
   (`concept_codes`), once — read each name **and its metadata**: unit, value
   range and percentiles, categorical values, category path, hospital units.
   The metadata is what separates near-identical targets.
   If the name and the metadata say nothing you can interpret — a single
   letter, an anonymised placeholder (`STX3`, `UTX7`), a tube or billing flag
   — stop there: do not search the vocabulary for it, list it in the summary
   as not interpretable.
2. Decide the domain, then follow the procedure for it:
   - Measurement, Condition, Procedure, Observation → `references/clinical.md`
   - Drug → `references/drugs.md`
3. Find candidates, **starting from the precomputed suggestions**
   `get_source_concept` showed: the user computed them over the whole
   vocabulary, by several methods, and most right targets are among them —
   read them first and keep the ones the metadata supports (a syntactic hit
   outside the expected domain or vocabulary is noise: an abbreviation like
   `INR` also matches a place). Then `semantic_search_vocabulary` for the
   concepts they leave open, the whole batch in one call (English texts,
   scope narrowed to the domain), then `search_vocabulary` for what is still
   missing. Check the finalists that need it — a drug's strength and
   form, a lab test's specimen when the name does not say it; not an
   Ingredient picked for a molecule-only label — in **one**
   `get_vocabulary_concept` call (`concept_ids`), and judge them with
   `references/omop-reference.md` (equivalence, comment rules, domain hints).

Then write the batch:

- **Suggestions** — one `add_ai_suggestions` call for the batch: up to the
  agreed number of candidates per concept, best first, each with its score,
  equivalence and comment. Write only candidates you would defend to the
  reviewer: one good candidate beats three padded ones, and a target you
  would advise against (a wrong specimen, the opposite of the source) is never
  written, not even "for contrast" — say it in the comment of the right one
  instead. When you write fewer candidates than asked, say why in the
  summary (a molecule-only drug label has one right target). Show the batch
  as a compact table (source → target, equivalence, score, comment).
- **Mappings** — present each concept (source, metadata highlights, 1–3
  candidates with reasoning) and wait for the user's choice. Write only what
  they accepted, with `create_mappings`. A concept not to be mapped (bed
  number, internal code) can be written as `status: "ignored"` with a reason.

The tools refuse a batch with an unknown source code, an unknown, invalid or
non-standard target, a missing comment, or an equivalence outside the SKOS set.
Nothing is written in that case: fix the items listed and send the batch again.
Existing suggestions and mappings are never overwritten. If a batch you wrote
turns out wrong, withdraw it with `remove_ai_suggestions` and write it again;
a wrong mapping is deleted with `delete_mappings` (ids from `list_mappings`)
once the user agrees, then written again.

## Step 3 — After each batch

Summarise: what was written (count, equivalences), what was left out and why,
how many remain (the `list_source_concepts` total — with
`without_ai_suggestions` in suggestions mode). Ask whether to continue, change
scope, or switch domain.

## Rules that always hold

- **Never invent a concept id.** Every target comes from `search_vocabulary`,
  `get_vocabulary_concept`, a suggestion or a concept set.
- **Standard, valid targets only.** A non-standard hit leads to its `Maps to`
  target. Search results say `standard`, and mark an invalid concept
  `INVALID`: an unmarked one is valid.
- **Be strict on equivalence** (SKOS; table and examples in
  `references/omop-reference.md`):
  - `skos:exactMatch` — same meaning, nothing lost;
  - `skos:closeMatch` — same thing, a qualifier lost or different (specimen,
    method, site, timing): the default when in doubt;
  - `skos:broadMatch` — the target is more general than the source;
  - `skos:narrowMatch` — the target is more specific than the source;
  - `skos:relatedMatch` — related from another angle (a device setting → the
    measured value).
- **Every candidate carries a comment** — the one or two sentences the
  reviewer reads in Linkr to accept or reject it without redoing your work:
  why this target, and for anything but exactMatch, what is lost or differs.
  Write it in the language you speak with the user, in full sentences, with no
  unexplained abbreviation (rules and bad → good examples:
  `references/omop-reference.md` › The comment). In French, e.g. *« Même
  analyte et même unité (mg/dL) ; la source ne précise pas le spécimen, la
  cible le fixe au sérum ou plasma. »*
- **Mappings need the user's explicit yes**, concept by concept. Without it,
  write suggestions.

## Precomputed suggestions and semantic search

Work from the precomputed suggestions whenever the project has them: they
make you faster and more accurate. When it has none, say so at Step 1 and
recommend computing them before mapping (in suggestions mode, a scope with
precomputed suggestions — `with_suggestions` — is the natural place to start).
The user computes them in Linkr — syntactic scores
(Jaro-Winkler, token sort, n-gram IDF) and semantic scores (embeddings, e.g.
BioLORD-2023-M) — and builds the indexes semantic search reads. **You never
start a computation or an index build**: they run for hours, and the user
chooses their scope. Your part is the AI suggestions, from what they give you.
When the project has no precomputed suggestions or no index, say so and where
the user starts them (mapping editor › Suggestions panel › Manage suggestions ›
Compute), then go on with what is there. Read `references/precompute.md` for
semantic search.
