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

## 4. Optional: precomputed suggestions and semantic search

Syntactic scores (Jaro-Winkler, token sort, n-gram IDF) and semantic scores
(embeddings, e.g. [BioLORD-2023-M](https://huggingface.co/FremyCompany/BioLORD-2023-M))
give every source concept a ranked shortlist before an agent looks at it. This
helps most for drugs. Linkr computes them on the server, as jobs. Set them up
in the mapping editor: Suggestions panel › **Manage suggestions**.

- **Compute › Models and configurations** (shared by the workspace): one click installs the embeddings
  runtime (sentence-transformers + torch, about 2 GB, from the configured
  package index) and downloads BioLORD-2023-M (about 1 GB, not shipped with
  Linkr). It also creates a configuration over the non-drug standard concepts.
  Then build its index, about an hour on a CPU. Any other sentence-transformers
  model can be added, by its Hugging Face id or from a folder on the server; a
  server folder is the way to bring one into an environment without internet
  access.
- **Compute** (per project): pick the methods and the target scope. Each method
  computed replaces only its own rows, so AI suggestions are kept.

The agent can do the same through the MCP: `list_suggestion_engines`,
`compute_suggestion_scores`, `build_embedding_index`, and
`semantic_search_vocabulary` for a search by meaning while mapping. See
[`references/precompute.md`](packages/linkr-mcp/skills/concept-mapping/references/precompute.md).

Server settings: `LINKR_PIP_INDEX_URL` (package mirror), and
`LINKR_EMBEDDINGS_TORCH_BACKEND`. With `auto` (the default), uv picks the CUDA
build of torch when the server has an NVIDIA driver; leave it empty when the
mirror only proxies PyPI. `LINKR_HF_ENDPOINT` sets a Hugging Face mirror.

## Contributing back

The skill is versioned for citation (`metadata.version` in `SKILL.md`, plus
`CHANGELOG.md`): bump it with every change. Push to a branch of your fork and
open a merge request.
