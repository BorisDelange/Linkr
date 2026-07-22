# Users & Authorizations — remaining work

> The permission model is **implemented** (audit flaws fixed, catalogue in
> `apps/api/app/core/permissions.py`, server-side atomic `resource:action` enforcement,
> UI gating via `can()` — full surface coverage verified 2026-07-12). As-built description:
> `docs/architecture.md` ("Permissions Model"). This file keeps only what remains.

## 1. 🔴 PO end-to-end validation of the permission MODEL (product decision)

The catalogue was validated point by point on 2026-07-11 (reports stub locked;
`databases` vs `project-databases`; `concepts` read-only; no dedicated test/build/export
actions — only `ide:execute`), but it was built incrementally during implementation and
the PO must still **review it end to end**:

- Which permission blocks we actually want (resources × actions), and at what level
  (global / workspace / project).
- Which default roles and which permissions each has (viewer/editor/owner + global
  admin) — review the matrix, in particular: who can execute code, manage organizations,
  query the application database, manage members.
- Granularity: keep the "role" grain or move to fine grain per resource on some surfaces?
- Edge cases: shared resources/directories; project role `none` (hide a project);
  workspace→project inheritance.

→ Nothing should be considered final until the PO has reviewed this model.

## 2. Minors (non-blocking)

- **Inline gating by context**: coverage was verified surface by surface (2026-07-12,
  `my-role` returns the effective permission list per context) — re-check any residual
  inline edit/delete control not yet driven by `can()` as new surfaces land.
- `organizations` read open to any logged-in user (left intentionally — re-confirm).
- `data-sources/test-connection` stays at authn only (SSRF flavor not addressed:
  outbound connection to an arbitrary host from the body).
- Portal/export: old exports containing a **global** plugin (`workspaceId` absent) need
  re-association with a workspace on import (plugins are now strictly workspace-scoped).

## 3. Deferred — group-access bucket

Systemic pattern deferred to the future group/shared-access work:

- **`workspace_id is None` → no access check**: any `workspace_id IS NULL` resource
  (data sources, schema presets, unassigned projects) is world-accessible to
  authenticated users. Coherent by design today, but it is the soft spot the original
  P1–P3 flaws lived in — to be re-modeled when group access lands.
- **`update_project` does not check the destination workspace** when moving a project —
  same bucket.
