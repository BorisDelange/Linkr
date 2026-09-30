# Planning — session planner

Read this at the start of a session and pick. One line per remaining item — what is
done is not listed: the as-built is in `docs/architecture.md`, and the design rationale
of finished efforts that the code still cites lives in `docs/design/`.

**Status**: 🔜 ready to do · 🤔 needs your decision · 💤 later/maybe
**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

*Last checked against the code: 2026-09-30.*

## Priority

| St | Item | Effort |
|----|------|--------|
| ✅ | **Any account can take over the server** — project without workspace → `owner` → `ide:execute` → kernel inherits `LINKR_SECRET_KEY` (root in Docker) → forged admin JWT. Forbid unassigned projects, scrub the kernel env, non-root API, API port on loopback. [security-compliance-plan.md](security-compliance-plan.md) A1 | M |
| 🔜 | **Threat model of database credentials, as a user-doc page** (`administration/`, FR + EN): who can recover a database password — another user, an admin through the UI/API, a copy of the Linkr DB or its backups, write access to that DB, the server's administrator — and what session-only passwords change. Source: [per-user-db-credentials-plan.md](per-user-db-credentials-plan.md) §11. **Settle the agent path first** (see *Per-user database credentials* below): a kernel started by an API key no longer gets the password (A4), but an agent running in the user's own `default` kernel still can, and the page must not state a guarantee the app does not keep — or must state that gap | S |

## To test manually in the app

Built, never exercised by hand. Everything else below is still to build.

| St | What | Mode | Effort |
|----|------|------|--------|
| 🔜 | Workspace vocabularies & dictionaries: ATHENA import (full + subset + a second release), legacy vocabulary databases, INDICATE sync + update, resolution, SQL tab | both | M |
| 🔜 | Data catalog: variables & crossings, a resumed run, Pause/Stop, anonymization audit, Publish (Pages) | both | M |
| 🔜 | Derive a cohort → new DuckDB, and → new schema (Linkr-owned DuckDB, Postgres with writes allowed) | server | S |
| 🔜 | SPC plugin: add the widget to a dashboard. No plugin has a validator — this is the only check that exists | both | S |
| 🔜 | Server file picker end to end (`server-file-picker-plan.md` §6) | server | S |
| 🔜 | Versioning against a real remote: partial pull → push unblocked, conflicts, LFS path | both | S |
| 🔜 | Dataset editing & manual collection (cell edits, undo after reload, rename repairs filters, two people collecting) | both | M |
| 🔜 | Patient data: localStorage migration, server round-trip, export → reimport → export stability | both | S |
| 🔜 | Setup wizard on a *virgin* instance (`LINKR_DATA_DIR=/tmp/…`): install → children cloned → decision recorded → no browser re-seed on a second machine | server | S |

## IDE — web apps — [web-apps-plan.md](web-apps-plan.md)

Run a **long-lived web server** from project code (Shiny, Streamlit, Dash, Gradio, plumber,
FastAPI/Flask, Panel, Marimo) and show it in an iframe inside Linkr. Server mode only.
Nothing exists yet; the closest prior art is `pty_kernel.py`. Frameworks are **presets**
(name, detection rule, argv template with `{port}`) over a raw `$PORT` command. An app is
its own detached process, never a kernel run, so the R/Python session stays usable.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Arbitrate the plan (same-origin iframe + no sharing; `/api/v1/apps/…` prefix; registry owns lifecycle, job row only shadows; dev-only COEP `credentialless`) | S |
| 🔜 | 1. Extract `runtime_spec()` from `kernel._make()` | S |
| 🔜 | 2. `web_apps.py`: `AppManager` (detached spawn, port probe, readiness, log tail, killpg teardown, quota, idle sweep) — also fixes the killpg leak and the missing idle sweep in `pty_kernel.py` | M |
| 🔜 | 3. Presets table + detection + custom `$PORT` command | S |
| 🔜 | 4. `routes/apps.py`: start / stop / list / logs behind `ide:execute` | S |
| 🔜 | 5. Job-row shadow (`kind="app"`) + cancel hook | S |
| 🔜 | 6. Proxy: HTTP streaming + WS pump + `<base>` injection + `Location` rewrite | M |
| 🔜 | 7. Frontend: `AppTab`, toolbar + logs drawer, `RunButton` entry, apps in `JobsIndicator` | M |
| 🔜 | 8. nginx `proxy_buffering off`, dev COEP, `docs/architecture.md` | S |
| 🔜 | 9. **[TO TEST]** Matrix across the frameworks | M |

## Workspace vocabularies & data dictionaries — [workspace-vocabularies-plan.md](workspace-vocabularies-plan.md)

Built 2026-09-28 (library, dictionaries, resolution, SQL export). Left:

| St | Item | Effort |
|----|------|--------|
| 🔜 | Workspace export: **stop embedding the concept sets** — today every set is written in full to `concept-sets/*.json` (client `lib/entity-io.ts` and server `workspace_export_assemble.py`). Write one pointer per dictionary instead (repo URL, ref/commit, name), and on import re-download it from the repo or list it as missing. Same for the vocabulary inventory (`vocabulary_id` + version, never the data) | M |
| 🤔 | A dictionary with no repo (local import): not exported at all and reported as missing on import — or kept out of the workspace export by design? | S |
| 🔜 | Mapping-project pull: take the remote `conceptSets` refs (no pull path reads them yet) | S |

## Reports — [reports-plan.md](reports-plan.md)

BlockNote document mixing prose with live Linkr widgets, presentable as slides (split on
`---`), exportable to md/HTML/DOCX/ODT/PDF/PPTX, filters frozen **per widget**. Arbitrated
2026-08-05; nothing built (the website already has `<PlannedFeature>` pages for it).

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Model + persistence (`Report`, store, model + Alembic + service + routes, export/versioning) | M |
| 🔜 | 2. BlockNote editor (`@blocknote/shadcn`, dynamic import, i18n, Portal audit) | M |
| 🔜 | 3. `linkrWidget` custom block + slash-menu + "import from a dashboard" | M |
| 🔜 | 4. Per-widget filters (`resolveBlockFilters` + tests) | M |
| 🔜 | 5. Freeze figures (`figure-export` + `OffscreenWidgetCapture`) | M |
| 🔜 | 6. Presentation mode (`splitBlocksIntoSlides` + `computeFitScale`) | M |
| 🔜 | 7. Exports (md/HTML → DOCX/ODT/PDF via XL → PPTX via `pptxgenjs`) | L |

## eCRF / survey plugin — [survey-plugin-plan.md](survey-plugin-plan.md)

Three parsers (Goupile, REDCap, XLSForm/ODK) and the `survey-question` plugin are built;
only Goupile is reachable from the UI.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Wire `redcap` / `xlsform` to the upload path — tested, but no `.tsx` calls them | S |
| 🔜 | Persist the schema to the dataset sidecar (`SURVEY_SIDECAR_KEY` is declared and used nowhere) | M |
| 🔜 | Dataset import from the IDE; i18n sweep | S/M |
| 🤔 | (b) user-overridable `measure` · (d) in-place chart switching | S / M |
| 💤 | More sources — **CDISC ODM first** (buys Castor + OpenClinica) | L |

## SPC / control charts plugin

`linkr-analysis-spc` is built; theory and formulas in `docs/design/spc-plugin-plan.md`.

| St | Item | Effort |
|----|------|--------|
| 💤 | Xbar-S, CUSUM, funnel plot, risk-adjusted VLAD | M |

## Server file picker — [server-file-picker-plan.md](server-file-picker-plan.md)

Databases (`serverPath`), the ATHENA folder and, since 2026-09-28, the concept-mapping
source file can point at a server file. Left:

| St | Item | Effort |
|----|------|--------|
| 🔜 | Category B, screen by screen: dataset import, scores, IDE upload, ETL upload — each needs a "read a server file" backend path | M |
| 🤔 | `fs_browse_roots` empty = the whole filesystem (still the default): keep, or default to a root? | S |

## Versioning

Pulls exist for projects, databases, ETL pipelines, mapping projects and schema presets.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pull for the push-only scopes: workspaces, SQL collections, DQ rule sets, data catalogs, plugins, settings | M |
| 🔜 | Server guard: the commit-push routes still accept `paths=None`, which runs `git add -A` (`git_service.commit_push`) | S |
| 🔜 | `attachments/` on pull: the project pull carries them; check the other pulls | S |
| 💤 | Server-side import (`POST /projects/import`, `/workspaces/import`) — last big client-offload | L |

## Fullstack backlog

Logging is in place: structlog to stdout, plus the **access log** (`core/audit.py`: one
JSON line per data-touching request → `data_dir/audit/YYYY-MM-DD.jsonl` + stdout, monthly
Parquet, hash chain, *Access log* page behind `audit-log:read`).

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pipeline actually functional — the Lab Pipeline page is a canvas (palette, nodes, panel) with no execution behind it | L |
| 💤 | Multi-user concurrent editing (conflicts, locking) | L |
| 💤 | Several API workers — one today, and the access-log hash chain assumes it | M |

## Descriptive table

| St | Item | Effort |
|----|------|--------|
| 🔜 | p-value column when a group-by is active — neither `render/table1.py` nor `Table1Component` computes one (client + server + parity test) | M |
| 🔜 | Its tooltip: test, why it was chosen, statistic, warning marker (SAMPL: never a p without its test) | S |

## Default data & catalog

`data:fetch` runs in CI, the API image carries git-lfs (tested against LFS pointers), schema
presets are no longer auto-created, and the import dialog has its catalog tab.

| St | Item | Effort |
|----|------|--------|
| 🔜 | `linkr-portal`'s `build.sh`: check it uses the shared indexer rather than its own | S |
| 💤 | "Propose to catalog" prefill | S |

## Data quality standards — [dq-standards-plan.md](dq-standards-plan.md)

Thematic public DQ rule sets (DQD-derived: structure, sex plausibility, units; ours:
lab values, vital signs, ICU), quality profiles (checks picked across rule sets, run
on a database), stable check ids, run export and catalog publish as W3C DQV.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Stable `checkKey`; quality profiles (checks picked across rule sets, overrides, release review) + Runs; DQ home with 3 widgets like concept mapping | L |
| 🔜 | DQD generator + the 3 DQD-derived public rule sets | M |
| 🔜 | `dqRunToDqv()`, run export, catalog publish with a "Data quality" section | M |

## Format package & public content

| St | Item | Effort |
|----|------|--------|
| 🔜 | Run `linkr-format validate` in the CI of the `linkr-public-content` repos — none has a `.gitlab-ci.yml` | S |
| 🤔 | `serializeProject` / `ProjectSpec` (build a project export tree from a compact spec, written for the deleted authoring MCP): no caller left — delete? | S |
| 💤 | Convert the bundled MIMIC-IV ETL to C/CR (its scripts still join `source_to_concept_map`) | M |
| 💤 | `00b_custom_vocabulary.sql`: only the seed loader generates it — remove? | S |

## Security & compliance — [security-compliance-plan.md](security-compliance-plan.md)

Audit of 2026-09-30 against the SPE frame ([../deployment-context.md](../deployment-context.md))
and the CNIL CDW framework. A1 is in *Priority*.

| St | Item | Effort |
|----|------|--------|
| ✅ | A2. `test-connection` SSRF — permission + configurable host allowlist (private IPs are where an SPE's datamart lives) | S |
| ✅ | A3. Git: `clone`/`verify-remote`/`host-token` open to any user; local paths and `file://` not refused (to confirm by test); `GIT_ALLOW_PROTOCOL` | S |
| ✅ | A4. API-key session → `/execute` → kernel token → decrypted DB password (the 🤔 below): refuse the recipe to kernels started by an API key | S |
| 🔜 | B1. Access log: successful login by username, downloads (`/raw`, blob, export ZIPs), row previews | S |
| 🔜 | B2. Clamp or document `audit_retention_days` (6–12 months) | S |
| 🔜 | B3. Mapping-project exports (`source-concepts.csv`, git sync) carry `record_count`/`patient_count` under the threshold, extremes and small histogram bins — mask at export, client + server | M |
| 🔜 | B4. Password change: `/auth/change-password` does not exist | S |
| 🔜 | D. Security headers (CSP, HSTS…), bind uploads to their uploader, offline mirrors (`indexUrl` http, `trusted-host`) | M |
| 🔜 | F. SPE deployment checklist (website `administration/`, FR + EN) + stale texts (`ai-agents-plan.md` Fernet, `application_name`) | S |
| 🤔 | C1. Aggregate-only access: `rows` action on databases/datasets/patient-data/cohorts + default role `aggregates` + route classification — validate the design | M |
| 🔜 | C2. Dashboard aggregate mode: frozen published snapshot first, then a live server aggregation endpoint with suppression + cell-key noise | L |
| 🔜 | E. Trusted-header auth provider (identity from the SPE's two-factor proxy) | M |
| 💤 | A1 follow-up: kernels under their own OS identity, no read access to `data_dir` | L |

## Permissions

| St | Item | Effort |
|----|------|--------|
| 🤔 | PO validation of the resources × actions catalogue: which blocks, at which level, default roles, edge cases (shared resources, project role `none`, workspace→project inheritance) | S (review) |
| → | `test-connection` SSRF and the unassigned-project hole moved to *Security & compliance* (A2) and *Priority* (A1) | — |
| 💤 | Minors: inline gating by context, organizations readable by all | S |

## Per-user database credentials — [per-user-db-credentials-plan.md](per-user-db-credentials-plan.md)

Built: personal accounts, per-user pools and caches, session-only passwords, access log,
*Database accounts* tab, *Access log* page. Left (plan §12, steps 11–12):

| St | Item | Effort |
|----|------|--------|
| → | `client_recipe` to API-key sessions: refused on the client-lib endpoints since `6dc39787`; the remaining path (API key → `/execute` → kernel token) is *Security & compliance* A4 | — |
| 🤔 | …and that is not enough: a kernel an API key starts gets no recipe since A4, but the MCP's `run_code` defaults to session `default`, shared with the user's IDE — a kernel the user started holds a web kernel token the agent's code can read and use (plan §7). Server-side query proxy, separate agent sessions, or forbid DB access to agent runs? | S–M |
| 🔜 | IDE connections: split settings (per project) from login (per user), reusing `DatabaseCredential` | S |
| 🔜 | Per-workspace browse roots for file-based databases; `serverPath` registration behind `databases:manage` | M |
| 🔜 | *My activity* page (the route exists, no page) | S |

## Code quality

| St | Item | Effort |
|----|------|--------|
| 🔜 | Split `lib/entity-io.ts` (now 5.3k lines → export / import / clone); `seed-loader.ts` (1.9k) and `WorkspacesPage.tsx` (825) too | M |
| 🔜 | Plugins: import via Git — `PluginsTab.tsx` is the last bare `<input type="file">`; move it onto `ImportSourceDialog` | S |
| 🔜 | Seed loader: read `LICENSE.md` (and the entity docs) from the bundled default data | S |
| 🤔 | Regenerate the activity-dashboard seed (legacy `col-N` ids) → drop the `colIdMap` rescue in entity-io | S |
| 🤔 | Cohort schema migrations v1→v4 in `cohort-store`: remove once no old cohort persists | S |

## Other

| St | Item | Effort |
|----|------|--------|
| 💤 | ETL `source.` / `target.` role aliases in generated SQL instead of `ds_<alias>`, so scripts survive a round trip. Needs cross-schema support in server mode | L |

## User documentation — [website-docs.md](website-docs.md)

Every gap between the app and linkr-website is listed there, not in the sections above.

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*Reference documents, not efforts: [../health-dcat-ap.md](../health-dcat-ap.md),
[../ecrf-formats-licensing.md](../ecrf-formats-licensing.md).*
