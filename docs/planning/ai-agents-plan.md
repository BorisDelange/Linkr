# AI agents — design

**Linkr exposes its actions; it does not host the chat — yet.** One MCP server,
`linkr`, drives a running instance. Any agent consumes it: Claude Code in a terminal,
LibreChat in the browser tab next to Linkr, an agent in the project IDE's terminal.
Linkr adds the *frame* around those agents — live refresh, UI context, an action log
with undo — not a chat of its own.

> **Revised 2026-09-23.** The 2026-09-02 revision put an ACP broker + OpenCode sidebar
> at the centre. It is now one option among three for a later, *optional* embedded
> chat (§5), decided after a proof of concept and real use of LibreChat beside Linkr.
> What moved and why: §0. Earlier history (per-page copilot, in-house loop): §10.

---

## 0. Four layers, three settled

| Layer | Decision | Status |
|---|---|---|
| **1. Actions** | MCP server `linkr` on a running instance, cohorts first (§4) | ✅ building |
| **2. Frame in Linkr** | notification WS + store reload, `get_ui_context`, action log + per-turn undo (§4c) | ✅ settled, client-agnostic |
| **3. Approval** | in the **client** (LibreChat `toolApproval`, Claude Code permissions), steered by MCP tool annotations (§4b) | ✅ settled |
| **4. Chat surface** | external for now: Claude Code, then LibreChat in a tab beside Linkr | 🤔 embedded chat open (§5) |

Only what is useful whatever layer 4 becomes is built now. Reasons for the reorder:

- **The MCP is the invariant.** OpenCode over ACP, a server-side loop, LibreChat or
  Claude Desktop all call the same tools. It is the one investment never thrown away.
- **ACP only exists to render an agent inside our UI.** Judging whether an agent can
  build a cohort needs a terminal, not a sidebar.
- **Tool design and model capability fail differently.** The proof of concept runs
  the same tasks with a strong reference (Claude Code) and a small open model: if
  the reference fails, the tools are wrong; if only the small model fails, it is the
  model.
- **Chat UIs are a commodity.** History, model choice, providers, quotas, MCP and
  skill management are what LibreChat / Open WebUI already do, and hospitals deploy
  them. What is *not* a commodity is the situated context, the live view and the
  undo — layer 2, which serves every client.
- **The data scientist already has an agent in the app**: the project IDE has a
  terminal; `claude` or `opencode` run there with the `linkr` MCP configured — code
  and app actions, no ACP needed.

### What already exists and gets reused

| Building block | Where | What it gives |
|---|---|---|
| PTY over WebSocket | [execution.py:638](../../apps/api/app/api/v1/routes/execution.py#L638) | an agent CLI runs in the IDE terminal today; also the broker pattern if ACP is ever chosen |
| Permission catalogue | [permissions.py:26](../../apps/api/app/core/permissions.py#L26) | `"resource:action"`, `require_project_permission` |
| `@linkr/mcp` | [packages/linkr-mcp](../../packages/linkr-mcp) | now the `linkr` live server only; the files server `linkr-files` is deleted (§4) |
| Action-based dashboard store | [dashboard-store.ts:31](../../apps/web/src/stores/dashboard-store.ts#L31) | ~25 atomic, id-addressed actions — the tool vocabulary for `linkr` |
| Pure TS query builders | [cohort-query.ts](../../apps/web/src/lib/duckdb/cohort-query.ts), [concept-queries.ts](../../apps/web/src/features/projects/warehouse/concepts/concept-queries.ts) | imported as-is by the MCP (no Python port) |
| "File collection" entity | `SqlScriptCollection` / `SqlScriptFile` | the exact pattern to clone for Skills |
| Path-keyed versioned tree | [entity-tree.ts](../../apps/web/src/lib/entity-tree.ts) | `_tree.json` keyed by path — git-friendly, no id churn |

---

## 1. Skills entity (workspace-scoped)

A skill is a folder with `SKILL.md` plus optional files — the agentskills.io open
standard, read by OpenCode, Claude Code, Codex, Cursor and 20+ others. No runtime, no
build step. **Do not invent a format.**

Value is not tied to Linkr's own agent: a skill published to the catalog ("how to map
an OMOP concept in Linkr") is read by any harness, on anyone's machine. This is the
highest-leverage, lowest-risk piece of the whole plan.

### Model — a strict clone of SQL collections

**One entity = one skill** (one folder with its `SKILL.md`), so the entity is `Skill`,
not `SkillCollection`. That keeps 1 entity = 1 publishable/installable catalog unit
with its own semver `version` and `lineage_id`, consistent with the other exportables.

- `Skill` — workspace_id, entity_id, name/description LocalizedString,
  git_remote_config, version, created_by*, organization, lineage_id, parent_lineage_id
- `SkillFile` — id, skill_id, name, type (`file` | `folder`), parent_id, content, order

Consequence to accept: no files shared between skills. The standard pushes towards
self-contained skills anyway. A "skill pack" is a workspace.

### Implementation checklist

**Backend** — `models/skill.py`, `schemas/skill.py`, `api/v1/routes/skills.py` (the
same 10 routes as [sql_scripts.py](../../apps/api/app/api/v1/routes/sql_scripts.py)),
alembic migration, router registration.

**Frontend** — `stores/skills-store.ts`, `lib/api/skills.ts`, pages under
`features/warehouse/skills/` following `features/warehouse/sql-scripts/`, sidebar
entry, i18n EN+FR.

**Cross-cutting** — `entity-io.ts` export/import + `_tree.json`, golden test
`skill-export-golden.test.ts`, seed loader + manifest, catalog (`type: "skill"`),
versioning / git-link.

**Permissions** — add `"skills": RWD` to `WORKSPACE_CATALOGUE`.

Validate `SKILL.md` (frontmatter present, `name`/`description` non-empty) and surface
the result in the list — an invalid skill is silently ignored by agents, which is
painful to diagnose.

### 1b. Project selection

Skills are authored at the **workspace**; a **project picks** which it uses. The picked
set is materialised into the project's IDE working directory (§4), and **travels with
the project export as references, not copies** — a copy would fork the skill and defeat
workspace authoring. A missing referenced skill on import is flagged ("missing skills"
state) and offered from the catalog, never a hard failure.

### 1c. `AGENTS.md` is not a Skill

- **`SKILL.md`** — one folder = one capability, shareable, versionable, publishable.
- **`AGENTS.md`** — a single file describing *this project* to any agent. A property of
  the project, not a catalog entity.

So `AGENTS.md` is **generated** per project from its metadata (name, description,
datasets, schema mapping, IDE paths), with a user-editable override.

---

## 2. Models and the safety frame — in the client

**Linkr configures no model.** The workspace LLM providers (Fernet keys, derived
`is_local`, per-surface approval, `LINKR_ALLOW_REMOTE_LLM`) were built for the in-app
assistant and deleted with it: their only caller was gone. The client that runs the
agent (LibreChat, Claude Code) holds the model and its keys.

Consequence to keep in mind: **whether prompts leave the institution is now decided by
the client's configuration**, not structurally by Linkr. An institution that must
forbid egress does it in its LibreChat deployment (local models only). Linkr's own
guarantees are unchanged: the agent never does more than the user whose credentials it
holds, and every tool re-checks permissions server-side.

Rule for tests and demos: with a remote model, open or synthetic data only (MIMIC-IV
Demo), never credentialed or clinical databases. With a remote model, dataset rows
should not be sent as context — schema and aggregates only.

If an embedded chat ever needs a server-side model again (§5 option b), provider config
comes back from git history (migration `e5f6a7b8c9d0`, dropped by `bd2a370a8c3a`).

---

## 3. ACP — a deferred option, not the plan

Kept as option (c) for an embedded chat (§5). Nothing here is scheduled. The facts
below were verified on 2026-09-02 and must be re-checked before use.

| | |
|---|---|
| SDK | `@agentclientprotocol/sdk` (fluent `client()` API; `ClientSideConnection` deprecated; `@zed-industries/agent-client-protocol` is the old name) |
| Version | v1 stable; v2 draft (drops client fs, terminals, session modes) |
| Transport | **stdio only** → the agent is a subprocess of a FastAPI broker relaying over WS |
| Agents | OpenCode (`opencode acp`, native), Gemini CLI (native), Goose (experimental), Claude/Codex via adapters |
| Traps | stdout is protocol-only (logs to stderr); `killpg` at teardown (same leak as `pty_kernel.py`) |
| Profile | `session/new { mcpServers }` — a clinician session gets `linkr` and nothing else: no shell, no files |

Why it lost its central place: OpenCode is a *coding* agent whose long, code-oriented
system prompt can distract a small model handed only business tools, and ACP is a
second protocol to maintain for what LibreChat already renders. Its real asset — a
typed event stream with `session/request_permission` — matters only if we render the
chat ourselves.

---

## 4. MCP — one server, `linkr`

HTTP-capable MCP server driving a **running instance** through its REST API, written
in **TypeScript**, in the existing `@linkr/mcp` package.

### Why TypeScript

Linkr's business logic lives in the front: the cohort SQL compiler, OMOP/concept
queries, the dashboard store's ~25 actions, widget config, DQ checks, `@linkr/format`
and its validator. The backend stores (CRUD) and executes (SQL, ETL, git, IDE). A TS
MCP imports that logic unchanged and calls REST for storage and execution — and REST
re-checks the caller's permissions. A Python MCP would mean porting it: duplication.

Cost to accept: the API image (`rocker/r-ver`) has no Node. In production the server
runs as a third container (`node:22-alpine`) reverse-proxied by the web nginx at
`/mcp`. Irrelevant for the proof of concept (stdio, local).

### One server; the files one goes

Once an agent can act on the app, content is created *in* the app and exported or
versioned with the existing features. Offline file authoring loses its reasons: a
demo project or a `linkr-public-content` repo can go through a running instance;
CI validation is `@linkr/format`, not the MCP. So:

- **one package `@linkr/mcp`**, split into `src/live/` (new) and `src/files/` (today's
  code);
- **the live server takes the final name `linkr`** now — it is what the agent sees
  and what prefixes the tools (`mcp__linkr__…`);
- **the files server is announced as `linkr-files`** meanwhile (and the
  `linkr-authoring` skill updated);
- **`src/files/` is deleted** (done, with the `linkr-authoring` and `create-project`
  skills): project creation from outside Linkr goes, until `linkr` gains it.

### A public interface

Consumed by clients we do not control — Claude Code, LibreChat, Claude Desktop,
Cursor, an agent in the IDE terminal. Hence:

- **Self-contained**: auth, discovery and errors hold on their own.
- **Tool descriptions written for a stranger**: the model knows nothing of Linkr —
  say what a project, a cohort, a schema mapping are.
- **Explicit ids everywhere.** Tools take the project / cohort / tab they act on, and
  can act on any of them, not only what the user is looking at. `get_ui_context`
  (§4c) only supplies *defaults* — "add an age > 50 criterion" means the open cohort
  of the open project; nothing open or ambiguous → the agent asks.
- **Annotated**: `readOnlyHint` on reads, `destructiveHint` on deletes, so clients
  auto-approve reads and ask only for writes (§4b).
- **The token carries the caller's own rights.** REST re-checks every permission: an
  LLM never exceeds the user driving it.

### Proof of concept — cohorts (2026-09-23)

stdio, auth by the user's own session token, driven from Claude Code first. Tools:

| Step | Tools |
|---|---|
| Context | `list_projects`, `get_project_context` (project, linked databases, schema mapping in plain words) |
| Explore | `describe_database`, `search_concepts` (with record/patient counts), `run_sql` (read-only, row-capped) |
| Cohort | `list_cohorts`, `get_cohort`, `create_cohort`, `set_cohort_criteria` (typed tree, validated) |
| Iterate | `preview_cohort_sql`, `run_cohort` (count + attrition), `set_cohort_custom_sql` |

Bench: 5–6 tasks on MIMIC-IV demo with expected counts computed beforehand; per run,
success, tool calls, errors. Same bench on a small open model (OpenCode + an
OpenRouter free model) afterwards. **Only open/synthetic data on free endpoints** —
they may log prompts.

Out of the PoC: live refresh (reload the tab), `ApiToken`, HTTP transport.

---

## 4b. Third-party clients, approval and auth

The reference case: an institution already running **LibreChat** over its warehouse
(Jira, GitLab, ClickHouse, Grafana) wants Linkr in the same row. Nothing is built for
LibreChat: it consumes `linkr` like any MCP client. We do not host it (a full app +
MongoDB, auth duplicating ours) — it is a deployment *beside* Linkr.

### Approval lives in the client

LibreChat has tool approval (`endpoints.agents.toolApproval` in `librechat.yaml`:
ask / allow / deny by glob, since the human-in-the-loop runtime); Claude Code has its
permission prompts. Approving where the conversation happens is the right place —
pushing confirmations into the Linkr tab would interrupt a user busy elsewhere.

Linkr's part: **tool annotations** so the client can tell reads from writes, and
**an action log + per-turn undo** in the tab (§4c) — visible, never blocking. For a
client without approval: tokens read-only by default, write only when the token says
so.

### Authentication

A third-party client holds a long-lived credential in its own config:

```yaml
mcpServers:
  linkr:
    type: streamable-http
    url: https://linkr.chu-xxx.fr/mcp
    headers:
      Authorization: "Bearer ${LINKR_TOKEN}"
```

So `linkr` needs an **`ApiToken` entity** — created by the user in their settings,
scoped to one project, expiring, revocable in one click, last-used-at. **Per-user,
not a shared service token**: a global token makes every user act as one identity,
losing traceability and §6's "never more than the user". Chat clients support
per-user variables. OAuth 2.1 only if an institution asks.

---

## 4c. The frame in Linkr — for every client

What makes an external agent usable next to the app. None of it depends on layer 4.

- **Live refresh.** Stores are optimistic-write and never read back after load, so an
  agent writing through REST leaves the tab stale. A **notification WebSocket**: after
  a write the server publishes `{project_uid, entity}`, the front reloads that store.
  Signal only, never tool calls. Keys off the write reaching REST, so it works for any
  client. **Never reload a store whose editor is open and dirty** — surface the change
  instead.
- **UI context.** The open tab publishes where the user is (project, page, selected
  cohort / dashboard tab) to the server; `get_ui_context` returns it. It resolves
  "this cohort", "here" — defaults, never a restriction (§4).
- **Action log + per-turn undo.** Every write through the MCP is logged with its
  author and turn; the tab shows it and offers "Undo these changes" (snapshot before
  the turn). Visible, not blocking.
- **Notification centre** (asked 2026-09-23) — where the log surfaces: a bell in the
  header, next to the user button, with an unread badge. One line per write — *"Cohort
  'Adults with lactate > 2' added by MCP · 2 min ago"* — clicking it opens the entity;
  the list can be cleared. Fed by the same notification WebSocket as live refresh, and
  persisted server-side so a write made while the tab was closed still shows on return.

---

## 5. An embedded chat — open, decided later

**For now: LibreChat in a tab beside Linkr.** Whether a chat *inside* Linkr is worth
it is decided after the PoC and some days of real side-by-side use. An embedded chat
earns its place only by what a separate tab cannot give: clickable results that open
the cohort, embedded previews, or users with no LibreChat deployed.

| Option | How | For | Against |
|---|---|---|---|
| **(a) Linkr UI over LibreChat's Agents API** — *kept in mind* | Linkr renders the chat; LibreChat runs the agent (`/api/agents/v1/chat/completions` or `/responses`, per-user API keys; conversations also show in LibreChat) | no loop to write; MCP, skills, models, quotas managed in one existing tool | API in **beta**; hard dependency on a LibreChat deployment; approval through the API unclear |
| (b) Light server loop | FastAPI loop calling the same MCP (provider config to restore, §2) | no external dependency; situated natively | a loop + chat UI to maintain |
| (c) ACP + OpenCode | §3 | files, shell, typed events | the heaviest; coding-oriented agent |

Whatever the option, the UI notes stand: project-wide sidebar (not per page),
clinician mode (one business-language line per tool call, via a `name → i18n phrase`
table) vs developer mode (arguments, output, diffs), and the confirm/undo UI of the
deleted `DashboardAgentSidebar.tsx` (§10; git history at commit `4a1681fd`, around line
622). Script execution by an agent stays **confirmed**.

---

## 6. What the agent cannot do

**Forbidden by design** — and must stay so:

- manage permissions and members (an LLM granting access to health data: risk with no
  upside);
- delete a project or a workspace;
- push to a git remote;
- read secrets — database passwords are Fernet-encrypted and never returned by the API.

**Never more than the user** — the session token carries the caller's rights, and every
tool re-checks its permission server-side.

**Bounded by protocol or environment** — no browser control (it cannot click the UI for
the user); no operation outside server mode.

**Allowed, deliberately**: reaching health data the user can reach — which model sees
it is the client's configuration (§2).

---

## 7. Workspace agent — deliberately narrow

Same engine, different tool set. Not symmetric with the project agent: workspace
actions are administrative (create a project, install from the catalog, describe the
workspace), rarer and far more sensitive.

Ship it **after** the project agent, with a narrow tool set, and **never** permissions
or members.

---

## 8. Order

| # | Batch | Effort | Why here |
|---|---|---|---|
| 1 | **PoC**: `linkr` MCP, cohort tools, stdio, session token; bench from Claude Code | M | Tests the whole idea at the lowest cost; the tools survive whatever follows. |
| 2 | Same bench with a small open model (OpenCode + OpenRouter free) | S | Separates tool-design faults from model limits. |
| 3 | Split `@linkr/mcp` into `live/` + `files/`, announce `linkr-files` | S | Frees the final name; files server deleted once live covers it. |
| 4 | Frame: notification WS + store reload, notification centre (header bell), `get_ui_context`, action log + per-turn undo | M | Serves every client; what makes a tab-beside-tab agent usable. |
| 5 | HTTP transport + `ApiToken` + tool annotations → LibreChat installed locally beside Linkr | M | The target setup for now. |
| 6 | `linkr` extended: dashboards (salvage `dashboard-tools.ts`), datasets | M | Replicating a proven pattern. |
| 7 | `Skill` entity + project selection + `AGENTS.md` + `.agents/skills/` | M | Useful to any harness, incl. LibreChat skills and the IDE terminal. |
| 8 | Embedded chat (§5) — only if real use shows the need | L | Decided on evidence, option (a) first in line. |
| 9 | Workspace agent (narrow tools) | M | After, and deliberately limited. |

## 9. Skills materialised on disk

An explicit re-sync action writes the project's selected skills into its IDE working
directory. The tree is **generated** from the Skill entity (the database stays the
source of truth) and gitignored.

**`.agents/skills/<name>/` is the default** — the vendor-neutral path, which OpenCode
resolves exactly like the others. Writing a competitor's brand directory by default
would make Linkr a carrier of one vendor's convention, against the "local and open
first" priority.

| Agent | Directory |
|---|---|
| OpenCode, Codex, others | `.agents/skills/` |
| Claude Code | `.claude/skills/` (it reads only this one) |

---

## 10. Removed, and why

**The WASM/static assistant is deleted.** `lib/agent/` (in-house loop, dashboard tools,
contexts, conversations, bench) and `DashboardAgentSidebar.tsx` — ~1500 lines with 8
test files and a validated Ollama tool-calling bench.

The reason is not that it failed: it worked, and the spike scored 12/12 on real tasks.
It is that the agent now acts through the `linkr` MCP over the REST API, which does not
exist in WASM, so keeping it would mean maintaining two engines for a secondary
deployment mode, with the static one permanently behind — dashboard only, no long-term
memory.

**Salvage before deleting**: the confirmation and undo UI, the collapsed-tool-line
rendering, and `dashboard-tools.ts` as the tool vocabulary for `linkr`.

Consequence to accept: **a static/WASM build has no assistant.** That is a demo or
portal deployment, not a hospital data scientist's workstation.

**Also dropped**: the per-page copilot (a future embedded chat, if any, is one
project-wide sidebar), and the in-house *client-side* loop (the loop belongs to the
client — LibreChat, Claude Code — or, in option (b), to the server).

**Deferred**: LLM-managed memory. In a clinical setting an auto-written memory
eventually captures patient detail, and that record outlives the session and is re-sent
on every later request. Whatever a model writes must stay visible and deletable. Note
this is *not* conversation history, which the agent handles natively.

---

## 11. Decisions taken

Revised 2026-09-23; the 2026-09-02 list (ACP-centred) is replaced, not appended to.

1. **MCP first; the chat surface is external for now** — Claude Code, then LibreChat in
   a tab beside Linkr (§0).
2. **One MCP server `linkr`** (instance, TypeScript, in `@linkr/mcp`, reusing the front's
   pure query builders). The files server `linkr-files` is deleted (§4).
3. **Tools take explicit ids** and may act anywhere; `get_ui_context` only supplies
   defaults (§4, §4c).
4. **Approval lives in the client**, steered by `readOnlyHint` / `destructiveHint`; the
   Linkr tab shows an action log with per-turn undo, never a blocking dialog (§4b).
5. **The frame is client-agnostic**: live refresh, UI context, action log (§4c).
6. **Embedded chat decided on evidence** (PoC + side-by-side use); option (a), Linkr UI
   over LibreChat's Agents API, is first in line (§5).
7. **ACP + OpenCode is a deferred option**, not the plan (§3).
8. **Server mode only.** The WASM assistant is deleted (§10).
9. **Skills workspace-scoped**, project-selected, catalog-publishable; one entity = one
   skill; `.agents/skills/` by default.
10. **Linkr configures no model**; the client does. Provider config deleted (§2).
11. **Health data is reachable** within the user's rights; egress is governed by the
    client's model choice. Free remote endpoints: open/synthetic data only.
12. **Script execution by an agent is confirmed**, not free and not forbidden.
13. **`linkr` is a public interface**; LibreChat and the like are consumers, never
    hosted by us.
14. **Per-user `ApiToken`, scoped to one project**; OAuth 2.1 only on demand.
15. **For a client without approval**, tokens are read-only by default.
