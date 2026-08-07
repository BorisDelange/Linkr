# AI assistant — moving state to the server

Working plan for the in-progress change. Delete this file once every step is
done and the as-built is folded into `docs/architecture.md`.

## Why

Everything the assistant knows lives in `localStorage` today, which breaks three
things: an admin cannot configure a model **for** other people, a bench run made
on the server is invisible to everyone else, and a user loses their conversation
on reload. All three need server storage.

Client-only (WASM) deployments have no backend, so every reader must keep a
localStorage fallback — server when it exists, local otherwise.

## Decisions taken

| What | Where it goes | Why |
|---|---|---|
| Provider (url, model, key, ack) | **Server** | An admin configures for others; the key must never sit in a browser |
| Model approval **per surface** | **Server** | A model can be good at dashboards and poor in the IDE |
| Bench reports | **Server** | An admin benches once, everyone sees the result |
| Chat conversations | **Server, per user** | Users asked to revisit and delete past conversations |
| Panel open/closed | **Server** (user preference) | Follows the user across machines |
| Assistant memory notes | **Dropped** | UI already removed; the model-managed design is deferred |

Chat storage was initially argued against here on the grounds that prompts can
carry clinical context. Two constraints resolve that, and both are requirements,
not options: a conversation is **visible only to its author**, and the user can
**turn saving off** in the assistant's settings. Deleting one conversation and
clearing all of them must both be available.

## Steps

### 1. Backend — providers + bench (in progress)

- [x] `models/llm_provider.py` — add `surfaces: list[str]`
- [x] `models/bench_report.py`
- [x] `schemas/llm_provider.py` — response never carries the API key (`hasApiKey`)
- [x] `core/permissions.py` — `llm-config: [read, write]`, write is owner-only
      via `_OWNER_WRITE_RESOURCES`
- [x] `config.py` — `allow_remote_llm: bool = False`
- [x] `api/v1/routes/llm_providers.py` — provider CRUD + bench report CRUD
- [x] register model + router in `models/__init__.py` and `main.py`
- [ ] **verify the app still boots** (last command failed on an unrelated
      introspection error, not on the routes themselves)
- [ ] alembic migration for `llm_providers` + `llm_bench_reports`
- [ ] tests: `tests/test_llm_providers.py` — key never returned; remote refused
      when `allow_remote_llm=False`; remote refused without acknowledgement;
      editor cannot write, owner can; `surface` filter

### 2. Backend — conversations

- [ ] `models/agent_conversation.py` — workspace_id, project_uid, surface,
      user_id, title, messages (JSON), created_at/updated_at
- [ ] routes: list (own only), get, create/update, delete one, clear all
- [ ] **enforce ownership in the query**, not in the response filter
- [ ] tests: a user cannot read another's conversation

### 3. Backend — panel preferences

- [ ] Reuse the existing user-preferences mechanism if there is one; otherwise a
      small `user_preferences` key/value table. Do NOT invent a second one.

### 4. Frontend

- [ ] `lib/api/llm.ts` — typed client for providers, reports, conversations
- [ ] `lib/agent/settings.ts` — read the server first, fall back to localStorage
      (WASM mode). This file is the single swap point, as noted in its header.
- [ ] `lib/agent/bench/storage.ts` — same treatment
- [ ] `AgentSettingsTab` — provider list, per-surface approval checkboxes, gate
      the whole tab on `llm-config:write`
- [ ] `AgentBenchTab` — reports from the server
- [ ] Dashboard sidebar — model picker limited to providers approved for
      `dashboard`; hide it when only one is approved
- [ ] Conversation history in the sidebar: list, open, delete, clear all, plus a
      "save conversations" toggle
- [ ] `stores/dashboard-panels-store.ts` — server-backed preference

### 5. Cleanup

- [ ] delete `lib/agent/memory.ts`, its test, and the `memoryNotes` plumbing in
      `use-dashboard-agent.ts` / `system-prompt.ts`
- [ ] update `docs/planning/ai-agents-plan.md` (batch 1 done; memory dropped)
- [ ] `npm run test`, `npx tsc -b`, `npx eslint`, `pytest`

## Watch out

- **Never return the API key.** `_to_response` exists so no route can leak it by
  accident; keep serialisation going through it.
- **Two independent gates for a remote model**: the instance switch
  (`LINKR_ALLOW_REMOTE_LLM`) and the per-provider acknowledgement. They protect
  against different things — an institution forbidding egress, and a person
  taking responsibility — so neither replaces the other.
- `is_local` stays **derived server-side** from the URL, never client-declared.
- `EtlPipelineTab.tsx` currently has typecheck errors from a parallel session on
  the shared worktree. Not ours; do not "fix" it, but it does block a production
  build.
