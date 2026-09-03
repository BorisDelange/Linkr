# AI agents — design

**One agent, one sidebar, server mode only.** An external agent binary (OpenCode by
default) supplies the agentic loop, memory and context compaction; Linkr supplies the
UI, the actions and the safety frame. They meet over two open protocols:

- **ACP** (Agent Client Protocol) — the agent streams typed events to our own UI, and
  asks *us* for permission. No TUI, no ANSI parsing.
- **MCP** — how the agent acts: on a running instance (`linkr-live`) and on entity
  trees on disk (`linkr-authoring`).

Mental model: Zed's agent panel, but the tools drive Linkr instead of a code editor.

> **Superseded (2026-09-02).** Earlier revisions of this plan described two separate
> products — a per-page conversational copilot with an in-house agentic loop, and a
> CLI agent in the IDE. Both the split and the in-house loop are dropped; see §10 for
> what was removed and why.

---

## 0. Architecture

```
Sidebar (project-wide) — two render modes: clinician / developer
   │  WebSocket — ACP events relayed
   ▼
FastAPI — subprocess broker
   │  spawn (stdio) ──▶ opencode acp
   │                       │  session/new { mcpServers: [...] }
   │                       ├─ MCP linkr-live      (http + session token)
   │                       ├─ files + shell       (native to the agent)
   │                       └─ skills on disk      .agents/skills/
   └── WS notification ──▶ front store reloads after a write
```

Three action surfaces compose:

| Surface | Source | Reach |
|---|---|---|
| Files + shell | agent-native | write/edit/run code in the project IDE |
| App actions | MCP `linkr-live` | widgets, tabs, cohorts, datasets, filters |
| Offline content | MCP `linkr-authoring` | entity trees on disk (already built) |

### What already exists and gets reused

| Building block | Where | What it gives |
|---|---|---|
| PTY over WebSocket | [execution.py:638](../../apps/api/app/api/v1/routes/execution.py#L638) | the subprocess-broker pattern the ACP relay clones |
| `LlmProvider` + proxy | `models/llm_provider.py`, `routes/llm_proxy.py` | provider config, Fernet-encrypted keys, per-surface approval — **done** |
| Permission catalogue | [permissions.py:26](../../apps/api/app/core/permissions.py#L26) | `"resource:action"`, `require_project_permission` |
| `@linkr/mcp` | [packages/linkr-mcp](../../packages/linkr-mcp) | a working MCP server over `@linkr/format` — becomes `linkr-authoring` |
| Action-based dashboard store | [dashboard-store.ts:31](../../apps/web/src/stores/dashboard-store.ts#L31) | ~25 atomic, id-addressed actions — the tool vocabulary for `linkr-live` |
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

## 2. LLM providers — done, and the safety frame

**Scope: workspace.** `LlmProvider.workspace_id` with `ondelete="CASCADE"`, consistent
with every other entity. Configured by an **admin** (owner), gated on
`llm-config:write`, enforced server-side.

**Status: built.** Model, routes, proxy, settings tab, per-surface approval
(`surfaces`) all exist. What follows is the contract to preserve, not work to do.

### Permissions

```python
"skills": RWD,                    # workspace
"llm-config": ["read", "write"],  # workspace — owner only
"agents": ["read", "execute"],    # project  — use an agent
```

`llm-config:write` (who may enable an LLM) is deliberately separate from
`agents:execute` (who may use one). It must be **explicitly excluded** from
`_catalogue_perms("write")`, the way `_MEMBER_RESOURCES` already excludes membership
writes — otherwise editors inherit it.

### Health data and the remote guardrail

**Decided: the agent may reach health data when the admin has configured a local,
secured provider.** That is the point of the design — a local model behind
`LINKR_ALLOW_REMOTE_LLM=false` means prompts never leave the institution, so there is
no reason to cripple the assistant. The guardrail is the *provider*, not the tool set.

The mechanisms that make that safe, all already built:

- `is_local` **derived server-side** from `base_url` (localhost / 127.0.0.1 / ::1 /
  RFC1918 / no public TLD), never declared by the client.
- Non-local provider creation requires a recorded acknowledgement
  (`acknowledged_by_id`, `acknowledged_at`, `acknowledgement_text`) — an audit trail.
- A permanent red **External API** badge wherever the provider appears, including the
  sidebar header while it is active.
- `LINKR_ALLOW_REMOTE_LLM=false` by default — an institution admin structurally forbids
  egress rather than relying on user discipline. **This is the strongest guarantee in
  the design.**

Corollary that does *not* change: with a **remote** provider approved, dataset rows must
not be sent as context — schema and aggregates only. With a local provider that
restriction is a product choice, not a safety one.

---

## 3. ACP — the client

### Protocol facts (verified 2026-09-02)

| | |
|---|---|
| SDK | **`@agentclientprotocol/sdk`** v1.4.0, Apache-2.0, ~7.1M downloads/week. Use the fluent `client()` API; `ClientSideConnection` is deprecated. |
| Deprecated package | `@zed-industries/agent-client-protocol` — renamed, do not use |
| Version | **Target v1.** v2 is published but *draft*: it removes the client filesystem API, terminal execution and session modes, and changes the prompt lifecycle (`session/prompt` no longer ends the turn). Supporting both means two code paths. |
| Transport | **stdio only.** The streamable-HTTP/WebSocket transport is an RFD, not shipped. |
| Governance | `github.com/agentclientprotocol`, Zed + JetBrains |

### Agent choice

| Agent | ACP | Note |
|---|---|---|
| **OpenCode** | first-party native (`opencode acp`) | **Default.** Open source, any OpenAI-compatible `baseURL`, so Ollama is first-class. |
| Gemini CLI | first-party native | The docs call it the reference implementation. Google-oriented. |
| Goose | first-party, **labeled experimental** by Block | |
| Claude Agent / Codex | adapters | Claude Code the CLI has **no** first-party ACP — the entry is an adapter over the Claude Agent SDK. |

ACP makes this reversible: the client speaks the protocol, not OpenCode. An agent is a
name plus an `argv`. **Ship two presets** (OpenCode + Gemini CLI) to prove the
abstraction holds.

Binaries are a **documented prerequisite**, probed on mount (`opencode --version`) with
an explicit empty state — never a raw `command not found`. No bundling (image bloat for
an optional feature), no auto-install (hospital networks are closed).

### The broker

stdio-only means the agent is a subprocess of its client, and our client is a browser.
So FastAPI brokers: spawn the agent, speak ACP on its pipes, relay events over a
WebSocket. `execution.py` already does exactly this shape for the PTY.

Two traps:

- **stdout is protocol-only.** An agent logging to stdout corrupts the JSON-RPC stream
  irrecoverably, and messages must not contain embedded newlines. Logs go to stderr.
- **`killpg` at teardown** — the same leak already present in `pty_kernel.py`. Fix both.

### Session setup

`session/new` takes an `mcpServers` array (core protocol feature, v1 and v2), with
`stdio` and `http` transports each gated by a capability in the `initialize` response —
check `session.mcp.http` before sending, and degrade if absent.

**This is where the profile is enforced.** A clinician session is handed `linkr-live`
and nothing else: no shell, no file tools. The agent then *cannot* produce code —
an architectural guarantee, not a prompt instruction.

---

## 4. MCP — two servers

Not two versions of one server: two different targets.

| | `linkr-authoring` | `linkr-live` |
|---|---|---|
| Acts on | **files** (entity trees) | a **running instance** |
| Transport | stdio | http + session token |
| Needs | nothing | a server + a session |
| Use | author content offline, seed a portal | drive the open project |
| Status | **built** (rename) | to build |

Merging them would produce a server needing a token for half its tools and a disk path
for the other — incoherent to configure and to document.

### Rename

`@linkr/mcp` stays the npm package; what changes is the **name announced to the MCP
client** ([server.ts:56](../../packages/linkr-mcp/src/server.ts#L56)), since that is what
the agent sees and what prefixes the tools:

- `linkr` → **`linkr-authoring`** (files)
- new: **`linkr-live`** (instance)

Update in the same change: the server `name`, the docs, and the `linkr-authoring` skill
that references it.

### `linkr-live`

HTTP MCP server exposing the app actions, backed by the REST API. Tool vocabulary
derives from the stores — `dashboard-store.ts` is already an id-addressed action API,
so the schema comes out nearly mechanically. First tranche: dashboard (tabs, widgets,
layout, filters), then cohorts, datasets.

**The token carries the session's own rights.** Every tool re-checks its permission
server-side: a user without `dashboards:write` drives an agent that cannot write a
widget. An LLM never exceeds the user driving it.

### Live refresh

The stores are optimistic-write: they mutate local state and push to `getStorage()`
fire-and-forget, and only ever read back at `loadProjectDashboards()`. Nothing listens
to the database, so an agent writing through the API leaves the open tab stale.

Fix: a **notification WebSocket**. After an MCP write the server publishes
`{project_uid, entity}`; the front reloads the affected store. It carries a signal
only — never tool calls — so it stays far simpler than a bidirectional bridge.

---

## 5. The sidebar

Project-wide, not per page: a dashboard request needs datasets, which come from the
pipeline, which comes from the warehouse. One conversation, one history. The tool set
is filtered by the active page, and a `navigate_to` tool lets the agent move.

**A sidebar, not a page** — the agent must not modify a dashboard the user can no
longer see. Watching the change land *is* the control. Resizable (`allotment` is
already a dependency), pattern from `DashboardFilterSidebar.tsx`.

### Two render modes, one event stream

Same ACP events, two verbosity levels. A `name → i18n phrase` table produces the
clinician mode; a tool with no entry falls back to raw. A render component, not a
second application.

**Clinician** — one business-language line per action:

```
┌─────────────────────────────────┐
│ 🤖 Assistant     ⚠️ External API │
├─────────────────────────────────┤
│ Add a mortality-by-age chart    │
│                                 │
│   Reading the patients dataset  │
│   Created "Mortality by age"    │
│   Added to the Demographics tab │
│                                 │
│ The chart is in place.  [Undo]  │
├─────────────────────────────────┤
│ [Ask something…]            [↑] │
└─────────────────────────────────┘
```

**Developer** — the same events expanded: JSON arguments, command output, file diffs,
the full plan. The raw PTY stays available alongside.

### Permissions and undo

`session/request_permission` blocks the agent and renders **our** dialog — the
confirmation UI already exists at
[DashboardAgentSidebar.tsx:622](../../apps/web/src/features/projects/dashboard/agent/DashboardAgentSidebar.tsx#L622)
and is worth salvaging before that file is deleted (§10).

**Decided: script execution is *confirmed*, not free and not forbidden.** An agent that
writes an analysis script may run it, but every execution goes through
`session/request_permission` with the script shown first. ACP is built for this, the
mechanism is already there, and it keeps the usefulness without taking away control.

Per-turn **undo** is still to build: snapshot before the agent's turn, offer "Undo these
changes". No general undo/redo stack — roughly 50 lines.

---

## 6. What the agent cannot do

**Forbidden by design** — and must stay so:

- manage permissions and members (an LLM granting access to health data: risk with no
  upside);
- create or edit an LLM provider (`llm-config:write` stays owner-only);
- delete a project or a workspace;
- push to a git remote;
- read secrets — database passwords are Fernet-encrypted and never returned by the API.

**Never more than the user** — the session token carries the caller's rights, and every
tool re-checks its permission server-side.

**Bounded by protocol or environment** — no browser control (it cannot click the UI for
the user); no network egress when `LINKR_ALLOW_REMOTE_LLM=false`; no operation outside
server mode.

**Allowed, deliberately**: reaching health data, when the admin has configured a local
secured provider (§2).

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
| 1 | `Skill` entity — CRUD, workspace page, export/import, catalog | M | Standalone value, no dependency on the rest. Well-trodden (clone of SQL collections). |
| 2 | Project selection + generated `AGENTS.md` + materialise `.agents/skills/` | S/M | Completes 1, prepares the agent. |
| 3 | MCP `linkr-live` (http, session token, dashboard tools first) + rename the existing one | M | The action surface, testable on its own from any MCP client. |
| 4 | ACP broker in FastAPI (stdio spawn, WS relay, session lifecycle) | L | The heavy piece. `execution.py` is the model. |
| 5 | Sidebar: event rendering, `request_permission`, undo, dual mode | L | The product work. |
| 6 | Notification WS + store reload | S/M | Closes the live loop. |
| 7 | `linkr-live` extended: cohorts, datasets | M | Replicating a proven pattern. |
| 8 | Workspace agent (narrow tools) | M | After, and deliberately limited. |

Batches 1–3 are independently useful and de-risk nothing away; 4–5 are where the real
cost sits.

---

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
| OpenCode (default) | `.agents/skills/` |
| Claude Code | `.claude/skills/` (it reads only this one) |
| others | `.agents/skills/` |

---

## 10. Removed, and why

**The WASM/static assistant is deleted.** `lib/agent/` (in-house loop, dashboard tools,
contexts, conversations, bench) and `DashboardAgentSidebar.tsx` — ~1500 lines with 8
test files and a validated Ollama tool-calling bench.

The reason is not that it failed: it worked, and the spike scored 12/12 on real tasks.
It is that ACP cannot run in WASM (stdio-only transport, a binary to execute, a REST API
that does not exist there), so keeping it would mean maintaining two engines for a
secondary deployment mode, with the static one permanently behind — dashboard only, no
long-term memory.

**Salvage before deleting**: the confirmation and undo UI, the collapsed-tool-line
rendering, and `dashboard-tools.ts` as the tool vocabulary for `linkr-live`.

Consequence to accept: **a static/WASM build has no assistant.** That is a demo or
portal deployment, not a hospital data scientist's workstation.

**Also dropped**: the per-page copilot (replaced by one project-wide sidebar), and the
in-house agentic loop (replaced by the agent binary, which brings memory and context
compaction for free).

**Deferred**: LLM-managed memory. In a clinical setting an auto-written memory
eventually captures patient detail, and that record outlives the session and is re-sent
on every later request. Whatever a model writes must stay visible and deletable. Note
this is *not* conversation history, which the agent handles natively.

---

## 11. Decisions taken

1. **One project-wide sidebar**, not a per-page copilot and not a page.
2. **ACP v1** + `@agentclientprotocol/sdk`, fluent `client()` API. v2 is draft.
3. **OpenCode by default**, agent configurable; Gemini CLI as the second preset.
4. **Two MCP servers**: `linkr-authoring` (files, renamed) and `linkr-live` (instance).
5. **Server mode only.** The WASM assistant is deleted (§10).
6. **Skills workspace-scoped**, project-selected, catalog-publishable.
7. **The clinician profile is defined by the MCP servers passed to `session/new`**, not
   by prompting.
8. **LLM providers are workspace-scoped**, admin-configured, `llm-config:write`
   owner-only. Already built.
9. **Health data is reachable** when the admin configured a local secured provider.
   `LINKR_ALLOW_REMOTE_LLM=false` by default.
10. **Script execution is confirmed** through `session/request_permission`, not free and
    not forbidden.
11. **One entity = one skill**; `.agents/skills/` by default.
12. **Agent binaries: documented prerequisite** with probing, no bundling, no
    auto-install.
