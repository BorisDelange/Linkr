# AI agents — design

Two distinct products under one name. Keep them separate in the code; they share
only the Skills entity and the LLM provider config.

1. **CLI agent in the IDE** — OpenCode (plus Claude Code, Gemini CLI…) running in
   the project's server-side working directory, driven from an IDE panel.
2. **Conversational product agent** — a copilot in a right sidebar on Dashboard /
   Cohorts / Patient data, calling *tools* that map to the actions a user performs
   with the mouse. Mental model: Claude inside PowerPoint, not Claude Code.

Feasibility: **yes, and the app is well positioned** — three heavy pieces already
exist (permission-gated PTY terminal over WS, permission catalogue, fully
action-based dashboard store). The real cost is UI/UX and safety, not LLM plumbing.

---

## 0. What already exists and gets reused

| Building block | Where | What it gives us |
|---|---|---|
| PTY terminal over WebSocket | [execution.py:587-680](../../apps/api/app/api/v1/routes/execution.py#L587) | `_terminal_pty_loop`: bash PTY, resize, native Ctrl+C, gated on `ide:execute` + `enable_code_execution`. **A CLI agent is just one more process in that PTY.** |
| xterm.js | `@xterm/xterm` + `@xterm/addon-fit`, already a dependency | terminal rendering, already wired |
| Permission catalogue | [permissions.py:26](../../apps/api/app/core/permissions.py#L26) | `WORKSPACE_CATALOGUE`, `"resource:action"`, `has_project_permission`, `require_project_permission` |
| UI gate | [use-context-role.ts](../../apps/web/src/hooks/use-context-role.ts) | `can('skills:write')` — one line to gate a button |
| "File collection" entity | `SqlScriptCollection` / `SqlScriptFile` in [sql_script.py](../../apps/api/app/models/sql_script.py) | the exact pattern to clone for Skills |
| Path-keyed versioned tree | [entity-tree.ts](../../apps/web/src/lib/entity-tree.ts) | `_tree.json` keyed by path + `deterministicId` → git-friendly, no id churn |
| Action-based dashboard store | [dashboard-store.ts:31-76](../../apps/web/src/stores/dashboard-store.ts#L31) | ~25 atomic, id-addressed actions — **this is already a tool API** |
| Provenance / catalog | lineageId, author, org on the 7 exportables | Skills inherits it for free and becomes publishable to the catalog |

Nothing to invent on the execution side. On the LLM side, `apps/api` has **no** AI
dependency today: blank page, free choice.

---

## 1. Skills entity (workspace-scoped)

A skill is a folder with `SKILL.md` plus optional files. This is an **open standard**
(agentskills.io) read by Claude Code, OpenCode, Codex, Cursor and 20+ other agents.
Minimal frontmatter: `name` and `description` required, everything else optional.
No runtime, no build step.

So: **do not invent a format.** Store folders, write them to disk, let agents read
them.

### Model

A strict clone of SQL collections:

**Decided: one entity = one skill** (one folder with its `SKILL.md`), not a bundle.
So the entity is called `Skill`, **not** `SkillCollection` — unlike SQL collections,
where one collection holds N scripts. Getting the vocabulary right here matters: it
keeps 1 entity = 1 publishable/installable unit for the catalog, with its own semver
`version` and `lineage_id`, consistent with the other exportables.

- `Skill` — workspace_id, entity_id, name/description LocalizedString,
  git_remote_config, version, created_by*, organization, lineage_id, parent_lineage_id
- `SkillFile` — id, skill_id, name, type (`file` | `folder`), parent_id, content,
  order

Consequence to accept: no files shared between skills (no `shared/refs.csv` across a
pack). The standard pushes towards self-contained skills anyway, so this is not a
real loss. A "skill pack" is a workspace, or a future grouping.

### Implementation checklist (mirrors sql-scripts)

**Backend** — `models/skill.py`, `schemas/skill.py`, `api/v1/routes/skills.py` (the
same 10 routes as [sql_scripts.py](../../apps/api/app/api/v1/routes/sql_scripts.py):
skill CRUD + file CRUD + purge), alembic migration, router registration.

**Frontend** — `stores/skills-store.ts`, `lib/api/skills.ts`, pages under
`features/warehouse/skills/` (List / Editor / FileTree / create dialogs) following
`features/warehouse/sql-scripts/`, sidebar entry, i18n EN+FR.

**Cross-cutting** — `entity-io.ts` (export/import + `_tree.json` via
`entity-tree.ts`), golden test `skill-export-golden.test.ts`, seed loader +
manifest, catalog (one more `type: "skill"` per `catalog-plan.md`), versioning /
git-link.

**Permissions** — add `"skills": RWD` to `WORKSPACE_CATALOGUE`.

Effort: **M**. Well-trodden ground — the only real work is frontmatter validation
and the Markdown editor.

Worth adding: validate `SKILL.md` (frontmatter present, `name`/`description`
non-empty) and surface the result in the list. An invalid skill is silently ignored
by agents, which is painful to diagnose.

### 1b. Selecting skills per project (captured 2026-08-22)

Skills are authored in the **workspace** (an AI Skills page next to the other
workspace entities); a **project picks** which of them it uses. The picked set then:

- is materialised into the project's IDE working directory, so opening the terminal
  gives the agent access with no further action (§3 already specifies the path, and
  that it is generated + gitignored — the pick is what decides *which* skills land there);
- **travels with the project export**, as a list of references, not copies. A copy
  would fork the skill and defeat the workspace-level authoring; a reference means an
  imported project states what it needs and the missing skills are installable from the
  catalog, which is exactly the mechanism `catalog-plan.md` already provides.

Open: what an import does when a referenced skill is absent — flag it in the project
(a "missing skills" state) rather than failing the import, on the "simple tolerant read"
preference. Confirm at build time.

This answers §9 question 1: **workspace-scoped authoring + project-level selection**,
rather than project-scoped skills.

### 1c. Beyond `SKILL.md` — `AGENTS.md` and non-Claude runtimes

Two things not to conflate:

- **`SKILL.md`** — one folder = one capability, the agentskills.io standard, already
  the model above. Read by Claude Code, OpenCode, Codex, Cursor and others.
- **`AGENTS.md`** — a single repo-root file describing *the project* to any agent
  (build commands, conventions, layout). Different unit, different lifetime: it is a
  property of the project, not a shareable, versionable, catalog-publishable entity.

So `AGENTS.md` is **not** a Skill. It is best generated per project into the IDE working
directory alongside the skills tree — from the project's own metadata (name,
description, datasets, schema mapping, IDE paths), with a user-editable override. Worth
one item, not an entity.

**Non-Anthropic models are already covered.** `LlmProvider.kind` includes `mistral`,
`openai`, `gemini` and `local-openai-compatible` (§2), and the provider config is
**done** — OpenRouter is an OpenAI-compatible `base_url`, so it needs no new kind, at
most a preset in the provider dialog. What determines whether a given model can *use*
skills is the agent binary (OpenCode, Claude Code…), not the provider — and OpenCode
reads `.agents/skills/` whatever model sits behind it. Nothing to investigate on the
protocol side; the open item is only which agent binaries we test against.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Project-level skill selection (picker + reference list in the project export) | M |
| 🤔 | Import with a missing referenced skill: flag, offer catalog install, never fail | S |
| 🔜 | Generated `AGENTS.md` per project (from project metadata) + user override | S |
| 💤 | OpenRouter preset in the provider dialog (no new `kind` needed) | S |

---

## 2. LLM providers & permissions (the foundation for both tracks)

Do this **before** either UI. This is where the health-data risk is decided.

### Three new permissions

```python
"skills": RWD,                    # workspace
"llm-config": ["read", "write"],  # workspace — manage providers
"agents": ["read", "execute"],    # project  — use an agent
```

`llm-config:write` is the sensitive right requested: **who may enable an LLM**.
Deliberately separate from `agents:execute` (who may use one). Defaults:

- viewer → `agents:read`
- editor → `agents:execute` (via the `write ⊇ execute` ladder)
- owner only → `llm-config:write`

⚠️ The current `_LADDER` grants `execute` to anyone holding `write`. For
`llm-config` we declare no `execute` action, so there is no leak there — but
`_catalogue_perms("write")` would still hand `llm-config:write` to editors by
default. It must be **explicitly excluded**, the same way `_MEMBER_RESOURCES`
already excludes membership writes. Same mechanism, one line.

### Provider model

`LlmProvider` — workspace_id, name, kind, base_url, model, api_key_encrypted,
is_local, enabled, created_by… API key encrypted with **Fernet via `crypto.py`** and
never returned by the API; the secrets-at-rest pattern already exists for database
passwords.

`kind` ∈ `local-openai-compatible` (Ollama / LM Studio / llama.cpp / vLLM),
`anthropic`, `openai`, `mistral`, `gemini`, `custom`.

**Status: done.** `LlmProvider` has its routes, the settings tab lives under the
workspace and is gated on `llm-config:write` (owner-only, enforced server-side),
and providers are approved per surface. `lib/agent/settings.ts` picks its backing
at call time: the server when there is one, `localStorage` for client-only (WASM)
deployments, which have no backend to hold a provider list and nowhere safer to
keep a key. The API key is never returned by the API — responses carry
`hasApiKey`.

### The remote-model guardrail

OpenCode talks to any OpenAI-compatible endpoint through `options.baseURL`, so a
local model is literally `baseURL: http://localhost:11434/v1`. **Local is therefore
the natural default**, not an extra effort.

Product rules:

- `is_local` is **derived, never declared** — computed server-side from the URL
  (localhost / 127.0.0.1 / ::1 / RFC1918 private ranges / hostname without a public
  TLD). A user must not be able to tick "local" on `api.openai.com`.
- Creating a non-local provider requires a dedicated confirmation dialog: red
  border, explicit wording about health data leaving the local infrastructure, a
  checkbox ("I understand data sent will leave the institution"), and retyping the
  provider name. Recorded in the database as `acknowledged_by_id`,
  `acknowledged_at`, `acknowledgement_text` — a decision trail, useful for audit.
- A permanent red "External API" badge wherever that provider is listed, and in the
  agent panel header while it is active.
- Instance-level setting `LINKR_ALLOW_REMOTE_LLM=false` (default **false**) blocking
  creation of non-local providers server-side. An institution admin can then
  structurally forbid data egress instead of relying on user discipline. **This is
  the strongest guarantee in the design** — the checkbox only protects against
  accidents.

> Worth keeping in mind: the execution sandbox. A CLI agent in the PTY runs with the
> server process's rights, including access to project datasets. A remote model plus
> an autonomous agent means patient data can be exfiltrated through prompt content
> itself, not only through files. Hence the restrictive default.

---

## 3. Track A — CLI agent in the IDE

### Materialising skills on disk

An "Import skills" button in the IDE writes the selected skills into the project
working directory. OpenCode scans these three locations equally, walking up to the
git worktree:

```
.opencode/skills/<name>/SKILL.md
.claude/skills/<name>/SKILL.md
.agents/skills/<name>/SKILL.md
```

**Decided: `.agents/skills/<name>/` is the default.** It is the vendor-neutral path,
and OpenCode — the priority target — resolves it exactly like the other two, so
nothing is lost. Writing a competitor's brand directory into a Linkr project working
dir just to run OpenCode would also make Linkr a carrier of an Anthropic convention,
against the "local and open first" priority.

Claude Code, however, reads **only** `.claude/skills/`. So the path is **derived from
the selected agent** rather than fixed:

| Agent | Directory written |
|---|---|
| OpenCode (default) | `.agents/skills/` |
| Claude Code | `.claude/skills/` |
| others | `.agents/skills/` |

This costs almost nothing: the directory is **generated** from the Skill entity
(the database stays the source of truth) and gitignored, so it is a per-agent output
path, not a stored layout. By default we never write `.claude/`.

The generated tree needs an explicit re-sync action from the Skills page.

### Server prerequisites (decided)

`opencode`, `claude`, `gemini` are **executables on the machine running the API**.
Linkr cannot ship them from the browser: when the user types `opencode` in the PTY,
either a binary is there or they get `command not found`. Same for the model runtime
— OpenCode is useless without a reachable Ollama / LM Studio.

**Decision: documented prerequisite + detection on page load.** Run
`opencode --version` (and the equivalent per agent) when the panel mounts, and render
an explicit empty state with a link to the install docs when it is missing — never a
raw `command not found` in the terminal. Same probe for the local model endpoint.

Rejected alternatives, for the record:

- *Bundle the binaries in the Docker image* — Linkr would embed, version and track
  third-party tools, and the image grows for an optional feature.
- *Install on demand via the managed uv environments* — elegant, but requires
  outbound network access from the server, usually absent in a hospital setting.

The hospital context (closed network, DSI-controlled images) is what makes
auto-install illusory and the documented prerequisite the honest choice.

### Launching the agent

Two levels, in this order:

**A1 — Terminal (nearly free, do this first).**
The CLI agent is a binary. The PTY exists. Generate an `opencode.json` in the
working directory from the active provider and permissions, and the user types
`opencode`. The TUI renders in xterm.

Actual work: detect the installed binary (`opencode --version`), generate the
config, inject the API key as a PTY environment variable (never into a readable
file), show a clear message when missing. Effort **S/M**. This already delivers most
of the value for power users.

The generated `opencode.json` also carries the **agent's own permissions** —
OpenCode has an `allow`/`ask`/`deny` system per tool and per pattern, last match
wins:

```json
{
  "permission": {
    "bash": { "*": "ask", "rm *": "deny", "git push *": "deny" },
    "edit": { "*": "ask", "datasets/**": "deny" },
    "webfetch": "deny"
  }
}
```

Map Linkr permissions onto those rules: a user without `ide:write` gets
`"edit": "deny"`. And `webfetch`/`websearch` default to `deny` in a health context.

**A2 — Structured agent panel (the real product).**
The problem raised — "avoid the Claude Code / OpenCode flood" — is solved by **ACP
(Agent Client Protocol)**, designed for exactly this: an open standard created by
Zed (August 2025), JSON-RPC 2.0 over stdin/stdout, community-governed, adopted by
JetBrains. Claude Code, Gemini CLI and Goose implement it.

Instead of parsing ANSI TUI output (fragile, unreadable), we receive typed events:

| Method | Purpose |
|---|---|
| `initialize` / `authenticate` | capability negotiation |
| `session/new`, `session/load`, `session/prompt`, `session/cancel` | lifecycle |
| `session/update` (notification) | `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `user_message_chunk` |
| `session/request_permission` | **the agent asks, we render our own dialog** |
| `fs/read_text_file`, `fs/write_text_file` | we keep control of I/O |
| `terminal/create`, `output`, `wait_for_exit`, `kill`, `release` | commands |

This is precisely the interface that enables clean rendering: conversation bubbles,
tool calls collapsed to one line ("Read `cohort.sql`", "Ran 3 tests"), plans as
checklists, and **our** permission dialogs instead of the TUI's.

Architecture: the backend spawns the agent as a subprocess, relays JSON-RPC over a
WebSocket (next to `/terminal`), the frontend renders the events. The raw PTY stays
available for users who prefer it.

Effort **L**. Only start it after A1, and after Track B if resources are tight — A1
already covers the power-user need.

---

## 4. Track B — Conversational agent (right sidebar)

**Highest product value, and simpler than it looks.**

Reason: `dashboard-store.ts` is already a tool API. Every action is atomic,
id-addressed, and DOM-independent:

```ts
addTab(dashboardId)                      removeTab(tabId)
addSubTab(parentTabId, moveWidgets?)     updateTab(tabId, {name, description})
reorderTabs(dashboardId, orderedIds)     setActiveTab(dashboardId, tabId)
addWidget(tabId, source, name, datasetFileId?)
removeWidget(widgetId)                   moveWidget(widgetId, newTabId)
duplicateWidget(widgetId, targetTabId?)  updateWidgetLayout(widgetId, {x,y,w,h})
updateWidgetSource(widgetId, source)     updateWidget(widgetId, {name, description})
updateWidgetDataset(widgetId, fileId)    setFilter(filterId, value)
```

→ **The tool schema derives almost mechanically from these signatures.** No refactor
needed. This is the best news in the plan.

### Background-then-refresh, or live?

**Live, without hesitation.** Three reasons:

1. State lives in a Zustand store, so mutations are **already reactive**. An
   `addWidget()` called by the agent re-renders the dashboard exactly like a click.
   "Live" costs nothing extra; it is "background then refresh" that would require
   additional work.
2. It matches the mental model cited (Claude in PowerPoint / Canva): you watch the
   slide being built.
3. Seeing the action happen is a **control**: the user spots a mistake immediately
   and interrupts.

Necessary corollary: **an undo**. An agent making 6 mutations must be reversible in
one gesture. The store has no history today. Simplest approach: snapshot the
dashboard before the agent turn, offer "Undo these changes". No general undo/redo
stack needed — per-turn rollback is enough, roughly 50 lines.

### Architecture

```
Right sidebar (Sheet / resizable panel)
   │  messages + collapsed tool calls + Undo / Stop
   ▼
useAgentChat()  ── WS ──▶  /api/v1/projects/{uid}/agent/chat
   │                            │
   │                            ├─ LLM provider (local by default)
   │                            ├─ tool definitions (JSON Schema)
   │                            └─ context: current dashboard, datasets, columns
   ▼
Tools execute CLIENT-SIDE against dashboard-store
```

Key architectural point: **the LLM runs server-side, but tools execute
client-side** against the store. The server returns "call `add_widget` with these
args", the client executes it, renders it, and sends the result back for the next
turn. This keeps a single source of truth (the store) and avoids duplicating
dashboard logic in Python.

In WASM/static mode (no backend), the same client can hit a local OpenAI-compatible
endpoint directly — Track B keeps working, consistent with the app's dual
deployment.

### Spike result (2026-08-05) — local tool-calling is viable

Batch 3 ran against Ollama with `llama3.1:8b`, temperature 0, tools derived from the
real store signatures, 3 trials per scenario. **12/15 overall, but the split is what
matters:**

| Scenario | Score | What it exercises |
|---|---|---|
| Create a tab | 3/3 | simple tool |
| Add a widget | 3/3 | inferring the right dataset (`ds_labs`) from "lactate" |
| Move a widget | 3/3 | name → id resolution ("Sex ratio" → `wid_sex`) |
| Resize a widget | 3/3 | numeric args (`w=12`) |
| Refuse out-of-scope | **0/3** | guardrail |

**The 4 real tasks scored 12/12.** An 8B model handles name→id resolution and dataset
inference — exactly what the copilot needs. Track B is not blocked by local model
capability.

The 0/3 is **not** a model defect to fix, it is an architecture requirement. Asked to
"delete every patient older than 80", the model has no tool for that and grabs the
nearest one (`add_widget`). Small models do this, and prompt engineering does not
fix it reliably. Therefore:

> **Safety must never rest on the model refusing.** The guardrail belongs in the
> execution layer: an out-of-scope or unknown tool call is rejected silently rather
> than executed, and every tool re-checks its permission. The whitelist below is a
> demonstrated necessity, not a precaution.

### Tool safety

- Strict whitelist: store actions only, never arbitrary code execution through this
  path.
- Every tool re-checks its permission (`dashboards:write`) before acting — an LLM
  must not exceed the rights of the user driving it.
- Destructive actions (`removeTab`, `removeWidget`) go through a confirmation, or
  are excluded from the first batch.
- **Never send patient data in the context.** Send the *schema* (column names,
  types, aggregate stats), never rows. State this explicitly in the code, with a
  test.

### SDK choice

The agentic loop (call → tool_use → result → call again) has to be written once. The
Anthropic SDK ships a `tool_runner` that provides it turnkey, but locks us to
Anthropic — contradicting the "local first" priority.

Recommendation: **a small in-house loop over the OpenAI-compatible API**
(`/v1/chat/completions` + `tools`), the common denominator of Ollama, LM Studio,
llama.cpp, vLLM, Mistral and OpenAI, plus an Anthropic adapter if needed. ~200
lines, no heavy dependency, and local stays first-class. Verify early that a
reasonable local model (recent Qwen/Llama) calls tools reliably — **this is the main
technical risk of Track B**, to be tested before investing in the UI.

### Extending to Cohorts / Patient data

Same engine, different tool set per page. Do **Dashboard only** first; the other
pages follow once the pattern is proven.

---

## 5. UI: the panel

Right sidebar, opened by a persistent button, resizable width (`allotment` is
already a dependency). Not a modal: the dashboard must stay visible while the agent
works.

Anti-flood principle: **one collapsed line per action, by default.**

```
┌─────────────────────────────────┐
│ 🤖 Assistant     ⚠️ External API │
├─────────────────────────────────┤
│ Add an age distribution chart   │
│                                 │
│ Looking at the dataset…         │
│  ▸ Read patients.parquet        │
│  ▸ Created "Age distribution"   │
│                                 │
│ Added to the Demographics tab   │
│              [Undo]             │
├─────────────────────────────────┤
│ [Ask something…]            [↑] │
└─────────────────────────────────┘
```

- Agent text as markdown (`react-markdown` is already there).
- Tool calls are **one clickable line**, expandable for details. Never a dump.
- A plan (if the agent emits one) renders as a checklist that ticks off.
- Stop always visible while running.
- Provider badge in the header, red for an external API.
- Reuse the pattern from `DashboardFilterSidebar.tsx`, already a side panel on this
  page.

---

## 6. Proposed order

| # | Batch | Effort | Why here |
|---|---|---|---|
| 1 | `skills` / `llm-config` / `agents` permissions + `LlmProvider` model + encryption + acknowledgement dialog + `LINKR_ALLOW_REMOTE_LLM` | M | Foundation for both tracks. Safety frame **before** any capability. |
| 2 | Skills entity (CRUD, pages, export/import, catalog) | M | Standalone, useful even without agents (shareable skills in the catalog). |
| 3 | Spike: local-model tool-calling (Ollama/LM Studio) on 3 dashboard tools | S | **De-risks Track B before investing in UI.** Do this early. |
| 4 | Track A1: generated `opencode.json` + skills → `.claude/skills/` + launch in the PTY | S/M | The PTY exists. Immediate value for power users. |
| 5 | Track B: sidebar + agent loop + dashboard tools + per-turn undo | L | The main product work. |
| 6 | Track B extended: Cohorts, Patient data | M | Replicating a proven pattern. |
| 7 | Track A2: structured ACP panel | L | Comfort; A1 already covers the need. |

Batches 1–2 are well-trodden. Batch 3 is the real decision point.

---

## 7. Decisions taken

- **One entity = one skill** — entity named `Skill`, not `SkillCollection`. Keeps the
  catalog/versioning unit aligned; no shared files across skills.
- **`.agents/skills/` by default**, path derived from the selected agent
  (`.claude/skills/` only for Claude Code). Never write a brand directory by default.
- **Agent binaries + local model runtime: documented prerequisite**, with detection
  on page load and an explicit empty state. No bundling, no auto-install.

## 8. Deferred

- **LLM-managed memory** — the copilot has no memory beyond the current
  conversation. `lib/agent/memory.ts` and its `memoryNotes` plumbing were
  deleted rather than left dormant: the UI was already gone, so it was a dead
  path injecting into every prompt. The intended design remains a memory the
  MODEL maintains itself, exposed as an option rather than always on, and it
  starts from scratch when taken up.
  The reason to be careful: in a clinical setting an auto-written memory will
  eventually capture patient detail, and that record outlives the session and is
  re-sent to the model — a remote one included — on every later request. So
  whatever the model writes must stay visible and deletable.
  Note this is NOT the same thing as conversation history, which is built:
  a stored transcript is replayed for the user to read, never re-sent to the
  model as context.
- **Widening beyond plot-builder** — the derived plugin docs are only validated
  against one manifest so far.
- **Other surfaces** — datasets, IDE, script collections share the endpoint
  config but have no assistant panel yet.

## 9. Open questions

1. **Skills workspace-scoped only**, or project-scoped too? (workspace first,
   consistent with SQL collections)
2. **`LINKR_ALLOW_REMOTE_LLM` defaulting to `false`** — confirm? Restrictive, but the
   right default in a health context.
3. Should Track B work in **WASM/static mode** (browser → local LLM directly), or
   server mode only?
