# Planning — session planner

Read this at the start of a session and pick. One line per remaining item.
The as-built is in `docs/architecture.md`; details for each item live in the linked plan.

**Status**: 🔜 ready to do · 🤔 needs your decision · 💤 later/maybe · 🧪 needs manual testing
**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

## Versioning — [versioning-plan.md](versioning-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🧪 | LFS pull/push end-to-end against a real GitLab/GitHub remote (scores parquet, big CSV) | S (manual) |
| 🤔 | Pull for the 6 entity scopes + workspaces — as **pull-overwrite** (reuse `applyClonedEntity`) or drop | M |
| 🔜 | Server-side guard: refuse `paths=None` (git add -A) on the commit-push HTTP route | S |
| 💤 | Server-side import (`POST /projects/import`, `/workspaces/import`) — last big client-offload | L |

## IDE — environments & jobs — [ide-environments-plan.md](ide-environments-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🔜 | Real environments (1 uv + 1 renv per project, git-versioned) + multi-session + job management — design settled 2026-07-30, 0 code | L |

## Dataset edit layer — [dataset-edit-layer-plan.md](dataset-edit-layer-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🤔 | Spreadsheet-style edits over immutable raw — design not yet arbitrated vs "pipeline-only transforms" (the dataset-store edit API is its unused groundwork) | L |

## Fullstack backlog — [fullstack-storage-plan.md](fullstack-storage-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pipeline actually functional (end-to-end transforms) | L |
| 🔜 | Reports page | L |
| 💤 | Multi-user concurrent editing (conflicts, locking) | L |
| 💤 | Job queue / multi-worker perf (uvicorn is 1 worker) | M |
| 💤 | Run streaming + realtime R output polish | M |
| 💤 | Cosmetic: drop `render` from the `/execute` purpose docs/enum | S |

## Permissions — [users-authorizations-audit.md](users-authorizations-audit.md)

| St | Item | Effort |
|----|------|--------|
| 🤔 | PO end-to-end validation of the permission model (catalogue is implemented but "not settled") | S (review) |
| 💤 | Group-access rework bucket: `workspace_id is None → no check` pattern + `update_project` destination-workspace check | M |
| 💤 | Minors: inline gating by context, organizations read open to all, test-connection SSRF | S–M |

## Code quality leftovers (from REVIEW-LOG)

| St | Item | Effort |
|----|------|--------|
| 🔜 | Split entity-io.ts (~2.5k lines → export/import/clone); seed-loader.ts / WorkspacesPage.tsx also > 800 | M |
| 🤔 | Regenerate the bundled activity-dashboard seed (still uses legacy `col-N` ids) → then drop the colIdMap rescue in entity-io | S |
| 🤔 | Cohort schema migrations v1→v4: removable once no old cohort persists in your DB/IDB | S |
| 💤 | git-content-retry: token input/hint on auth-gated failure | S |
| 💤 | PTY idle sweep (kernel sessions sweep; PTY is bounded by WS lifetime) | S |

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*[../health-dcat-ap.md](../health-dcat-ap.md) is a reference document, not an effort.*
