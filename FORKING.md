# Mapping concepts with an AI agent

Linkr ships a **concept-mapping skill**: a procedure an AI agent follows to map
a hospital's local codes to OMOP standard concepts inside a Linkr mapping
project. It lives in [`packages/linkr-mcp/skills/concept-mapping/`](packages/linkr-mcp/skills/concept-mapping/)
and is written in the open [Agent Skills](https://agentskills.io) format, so it
works with any model in any client that loads skills — LibreChat, Claude Code,
and others.

The agent works on the live project through the **Linkr MCP server**: it reads
the source concepts and their metadata, searches the OMOP vocabulary, and
leaves AI suggestions (or, when the user confirms them, mappings) that a human
reviews in Linkr. No export, no local files.

> **User documentation:** [Concept mapping — Suggestions](https://linkr.interhop.org/docs/concept-mapping/suggestions/)
> on the Linkr website. This file is the technical setup.

## 1. What you need

- A Linkr server (full-stack mode) with the mapping project, and an **OMOP
  vocabulary database** set in the project's settings (an ATHENA import).
- The **Linkr MCP server** running (`packages/linkr-mcp`, see its README) and
  connected to your client with your **Linkr API key** (Profile → API keys).
- A model allowed to see the data. Source terminologies carry value
  distributions and ward names: with a remote model, use open data or a model
  you are permitted to send them to.

## 2. LibreChat

1. Build the skill archive: `cd packages/linkr-mcp && npm run skill:pack` →
   `dist/concept-mapping.zip`.
2. In LibreChat, import it as a skill (Skills → import).
3. Connect the Linkr MCP server, reinitialise it so LibreChat lists the mapping
   tools, and enable them (and the skill) for your agent.
4. Ask, for example: *"Map the unmapped Blood Gas concepts of the MIMIC-IV Demo
   mapping project."*

Re-run `skill:pack` and re-import after changing the skill.

## 3. Claude Code

`.claude/skills/concept-mapping` links to the skill folder, and `.mcp.json`
declares the Linkr MCP server: opening the repository is enough. Set
`LINKR_API_URL` and `LINKR_TOKEN` (your API key) in `packages/linkr-mcp/.env`.

## 4. Optional: precomputed suggestion scores

Syntactic (Jaro-Winkler) and semantic (BioLORD embeddings) scores give every
source concept a ranked shortlist before an agent looks at it — a large gain
for drugs. They are computed outside the chat, in a terminal, by the skill's
two scripts, then loaded into the project in Linkr. The full procedure —
inputs, memory limits, loading without losing existing AI suggestions — is in
[`references/precompute.md`](packages/linkr-mcp/skills/concept-mapping/references/precompute.md).

1. Download the vocabularies from [Athena](https://athena.ohdsi.org/) and
   convert them to Parquet:

   ```bash
   duckdb -c "
     COPY (SELECT * FROM read_csv_auto('CONCEPT.csv', sep='\t')) TO 'CONCEPT.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
   "
   ```

2. Install the dependencies:

   ```bash
   pip install pandas pyarrow numpy rapidfuzz duckdb sentence-transformers faiss-cpu
   ```

3. Embed the vocabulary, once per release (several hours on CPU; resumes after
   an interruption). The public
   [BioLORD-2023-M](https://huggingface.co/FremyCompany/BioLORD-2023-M) model
   (~440 MB) is downloaded on first run:

   ```bash
   python packages/linkr-mcp/skills/concept-mapping/scripts/embed_concepts.py \
     --concept <vocab_dir>/CONCEPT.parquet
   ```

4. Score the project's source concepts (always with target filters), then load
   `similarity-scores.parquet` in the mapping editor (Suggestions → load
   scores file).

## Contributing back

The skill is versioned for citation (`metadata.version` in `SKILL.md`, plus
`CHANGELOG.md`): bump it with every change. Push to a branch of your fork and
open a merge request.
