# Skills — where they live, how agents get them

**Problem.** Agents driving Linkr through the MCP need procedures, not just tools: how
to build a dashboard, how to query *this* warehouse, how to run an analysis the way the
team likes. Today the one skill (`concept-mapping`) lives in `packages/linkr-mcp/skills/`
and reaches LibreChat as a zip imported by hand (`npm run skill:pack`): every update is
a manual re-import, and nobody outside the repo can write or share one.

*Started 2026-10-12.*

## 1. Three kinds of skill, three homes

| Kind | Examples | Coupled to | Home |
|---|---|---|---|
| **Product** | concept mapping, build a dashboard / patient board / cohort | the MCP tools' names, parameters and pitfalls | `packages/linkr-mcp/skills/`, shipped with the MCP |
| **Method** | statistics, exploratory data analysis | nothing in Linkr; a team's taste and references | a **Skill entity**, published in `linkr-public-content/skills/`, listed by the catalog |
| **Local** | querying a given hospital warehouse | one site's data and conventions | a **Skill entity** in that site's workspace, private |

- A product skill breaks when a tool changes signature, so it changes in the same
  commit as the tool. Making it an editable entity would breed community copies that
  call tools that no longer exist.
- Method and local skills are content: they want what Linkr already gives content —
  catalog, git link, lineage, author/ORCID, export, review in the app.

## 2. Delivery: through the MCP itself

The agent reaches every skill through MCP tools, whatever the client:

- `list_skills(workspace_id?)` — name + one-line description of each available skill:
  the MCP's product skills, plus the Skill entities of the workspace (and, by default,
  the one of the project in context).
- `get_skill(name)` — the `SKILL.md` body, with the list of its other files.
- `read_skill_file(name, path)` — one reference file, on demand (progressive
  disclosure, as Agent Skills do).

The server `INSTRUCTIONS` (`src/live/build.ts`) tell the agent to call `list_skills`
before a task that one may cover.

- **LibreChat**: nothing to configure — the `linkr` MCP is already declared. Product
  skills update when the MCP is redeployed; method/local skills when the entity is
  installed or edited. The zip import goes away (`skill:pack` kept for Claude Desktop
  and other clients that want native skills).
- **Claude Code / Desktop**: same tools; a Skill entity also exports as a plain Agent
  Skills folder (§3), droppable into `.claude/skills/`.
- **Not used**: MCP *prompts* (`prompts/list`) — client support is uneven, tools work
  everywhere. LibreChat's native skills (`/v1/skills`) — syncing to them needs a
  LibreChat management key on the Linkr side; reconsider only if users want to pick
  skills per agent in the LibreChat UI.

## 3. The Skill entity

- **Scope**: workspace, like the wiki and SQL collections.
- **Tree** = an [Agent Skills](https://agentskills.io) folder plus Linkr's metadata, so a
  published repo is both a Linkr entity and a skill any client loads:

  ```
  entity.json          — Linkr metadata (id, lineage, authors, requires…)
  SKILL.md             — frontmatter (name, description, metadata.version) + body
  references/*.md      — loaded on demand
  assets/*             — files the agent copies into the user's work (themes, templates)
  CHANGELOG.md
  ```

- **`requires`**: minimum MCP version and the tools the skill names. `get_skill` warns
  when a tool is missing on this instance instead of letting the agent fail midway.
- **Versioning**: `metadata.version` (SemVer) + dated `CHANGELOG.md`, as `concept-mapping`
  does — a method skill is something people cite.
- **Editor**: the SQL collection file-tree editor (tree + Markdown/code editor + git
  tab), not a new one. A preview of `list_skills` as the agent will see it.
- **Format package**: new kind in `entity-io.ts` *and* `packages/linkr-format/`
  (CLAUDE.md rule), catalog type `skill` in `ENTRY_TYPES`.

## 4. Local warehouse skills and the wiki

A warehouse's local quirks (which table holds what, codes that differ from the
standard, known data holes, dates to distrust) are useful to humans too, and the wiki
already holds them, is edited in the app, and is readable through the MCP
(`search_wiki_pages`, `get_wiki_page`). Duplicating them in a skill would fork the
truth.

Proposed split:

- **Wiki = facts** about the warehouse, written for humans, maintained by the people who
  know the data.
- **Skill = procedure**: how to query this warehouse step by step, which checks to run,
  which pitfalls to test for. It **points to wiki pages** instead of copying them: a
  `context` list in `entity.json` (wiki page ids), resolved by `get_skill`, which
  returns the skill body followed by those pages (or their titles + ids when too long,
  for `get_wiki_page` on demand).

A generic *query a clinical warehouse* method skill (find the table, check the
concept/source concept pair, count before extracting, aggregate before printing) can
then be specialised by a thin local skill that adds its wiki pages and site rules.

## 5. First method skills

- **Statistics** — choosing a test from the question and the data, assumptions to
  check, effect sizes and intervals over p-values, multiple testing, reporting. The
  team's chosen references go in `references/` as **summaries with full citations**
  (not copies of the texts: licences), so the agent cites them in what it writes.
- **Exploratory data analysis** — the order of the look (shape, missingness, units,
  distributions, outliers, time, crossings), and the team's way of plotting:
  `assets/` holds the ggplot2 theme and the matplotlib / plotly style, plus a few
  reference plots described in `references/`. The skill tells the agent to apply them
  in IDE scripts, and to print aggregates only (see `mcp-skills-advice.md`).

Both published in `linkr-public-content/skills/`, indexed by the catalog, and installed
in the demo workspace so a fresh instance has them.

## 6. Security

A skill is instructions to an agent that holds `run_code`, `run_sql` and write tools,
inside a clinical warehouse (`docs/deployment-context.md`). So:

- Installing from the catalog is always explicit, never automatic or on update without
  a diff shown.
- Nothing in a skill runs at install or load: `scripts/` and `assets/` are text the
  agent may use through the normal, permission-gated tools.
- Creating or editing a Skill entity needs workspace edit rights; the change is in the
  entity's history like any other.
- Tool permissions apply whatever a skill says — a skill grants nothing.

## 7. Steps

| St | # | Item | Effort |
|----|---|------|--------|
| 🤔 | 0 | Arbitrate: §4 wiki split (`context` list vs references-only), project-level skills or workspace only | S |
| 🔜 | 1 | `list_skills` / `get_skill` / `read_skill_file` over the MCP's bundled skills + `INSTRUCTIONS`; drop the zip from the LibreChat setup doc | S |
| 🔜 | 2 | Product skills from `mcp-skills-advice.md`: dashboard, patient board, cohort | M |
| 🔜 | 3 | Skill entity: model + migration + API, export tree, `linkr-format` schema, catalog type | M |
| 🔜 | 4 | Skill editor (SQL collection file-tree editor), workspace sidebar entry | M |
| 🔜 | 5 | MCP reads Skill entities (`list_skills` merges them, `requires` check, wiki `context`) | S |
| 🔜 | 6 | Method skills: statistics, EDA (+ plotting theme assets) in `linkr-public-content`, catalog entries, demo workspace | M |
| 💤 | 7 | Optional sync to LibreChat native skills (`/v1/skills`) | M |
| 🔜 | 8 | User docs (linkr-website): skills page, LibreChat setup without the zip | S |
