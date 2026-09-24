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
license: GPL-3.0
compatibility: >-
  Needs the Linkr MCP server (packages/linkr-mcp) connected with the user's
  Linkr API key. Works with any model and any MCP client that loads Agent Skills.
metadata:
  version: "2.1.0"
  citation: Linkr concept-mapping skill v2.1.0
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
| `list_source_concepts` | A page of source concepts: filter by `status` (unmapped by default), `category`, `search`, `with_suggestions`; sorted by frequency. |
| `get_source_concept` | One source concept in full: metadata, existing mappings, precomputed and AI suggestions. |
| `search_vocabulary` | Target search (English terms, code or id), standard concepts by default; filters by domain, vocabulary, class; `concept_set_id` for a data dictionary. |
| `get_vocabulary_concept` | A target's relationships (`Maps to`…), synonyms, ancestors, descendants. |
| `list_concept_sets` / `get_concept_set` | Data dictionaries of the workspace and their Mapping Notes. |
| `find_sources_for_targets` | The reverse lookup: source concepts that suggestions link to given targets (ids or a concept set). |
| `add_ai_suggestions` | **Default output.** Suggestions shown in the app's Suggestions panel (category AI). |
| `create_mappings` | Mappings (status unchecked). **Only for picks the user confirmed one by one.** |
| `remove_ai_suggestions` | Withdraw your suggestions (all of a model's, or some concepts'), e.g. after a wrong batch. |

## Step 1 — Find the project and agree on the session

1. `list_mapping_projects`, then `get_mapping_project` on the one the user
   means. Tell them in one sentence where it stands, e.g. *"MIMIC-IV Demo:
   1786 of 5636 mapped, no precomputed suggestions, vocabulary ATHENA."*
2. If the vocabulary database is reported unusable, stop and relay the fix to
   the user (pick an OMOP vocabulary database in the project's settings).
   A database project not yet extracted still works, without counts or
   metadata: say so, and suggest the extraction (Source concepts tab) when the
   metadata would decide between targets.
3. Ask, once per session, and keep the answers:
   - **Output** — *suggestions* (default: `add_ai_suggestions`, a reviewer
     accepts or rejects them in Linkr) or *mappings* (`create_mappings`, every
     concept confirmed by the user before it is written).
   - **Scope** — which concepts: a category, the most frequent unmapped ones, a
     name pattern, specific codes, or those with precomputed suggestions
     (`with_suggestions`). `get_mapping_project` gives each category's unmapped
     count; show the count and a few examples before starting, and say so when
     the scope holds fewer concepts than asked.
   - **Candidates per concept** (suggestions only, default 3) and whether they
     want to see each batch before it is written (default: no — the review
     happens in Linkr).
   - **Data dictionary** — if they mention concept sets or a dictionary, read
     `references/data-dictionary.md` now.

Your **model name** is needed by `add_ai_suggestions` (it becomes the method
`ai/<model>`). Use your real model identifier; ask the user if you do not know it.

## Step 2 — Map, batch by batch

Batches of about 10 concepts. Concepts are listed as `vocabulary/code`
(`d_labitems/50812`); tools take that token, or the code alone as
`concept_code` with `vocabulary_id` beside it. For each concept:

1. `get_source_concept` (`mapping_project_id`, `concept_code`) — read the name **and the metadata**: unit, value
   range and percentiles, categorical values, category path, hospital units.
   The metadata is what separates near-identical targets.
   If the name and the metadata say nothing you can interpret — a single
   letter, an anonymised placeholder (`STX3`, `UTX7`), a tube or billing flag
   — stop there: do not search the vocabulary for it, list it in the summary
   as not interpretable.
2. Decide the domain, then follow the procedure for it:
   - Measurement, Condition, Procedure, Observation → `references/clinical.md`
   - Drug → `references/drugs.md`
3. Search with `search_vocabulary` (translate to English first), inspect the
   finalists with `get_vocabulary_concept`, judge them with
   `references/omop-reference.md` (equivalence, comment rules, domain hints).

Then write the batch:

- **Suggestions** — one `add_ai_suggestions` call for the batch: up to the
  agreed number of candidates per concept, best first, each with its score,
  equivalence and comment. Show the batch as a compact table
  (source → target, equivalence, score, comment).
- **Mappings** — present each concept (source, metadata highlights, 1–3
  candidates with reasoning) and wait for the user's choice. Write only what
  they accepted, with `create_mappings`. A concept not to be mapped (bed
  number, internal code) can be written as `status: "ignored"` with a reason.

The tools refuse a batch with an unknown source code, an unknown, invalid or
non-standard target, a missing comment, or an equivalence outside the SKOS set.
Nothing is written in that case: fix the items listed and send the batch again.
Existing suggestions and mappings are never overwritten. If a batch you wrote
turns out wrong, withdraw it with `remove_ai_suggestions` and write it again.

## Step 3 — After each batch

Summarise: what was written (count, equivalences), what was left out and why,
how many remain (`list_source_concepts` total). Ask whether to continue, change
scope, or switch domain.

## Rules that always hold

- **Never invent a concept id.** Every target comes from `search_vocabulary`,
  `get_vocabulary_concept`, a suggestion or a concept set.
- **Standard, valid targets only.** A non-standard hit leads to its `Maps to`
  target.
- **Be strict on equivalence**: `skos:exactMatch` only when nothing is lost;
  default to `skos:closeMatch` when a qualifier (specimen, method, site,
  timing) differs, and say what differs.
- **Write comments for the reviewer**, in the user's language, per
  `references/omop-reference.md`.
- **Mappings need the user's explicit yes**, concept by concept. Without it,
  write suggestions.

## Precomputed suggestions (optional)

Syntactic and semantic scores (Jaro-Winkler, BioLORD embeddings) are computed
outside the chat by two Python scripts in `scripts/`, then loaded into the
project in Linkr (Suggestions tab → load scores file). They make candidate
search much better, especially for drugs. You do not run them from a chat
without a shell; if the user wants them, point to `references/precompute.md`.
