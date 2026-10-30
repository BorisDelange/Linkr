# Collaborative versioning — workspace pull, merge requests, local forge

Goal: several people edit the same workspace (the wiki first) and meet in one git
repository without losing each other's work, and a change can go through review
(merge request / pull request) instead of landing straight on the main branch.

Started 2026-10-28, built through 2026-10-30 (all of §2's order, and §9).
As-built: `docs/architecture.md` § Versioning; what remains: `README.md` here (Versioning).

## 1. Where we are

- A workspace can **commit & push** (`POST /git/workspaces/{id}/commit-push`), with
  status, diff and branch listing. It has **no pull**.
- The push is refused once the remote moved past our cursor (`pull_required`,
  `git_service.commit_push`). So as soon as a second person pushes, the first one is
  **stuck**: they cannot push, and nothing in Linkr lets them catch up.
- Pulls exist for projects, databases, ETL pipelines, mapping projects and schema
  presets — two mechanisms: the mapping-project 3-way merge (`PullPanel`,
  `lib/pull-plan.ts`) and the project clone-based overlay (`ProjectPull`). Both rest
  on `git_sync_state` (`synced_oid` = 3-way base, `reviewed_oid` = push gate).
- The backend refuses any remote that is not `https://` or ssh, and any `http(s)`
  host resolving to a loopback/private address (`_reject_internal_host`, SSRF guard).
  That also refuses a **hospital's internal GitLab**, which is nearly always on a
  private address — the usual case inside an SPE.

## 2. Order

| # | Item | Effort |
|---|------|--------|
| 1 | Allowed internal git hosts (`LINKR_GIT_ALLOWED_HOSTS`) | S |
| 2 | Local test tiers: bare repos (pytest) + local GitLab (`docker/forge-sim/`) | M |
| 3 | Workspace pull, wiki first, then the other inline sections | L |
| 4 | Propose changes → merge request (GitLab) / pull request (GitHub) | M |
| 5 | Per-workspace push policy (direct / always through review) | S |
| 6 | User docs (linkr-website): working together on a workspace | S |

Each step is usable on its own; 1 and 2 come first because every later step is
tested on them.

## 3. Allowed internal git hosts

`LINKR_GIT_ALLOWED_HOSTS` (server setting, comma-separated `host` or `host:port`,
empty by default): the admin's explicit list of git hosts that may sit on a private
address.

- A remote whose host is listed skips the private-address check in
  `_reject_internal_host`, and may use `http://` (a local forge, an intranet GitLab
  without TLS). Every other host keeps today's rules.
- The match is on the **hostname as written**, before resolution; the resolved IP is
  not consulted for a listed host. Redirects stay off (`_git_env`), so a listed host
  cannot bounce git elsewhere.
- The forge API calls of §6 go through the same check: one rule for git and API.
- Never settable from the UI or by a workspace admin — it widens what the server can
  reach, so it belongs to whoever runs the instance (env / `config.py`).
- Tests: listed host on 127.0.0.1 accepted; unlisted private host still refused;
  `http://` refused for an unlisted host; a listed host with a different port refused.
- Docs: `docs/deployment-context.md` (SPE: point it at the hospital forge), the
  Docker env reference.

## 4. Local test tiers — nothing leaves the machine

No real GitLab/GitHub account: every test runs against repositories on this machine.

### 4.1 Bare repositories (pytest, every run)

`git init --bare` in a tmp dir, two clones standing for two people. Covers push,
pull, behind / diverged, conflicts. Runs in the API unit suite, so the pre-push hook
covers it.

- Fixture `two_editors(tmp_path)` → a bare remote + two Linkr workspaces linked to it
  (local remotes are already allowed in tests through `_LOCAL_REMOTES_ALLOWED`,
  `tests/conftest.py`).
- Scenarios (each one a test):
  1. A pushes, B is behind → B's push refused with `pull_required`, B pulls, B pushes.
  2. A and B edit **different** wiki pages → B's pull takes A's page with no question.
  3. A and B edit **the same page, different paragraphs** → text 3-way merge, no conflict.
  4. A and B edit **the same lines** → conflict, B chooses (mine / theirs / edited), pushes.
  5. A deletes a page B edited → conflict "deleted remotely, changed locally".
  6. A moves a page (new parent) while B renames it → both land (different fields).
  7. Partial pull: B declines one incoming page → it reappears as a local change to push.
  8. Status changes (draft → approved) merge per field like any metadata.

### 4.2 Local GitLab (`docker/forge-sim/`, on demand)

For the merge requests (§6), which need a real forge API.

- `docker/forge-sim/docker-compose.yml`: official `gitlab/gitlab-ce` image, bound to
  `localhost:8929`, data in a named volume. ≈ 4 GB RAM, a few minutes to boot — run
  only when testing, never in the default stack.
- `docker/forge-sim/seed.sh`: through the GitLab API with the root token the compose
  sets, create two throwaway users (`alice`, `bob`), a group `sandbox`, an empty
  `sandbox/workspace` repo, and a personal token per user written to
  `docker/forge-sim/.tokens/` (gitignored). The accounts are fake and worthless; the
  volume can be wiped at any time.
- The Linkr dev server runs with `LINKR_GIT_ALLOWED_HOSTS=localhost:8929`.
- `docker/forge-sim/README.md`: up, seed, which token to paste where, down + wipe.
- Scenarios: alice proposes a change → MR opened on the forge with the right title,
  description and branch; bob merges it on the forge; alice's Linkr shows it merged,
  pulls, and the local changes are gone (nothing left to push). Also: MR closed
  without merge → the proposal shows closed, the local changes are still there.
- Later, the same scenarios can run inside `docker/spe-sim/` (the forge as the
  hospital's internal GitLab, no internet), as an SPE scenario.

### 4.3 GitHub

No local equivalent. The pull-request client (§6) is tested against recorded API
responses (`respx` mocks of `POST /repos/{owner}/{repo}/pulls` and `GET …/pulls/{n}`).
A live check against a real GitHub test repo stays a manual item, only if wanted.

## 5. Workspace pull

Reuse the bidirectional `PullPanel` shell (§ Pull, as redesigned): when the remote is
ahead, the same panel lists what is coming in, every item needs a decision, and
finalizing advances `reviewed_oid` (and `synced_oid` only on a complete pull).

**What the workspace repo holds**: its own inline sections (`workspace.json`,
`README.md`, `wiki/`, and the sections exported inline — SQL collections, ETL
pipelines, DQ rule sets, concept sets, mapping projects, catalogs, plugins) plus git
pointers for the git-linked children. A git-linked child has its own repo and its
own pull; the workspace pull only notices that the pointer moved and links to it.

**Wiki first** (one page = one `.md` per language + a `_tree.json` entry, so the
granularity is already right):

- Identity of a page = its `id` (stable across instances, carried by `_tree.json`).
- Per page, 3-way between BASE (file at `synced_oid`), REMOTE, LOCAL (DB):
  - **content**, per language: **paragraph-based** 3-way merge (arbitrated
    2026-10-28) — the Markdown is cut into blocks (blank-line separated; a fenced
    code block, a table or a list stays one block), blocks are aligned BASE↔LOCAL and
    BASE↔REMOTE, and a block changed on one side only is taken from that side. Re-
    wrapping a paragraph then conflicts with nothing else. A block changed on both
    sides (differently) is a conflict shown with both sides and an editable result.
  - **metadata** (title, parent, order, icon, status, owner, review date): per field,
    like the mapping-project metadata.
  - added / deleted pages on either side, and the delete-vs-edit conflict.
- `wiki/_attachments/`: whole files keyed by id — added / removed, no merge.
- Pure logic in `lib/wiki/pull-plan-builder.ts` (+ tests), same shape as
  `lib/concept-mapping/pull-plan-builder.ts`.

**Then the other inline sections**, each with the simplest mechanism that holds:
whole-entity take / keep for small JSON entities (DQ rule set, catalog, concept set),
the existing per-entity pull where there is one (mapping project, ETL, SQL), per-file
for SQL scripts. This also closes the planning item "Pull for the push-only scopes"
for workspaces.

Server side: `GET /git/workspaces/{id}/pull-preview` (BASE/REMOTE trees as
`{path: oid}` + the files the plan needs), `POST /git/workspaces/{id}/pull-finalize`
(advances the cursors). Applying goes through the existing storage writes, never a
git commit — as for the other pulls.

## 6. Propose changes → merge request

For **every versioned entity** (arbitrated 2026-10-28): workspaces, projects,
mapping projects, databases, schema presets, SQL collections, ETL pipelines, DQ rule
sets, data catalogs, plugins, settings — one shared code path keyed by git scope,
exposed in the shared versioning panel. Next to *Commit & push*, a **Propose
changes** action:

1. Requires not being behind (pull first — the proposal is built on the current main).
2. Commits the selected files on a new branch `linkr/<username>/<yyyymmdd-hhmm>`
   created from the remote main head, pushes it.
3. Opens the MR/PR through the forge API with the **user's own token** (so the forge
   shows the right author): title = commit message, description = the list of changed
   entities (wiki pages by title, status changes) + "Proposed from Linkr".
4. Does **not** advance the main cursors: the content is not on main yet, so the
   changes stay "local changes" until the MR is merged.

- Forge detection from the remote: `gitlab.com`, `framagit.org`, any host answering
  `GET /api/v4/version` → GitLab (`POST /projects/:url-encoded-path/merge_requests`);
  `github.com` → GitHub (`POST /repos/:owner/:repo/pulls`). Unknown forge → the action
  pushes the branch and shows the "open a merge request" link the forge prints, if any.
- Table `git_proposals(scope, entity_id, branch, forge, number, url, state, author_id,
  created_at)`; the panel lists open proposals with their state, refreshed on open
  (`GET` on the MR/PR). States: open / merged / closed.
- After a merge on the forge: the next status sees main ahead; the pull finds REMOTE ==
  LOCAL for those files (nothing to decide), finalizes, and the local changes vanish.
  A closed MR: the branch can be deleted from Linkr; local changes are untouched.
- Review, comments and the merge itself stay on the forge — Linkr does not re-implement
  code review. The wiki status fits naturally: a page in *Needs revision* is what goes
  into a proposal.
- MCP: read only, like its other git tools (`list_git_proposals`); it never commits, pushes,
  pulls or opens a proposal.

## 7. Push policy per workspace

`workspace.gitPushPolicy`: `direct` (today) or `review` (only *Propose changes*;
*Commit & push* hidden). Set by a workspace admin. A forge-side protected branch is
the real enforcement; this only keeps the UI honest about it.

## 9. Every versioned entity — one pull engine, cards by subject, one test matrix

Asked 2026-10-29: every versionable thing is pulled, proposed (MR/PR), pushed
and tested on branches; the quick actions and the pull granularity are redone
around what an entity is made of.

### 9.1 Inventory (2026-10-29)

| scope | anchored push | pull today | granularity today |
|---|---|---|---|
| workspaces | yes | wiki only (`WorkspacePull`) | page → field / language |
| projects | **no** | **disabled** (`ProjectPull`, unwired 3b06130ee) | group → entity, no base |
| mapping-projects | yes | `MappingProjectPull` (3-way) | mapping row, metadata field, whole CSVs |
| sql-script-collections | **no** (no sync-state route either) | none | — |
| etl-pipelines | yes | `EtlPipelinePull` (no base) | file + settings block |
| schema-presets | yes | `SchemaPresetPull` (no base) | 2 blocks: schema / docs |
| databases | yes | `DatabasePull` | whole repo |
| data-catalogs, dq-rule-sets, user-plugins | yes | none | — |
| settings | yes | dialog (upsert) | family |

Inside a workspace repo, the workspace's own metadata (`entity.json`: name,
description, licence; README; attachments), `wiki/`, `concept-sets/`,
`service-mappings/`, `source-concept-ids/ranges.json` and user `plugins/` are
always inline; projects, schemas, databases, SQL collections, ETL, DQ, mapping
projects and catalogs are inline unless git-linked (then a pointer + their own
repo and their own pull).

Why the project pull was disabled — and why most pulls are fragile: no merge
base (every difference reads as "the remote changed it", accepting overwrites
local work), comparisons by name instead of content (phantom changes after
every push), no deletions/renames, id churn on re-import (widgets pointing at a
dataset that no longer exists), deletes before import (not atomic), groups
offered that are never exported (`pipeline/`).

### 9.2 One engine: a 3-way merge over the export tree

The export tree is already the entity's canonical text form. So every pull is:

1. **Three trees.** BASE (the sync anchor) and REMOTE from git, LOCAL = the
   export the server builds now (the same one `status` diffs). One generic
   server route per scope (`tree-preview`, extended to every family) returns the
   three, text in full, binaries as oids.
2. **Per file:** unchanged on one side → that side; same change on both → no
   item; both changed → merged by the file's kind (below), conflict only where
   the merge cannot decide. Additions and deletions are first-class, so a
   remote deletion is offered as one.
3. **Items by file kind** — the granularity the user decides at:
   - Markdown (README, wiki pages, docs): one item per file, merged by
     paragraph (`lib/wiki/markdown-merge.ts`), conflicts per paragraph.
   - Entity manifests (`entity.json`, `dashboards/*.json`, `cohorts/*.json`…):
     one item per top-level field.
   - Keyed collections (`mappings.json`, `checks.json`, `_tree.json`, CSV with
     an identity column): one item per element, by its natural key.
   - Code (`.sql`, `.py`, `.R`): one item per file, merged by line (diff3).
   - Anything else (binary, unkeyable CSV): the whole file.
4. **Apply = re-import the merged tree in place.** The accepted items are
   written into LOCAL's tree, and the entity is re-imported from it by its own
   importer, in update mode, with deterministic ids (path/key-derived — already
   the rule for scripts, SQL files and dataset columns). One write path per
   scope instead of one bespoke applier per scope; declined items stay as they
   are locally and show up as changes to push.
5. **The precondition, tested per scope:** export → import → export gives the
   same bytes, and import in place keeps every id. Any scope failing it is fixed
   before its pull is wired. This round-trip suite is the first deliverable: it
   is what would have caught the project pull's phantom changes and id churn.

The wiki pull (§5) becomes the first client of this engine; mapping projects
keep their dedicated table (per mapping) on top of it.

### 9.3 Quick actions by subject, push and pull alike

A card is a **subject of the entity**, listing its **elements**, each with
✓/✗ — never a file path. The card's own button takes or refuses all of it; a
conflicted element is decided in Details (or its picker). Same cards on both
sides: "Sync dashboards" going out, "Pull dashboards" coming in.

| scope | cards (elements listed in each) |
|---|---|
| workspace | Information (name, description, licence, README) · Wiki (pages) · one card per inline kind present: Projects, SQL collections, ETL pipelines, Data quality, Mapping projects, Catalogs, Schemas, Databases (entities) · Data dictionaries, Plugins |
| project | Information (name, description, README, licence, tasks) · Dashboards · Patient boards · Scripts (files) · Cohorts · Datasets · Concept lists |
| mapping project | Information · Mappings (rows, with the existing picker) · Source concepts (concepts) · Similarity scores (methods) |
| SQL collection / ETL | Information · Scripts (files) · (ETL) Mapping files |
| DQ rule set | Information · Checks |
| schema preset | Information · Schema (DDL + mapping) |
| database | Information · Schema · Cohorts |
| catalog, plugin | Information · Files |
| settings | Organizations · Users · Roles |

An inline child in the workspace card expands into its own subjects in
Details (a project's dashboards are reachable from the workspace pull).

### 9.4 Merge requests for every scope

§6, generalised: `propose` / `proposals` routes registered beside status and
commit-push for every family (one scope → spec registry), `forge_service`
(GitLab MR / GitHub PR, built 2026-10-29), `git_proposals` table. The panel
gains *Propose changes* next to *Commit & push* for every scope.

### 9.5 Test matrix

For every row of §9.1 and every element of §9.3 (workspace name, description,
README, a wiki page, an inline project's dashboard/script/cohort/dataset, …):

| scenario | tier |
|---|---|
| round trip export → import → export identical, ids kept | unit (web) + API |
| commit & push, then status clean | API (bare repo) |
| remote-only change → pulled; local-only → stays to push; both → merged or conflict; deletion | unit (plan) + API |
| another branch: push there, switch, pull | API (bare repo) |
| propose → MR opened on the forge → merged there → pull leaves nothing to push | e2e against `docker/forge-sim` |
| the panel: cards, per-element choice, Details items, diff, finalize | e2e (server), one journey per scope family |

Order: round-trip suite (and its fixes) → engine + workspace (meta, wiki, inline
children) → projects → remaining scopes → cards → MR everywhere → e2e matrix.

## 8. Open questions

- 💤 Live co-editing of the same page (CRDT) — out of scope; git is the meeting point.
