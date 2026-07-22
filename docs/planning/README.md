# Planning — current state & remaining work

The **as-built** (what is implemented) is documented in `docs/architecture.md` — notably
the "Fullstack Storage & Compute", "Permissions Model", "Server-Owned Rendering" and
"Versioning (as-built)" sections. This folder contains only the **remaining work**; the
completed plans (render-server-spec, settings-versioning, git-sync, server-export,
workspace-source-concept-ids-ownership) were deleted after graduating into
architecture.md, their leftovers merged below.

## Efforts

| Effort | Doc | Status |
|---|---|---|
| **Versioning** (LFS test, pull-overwrite for other scopes, server import) | [versioning-plan.md](versioning-plan.md) | Nearly done — stripping + server export ALL scopes DONE; 1 TO TEST (LFS), 2 to arbitrate, front-only pull WON'T DO |
| **IDE — environments & jobs** (real venv/renv per env, job management) | [ide-environments-plan.md](ide-environments-plan.md) | **100% TODO**, decisions ratified with the PO — ready to implement |
| **Dataset edit layer** (spreadsheet-style editing, replayable ops over immutable raw) | [dataset-edit-layer-plan.md](dataset-edit-layer-plan.md) | **100% TODO**, design not yet arbitrated (vs "pipeline-only transforms") |
| **Fullstack — backlog** (multi-user, job queue, functional Pipeline, Reports, Run/R streaming) | [fullstack-storage-plan.md](fullstack-storage-plan.md) | Fullstack transition DONE; living unordered backlog |
| **Permissions** (PO validation of the model, minors, group-access bucket) | [users-authorizations-audit.md](users-authorizations-audit.md) | Model implemented; PO end-to-end validation pending |
| **Long-term vision** | [../vision-roadmap.md](../vision-roadmap.md) | Pillars 2–3 not started |

Note: [../health-dcat-ap.md](../health-dcat-ap.md) (HealthDCAT-AP reference) remains a
reference document, not an effort.
