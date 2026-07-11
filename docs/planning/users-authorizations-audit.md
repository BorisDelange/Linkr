# Audit — Users & Authorizations (server / full-stack mode)

> **Update 2026-07-10 — all fixes are implemented and committed** (branch
> `feature/fastapi-backend`). See the "Implementation state" section at the end of the doc.
> To be tested in server mode before merge.

---

## ⏳ TODO — to do before considering the effort complete

### 1. 🔴 Review the permission MODEL (product decision — to be validated by the PO)
**Not reviewed for now.** The current catalog was built incrementally
during implementation; the product owner must **validate it end to end**:
- **Which permission blocks we actually want** (resources × actions), and at what level
  (global / workspace / project). The current breakdown (see "Implementation state"
  → catalog) is a proposal, not a settled decision.
- **Which default roles** and which permissions each has (viewer/editor/owner +
  global admin) — review the matrix, in particular: who should be able to execute code,
  manage organizations, query the application database, manage members.
- **Granularity**: do we keep the "role" grain (viewer<editor<owner) or move
  to fine grain per resource on some surfaces?
- **Edge cases**: shared resources/directories (organizations = open read,
  decided); project role `none` (hide a project); workspace→project inheritance.
→ **Nothing should be considered final until the PO has reviewed this model.**

### 2. Finish + verify the UI GATING
- **Verify** in server mode all the gating already in place (settings, warehouse/lab
  list features, datasets, dashboards, wiki, projects, databases) with
  viewer / editor / owner / non-member accounts.
- **Remaining ungated UI surfaces** (backend already protected — UI comfort only):
  concept-mapping (bulk-delete concept sets, delete import batch, edit mapping
  project, comments/approve, source-ID ranges), DQ checks editor (create/save),
  catalog config (age brackets, anonymization), SQL scripts editor (create/save
  file), pipeline (add/remove node/edge/script), summary (README, tasks,
  attachments), patient-data widgets (add/edit/settings), dashboards detail
  (toggle edit, add widget, settings, tabs), IDE files (create/rename/upload),
  wiki (per-node context menu: create child/rename/delete, metadata/attachments).
  Full mapping: see the inventory produced on 2026-07-10.
- **Reminder**: UI gating is only cosmetic — the real enforcement is server-side
  (403). To be (re)prioritized once the permission model is validated (point 1), because
  some gates will change if the catalog changes.

---

## 📋 Permissions catalog — VALIDATED + IMPLEMENTED (2026-07-11)

> **Validated by the PO on 2026-07-11 and implemented** (backend `permissions.py`,
> migration `4d744166dce4`, UI `RolesTab.tsx`). PO decisions on the open points:
> `reports` added (locked, stub); `databases` (workspace) + `project-databases`
> (project) = two resources; `concepts` (project) = `read` only; **no dedicated
> actions** (test/build/export) → everything in `read/write/delete`, only `ide` adds
> `execute`. `code-execution` removed → `ide:execute` (renamed by the migration).

> Rebuilt from the app's actual capabilities (sidebar + features +
> routes). **Three tiers**: Global / Workspace / Project. We keep the "role" grain
> (viewer < editor < owner) + global admin super-admin. The workspace→project inheritance
> is kept; a `project_members` override can refine per project.
>
> Convention: most resources have `read / write / delete`. The
> marked resources have **non-standard** actions (e.g. `execute`). Resources
> marked **[N]** are new (to be added to the backend + migration).

### GLOBAL Tier ("Global" tab)
Instance-wide management, from Home / Settings.

| Resource | Actions | Note |
|---|---|---|
| `workspaces` | **write** | **write = CREATE** a workspace (Home); the creator becomes its owner. Edit/delete = via membership (owner → `workspace-settings`) or `all-workspaces`. |
| `users` | read / write / delete | User accounts. |
| `roles` | read / write / delete | Roles & permissions. |
| `organizations` | read / write / delete | Organizations directory (read open to all, decided). |
| `app-database` | read / write / delete | SQL on the application database (sensitive — admin-tier). |
| `all-workspaces` | read / write / delete | Cross-cutting grant: access to ALL workspaces without being a member. |
| `all-projects` | read / write / delete | Cross-cutting grant: access to ALL projects without being a member. |

### WORKSPACE Tier — "Workspace" section (sidebar order)
Workspace-scoped data. Inherited by the workspace's projects.

| # | Resource | Actions | Note |
|---|---|---|---|
| 1 | `workspace-settings` | read / write / delete | Manage THIS workspace: edit (write) / delete (delete). Name distinct from the global `workspaces` (= create) — no collision. |
| 2 | `workspace-members` | read / write / delete | Workspace members (2nd position). |
| 3 | `workspace-summary` | read / write | Workspace home: overview + README. |
| 4 | `projects` | read / write / delete | Create / manage the workspace's projects. |
| 5 | `wiki` | read / write / delete | Pages + attachments. |
| 6 | `plugins` | read / write / delete | Install / edit the code / test a plugin. |
| 7 | `schemas` | read / write / delete | Schema presets (upsert + delete; no pure create). |
| 8 | `databases` | read / write / delete | DB connections: create, test/retest, query, refresh-cache, edit, delete. |
| 9 | `concept-mapping` | read / write / delete | Mapping projects + concept sets: import, map, build table, export. |
| 10 | `sql-scripts` | read / write / delete | SQL collections + files (run = client-side against a source). |
| 11 | `data-quality` | read / write / delete | Rule sets + checks (run + results = client-side). |
| 12 | `catalog` | read / write / delete | Data catalog: config, anonymization, DCAT export. |
| 13 | `etl` | read / write / delete | ETL pipelines + files (build/run = client-side). |

### WORKSPACE Tier — "Project" section (sidebar order)
These permissions apply **inside** a project (via inheritance / the project override).

| # | Resource | Actions | Note |
|---|---|---|---|
| 1 | `project-members` | read / write / delete | Per-project role overrides (2nd position). |
| 2 | `project-summary` | read / write | README + tasks + attachments (no dedicated delete). |
| 3 | `ide` | read / write / delete + **execute** | IDE files + connections + **R/Python/SQL execution** (replaces `code-execution`). |
| 4 | `pipeline` | read / write / delete | Project pipeline graph editor. |
| 5 | `project-databases` | read / write | Link/unlink + test/reconnect/disconnect a workspace source (no delete: does not remove the connection). |
| 6 | `concepts` | **read** | Browse the active source's concept dictionary (read-only). |
| 7 | `cohorts` | read / write / delete | Builder + SQL generation + run + results. |
| 8 | `patient-data` | read / write / delete | Tabs + widgets of the patient record (project layout). |
| 9 | `datasets` | read / write / delete | Import/reimport/duplicate/edit/query + analyses. |
| 10 | `dashboards` | read / write / delete | Tabs + widgets + export. |
| 11 | `reports` | read / write / delete | ⚠️ **Stub** ("coming soon" page) — locked, reserved. |

### Deleting / creating a workspace — recap
- **Create**: `workspaces:write` (global). Default: only `admin`. The `user` role does
  not have it → to be granted explicitly.
- **Edit**: `workspace-settings:write` (workspace owner/editor) or `all-workspaces:write`.
- **Delete**: `workspace-settings:delete` (workspace owner) or `all-workspaces:delete` or admin.
- Intentional name overlap: `workspaces:write` (global, create) ≠ `workspace-settings:write` (workspace, edit) — distinct strings.

### Points to settle (PO)
1. `reports` = stub: do we add it anyway (locked) or wait for the real page?
2. Dedicated actions `test` / `build` / `export`: useful, or do we simplify to
   read/write/delete + `execute` only for the IDE?
3. `concepts` project read-only: OK? (no CRUD on the project side today).
4. `summary` without `delete`: OK? (we don't delete the summary page).

---

> Audit of 2026-07-09, branch `feature/fastapi-backend`. Answers: "is it
> effective, on the UI **and** server side, to prevent unauthorized access?" and
> "are any permissions missing, notably for the SQL query on the application database?".

## TL;DR

- **Server = solid on 90% of the surfaces.** The roles/permissions system
  (`app/core/permissions.py`) is real and wired in: each CRUD route resolves the
  resource then checks the workspace/project role (viewer < editor < owner;
  global admin = super-admin). Cohorts, datasets, data sources, SQL scripts,
  wiki, pipelines, ETL, DQ, concept sets, catalogs, mappings, users, roles,
  workspaces, projects, **the SQL query on the application database** — all guarded.
- **UI = almost blind to authorization.** The frontend only knows the **global**
  role (`admin`/`user`) and **uses it nowhere** to hide/disable.
  No `hasPermission()`, no route guard by role. Any logged-in
  user **sees** everything (Settings, Users, Roles, application-database SQL tool,
  a viewer's edit/delete buttons). Security holds **only** because the
  backend returns 403 — poor UX and a fragile posture.
- **3 real server flaws** (privilege escalation), to fix.
- **Missing permissions in the catalog**: nothing for code execution (IDE /
  Python / R / terminal) nor for the SQL query on the application database (today
  the latter is `admin`-only, hardcoded, not going through the catalog).

---

## 1. What is effective on the server side (good)

Catalog: `RESOURCES × ACTIONS` (read/write/delete) + global `users/roles/settings`.
Enforcement via `check_workspace_role` / `has_permission` / `require_*`.

| Surface | Guard | Verdict |
|---|---|---|
| workspaces / projects | `require_workspace_role` / `require_project_role` | ✅ |
| cohorts, datasets, dataset_files | `_require_project_access` (viewer read / editor write+delete) | ✅ |
| data_sources (+ `/query` external SQL) | `_load_source` viewer/editor | ✅ |
| sql_scripts, pipelines, etl, dq, concept_sets, catalogs, mappings, source_concept_ids | `check_workspace_role` | ✅ |
| wiki, schema_presets, ide_connections, ide_files | same | ✅ |
| users, roles | `get_current_admin` | ✅ |
| **application database `/database/query` + `/schema`** | `get_current_admin` + read-only (single SELECT + rollback) | ✅ |
| execution `/execute` (with project), `/kernels`, `/restart`, WS `/terminal` | project role (editor to execute) | ✅ |

The list endpoints filter out non-visible workspaces (`list_for_user`) → no
inter-workspace leak.

---

## 2. Server flaws to fix (prioritized)

### 🔴 P1 — Code execution without project context = authenticated RCE
`app/api/v1/routes/execution.py:99` — `POST /execute` checks the project role
**only if `body.project_uid` is present**. Without `project_uid`, we fall straight through
to `runtime.run_python` / `run_r`: **any logged-in user** (even a
global `user` with no workspace membership at all) executes arbitrary Python/R
on the server. The only safeguard: the `enable_code_execution` flag (default `True`).
→ **Fix**: require a project context + `editor` role for any execution, or
gate context-less execution behind an explicit permission (cf. §4).

### 🟠 P2 — WS terminal: SQL connection not guarded by the workspace
`execution.py:171-184` (`_make_ws_resolver`) loads the data source by
`connectionId` **without** `check_workspace_role`, unlike the HTTP path
(`_require_connection_access`, l:42-52). An editor of project A can pass
`?connectionId=<source of workspace B>` and query it.
Note: currently **masked** by a bug (§3) that breaks `sql_query()`, but to be
fixed together with it.

### 🟠 P3 — Global plugins editable by everyone
`app/api/v1/routes/user_plugins.py` — `_check_access` is a **no-op when
`workspace_id is None`**. Any logged-in user can create/edit/delete a
**global** plugin (= instance-wide, executable code). Escalation via a shared surface.

### 🟡 Minor
- `organizations.py:17-43` — reading/enumerating **all** organizations
  by any logged-in user (even though the resource is in the catalog). Read-only.
- `data_sources.py:93` `test-connection` — outbound connection to an
  arbitrary host from the body, `get_current_user` only (SSRF flavor, no persistence).
- `setup.py` `GET /setup/db-info` — engine + DB host/path exposed **without auth**.
- Cross-cutting pattern: **any `workspace_id IS NULL` resource** (data sources,
  plugins, schema presets, unassigned projects) is world-accessible to
  authenticated users — coherent by design, but it's the soft spot (P1–P3 live there).

---

## 3. Latent bug (to fix with P2)
`execution.py:116` and `:182` call `data_source_service.query(source, sql)`
while the signature is `query(db, source, sql)` (`data_source_service.py:197`).
→ `sql_query()` from a kernel/terminal raises a `TypeError`. Functionality
broken today.

---

## 4. Missing permissions in the catalog

The catalog (`RESOURCES`/`GLOBAL_RESOURCES`) does **not** cover the
new/sensitive capabilities:

- **Code execution** (IDE, Python/R, kernels, terminal) — today handled by
  the `editor` role on the project, without a dedicated permission. A hospital will
  probably want to distinguish "can view datasets" from "can execute server code".
- **SQL query on the application database** — today `admin`-only, **hardcoded**
  (`get_current_admin`), outside the catalog. To be exposed as an explicit global
  permission (`settings:*` or new `app-database:read`) if we ever want to delegate it.
- **Terminal / server shell** (PTY bash) — same remark as execution: very
  powerful access (a shell in the project folder), deserves its own permission.

Proposed additions (to be validated):
- `RESOURCES += ["pipelines", "etl", "sql", "code-execution"]` (align the
  catalog with the real entities — several are guarded by role without a named
  permission).
- `GLOBAL_RESOURCES += ["app-database"]` for the app database SQL query.

---

## 5. UI — almost no authorization barrier

- `AuthUser` (`stores/auth-store.ts:4-10`) only exposes a global `role: string`,
  **never read** to gate. No permission list on the client side.
- No route guard by role (`app/App.tsx`), Settings/Users/Roles/app database SQL tool
  visible to **every** logged-in user (only `isServerMode()` conditions them —
  a capability, not an authorization).
- A **viewer** sees create/edit/delete buttons everywhere (cohorts, datasets,
  connections, mappings…). The backend blocks (403) but the UX is misleading.
- No workspace member management screen (assigning viewer/editor/owner).

**Missing primitive**: have `GET /auth/me` return the effective permissions
+ the per-workspace role, then introduce `hasPermission()` / `useCan()`
+ a `RequireRole` wrapper to gate the `/settings` route, the admin tabs,
the app database SQL tool, and the edit/delete controls.

---

## Recommended order
1. **P1** (context-less execution) — the most serious, authenticated RCE.
2. **P2 + bug §3** (WS terminal + `query` signature).
3. **P3** (global plugins).
4. **Catalog** (§4): add the code-execution + app-database permissions.
5. **UI** (§5): expose permissions in `/auth/me`, `hasPermission` helper,
   gate Settings/admin/SQL tool + edit/delete controls.
6. Minor (organizations, db-info, test-connection).

---

## Implementation state (2026-07-10)

Delivered in 6 batches committed on `feature/fastapi-backend`. 248 backend tests green.

| Batch | Content | Commit |
|---|---|---|
| **0** | P1 (`/execute` requires project + editor), P2 (WS terminal connection guard + `query(db,source,sql)` signature bug), `setup/db-info` admin after setup | `49a49dca` |
| **2** | **Project** dimension: `project_members` table, 3D resolution (admin > project override > inherited workspace role), members API (workspace + project), last-owner guard | `75c2601f` |
| **5** | **Members pages** (tab in the workspace AND project settings), add by username, `lib/api/members.ts` client | `697a209d` |
| **3** | **Scoped catalog**: `code-execution` (project) + `app-database` (global) permissions; execution gated by `code-execution:write`; app database SQL tool gated by `app-database:read` | `660b0c22` |
| **4** | `/auth/me` returns the permissions; `hasGlobalPermission()`; Users/Roles tabs + SQL tool hidden without permission; project role **`none`** (hide a project); backfill migration for existing roles | `7553f08f` |
| **1** | **Strictly workspace-scoped plugins**: `workspace_id` NOT NULL, migration removes the global ones, creation requires a workspace (front + back) | `9cfa3a4b` |

### Decisions made (product owner)
- Project membership = **inheritance + override** (the override replaces: broadens, restricts, or `none` = hidden).
- Workspace creator = **owner** (already in place).
- Code execution = **dedicated permission** `code-execution` (not just `editor`).
- Plugins = **strictly workspace-scoped**, existing global ones **removed**, built-in defaults stay in an in-memory registry (no `user_plugins` rows).
- UI: admin pages/tabs **hidden** without permission; inline edit/delete actions → **disabled** (chosen posture; the fine-grained inline gating remains to be extended surface by surface — see Remaining).

### Remaining (non-blocking, to plan if needed)
- **Inline edit/delete gating** by workspace/project role in the surfaces (cohorts, datasets, connections, mappings…): requires also exposing the role **per context** (endpoint `GET /workspaces|projects/{id}/my-permissions`) then disabling the buttons. `/auth/me` today only carries the **global** permissions.
- **Minor**: `organizations` read open to any logged-in user (left intentionally); `test-connection` stays at authn (SSRF flavor not addressed).
- **Portal/export**: earlier exports containing a global plugin (`workspaceId` absent) will need to be re-associated with a workspace on import (the import flow is already per-workspace).
