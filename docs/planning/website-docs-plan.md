# User documentation (linkr-website) — full audit & plan

**Scope**: the `/docs` section of `../linkr-website` (linkr.interhop.org), FR + EN.
Not the app's developer docs (`docs/architecture.md`), not `/resources`, not `/blog`.

**Audited 2026-09-20** against the app on `feature/fastapi-backend` and the efforts in
[README.md](README.md). **Skeleton built 2026-09-20** — see §0bis.

---

## 0. Where the doc set stands today

43 pages × 2 locales, 9 sections. But the headline number hides the real state:

| | Pages | What they are |
|---|---|---|
| **Real content** | 23 | Getting started (5), Concepts (3), Concept mapping (8), Dashboards (5), + 2 gateways |
| **Empty stubs** | 20 | 17 lines each: frontmatter + a `<DraftPage>` wrapper + "content coming soon" |

**47 % of the doc set is a placeholder.** Every stub is in a section a reader reaches from
the sidebar, so the sidebar promises nine sections and delivers four.

Ages tell the second half of the story:

- **Concept mapping** (8 pages) — written 2026-05-14 → 05-17, untouched since except
  `export.mdx` (09-16). Four months of app change behind them.
- **Concepts** (3 pages) — 2026-07-01. Audited: still accurate, they describe structure
  rather than UI, which is why they aged well.
- **Dashboards** (5) + **Getting started** (5) — refreshed 2026-09-02/09-16. Current.

### The structural problem

The doc nav does not match the app's navigation. The app has **three levels** —
application (`/`, Workspaces, Catalog, Settings) → workspace (Home, Projects, Wiki,
Plugins, Warehouse group, Versioning, Settings) → project (Summary, IDE, Pipeline,
Warehouse group, Lab group, Versioning, Settings). The docs instead have
`preparing-data` / `exploring-analyzing`, invented categories that map onto neither.

Worse, the two are **inconsistent with each other**: `preparing-data/concept-mapping`
exists *and* a whole `concept-mapping` section exists; `exploring-analyzing/dashboards`
exists *and* a whole `dashboards` section exists. Those two "gateway" pages are 36–38
lines that just forward to the real section. A reader who lands on one has taken a wrong
turn the nav encouraged.

**Decision to take (see §5):** restructure the nav to mirror the app, or keep the
task-oriented split and fix the duplication. This plan assumes the restructure.

### Entities with no page at all

These ship in the app today and appear nowhere in the docs:

SQL script collections · Data catalog · Schema presets (workspace level) · Wiki ·
Plugins · Reports · Setup wizard · Community catalog · Organizations & users ·
Descriptive table & statistical tests · Patient data boards · Dataset editing &
manual collection.

---

## 0bis. Skeleton — built 2026-09-20

The restructure of §2 is **done**, along with everything that had to move with it. What
exists now is the full page set with its navigation; what remains is writing the prose.

- **12 sections, 66 pages per locale** (was 9 / 43), FR and EN paired.
- **Nav mirrors the app**: Getting started · Core concepts · Workspace · Data warehouse ·
  Concept mapping · Project · Dashboards · Reports · AI and automation · Sharing and
  catalog · Administration · Reference.
- **22 pages moved with `git mv`**, so their history follows them. `preparing-data/` and
  `exploring-analyzing/` are gone.
- **3 pages retired**: the two gateway duplicates (`preparing-data/concept-mapping`,
  `exploring-analyzing/dashboards`) and `exploring-analyzing/reports`, superseded by the
  Reports section.
- **`<PlannedFeature status mode>`** created in `src/components/docs/`. Unlike
  `<DraftPage>` it renders in production. 11 planned pages use it: agents, skills, reports
  (×3), web apps, datamarts, SPC and survey widgets.
- **All stubs now carry a `description`**, so their production callout says what the page
  *will* cover instead of a bare "coming soon".
- **Every stale internal link fixed**, including the two pre-existing breakages the skill
  warned about (`/docs/more/plugins`, `/docs/presenting/reports`).
- **linkr-website's `CLAUDE.md`** no longer claims `/docs` is "Content Pending" with an
  empty nav.

The four checks pass: FR/EN pairing, i18n keys in both locales, internal links, and
`npm run build` (234 pages).

**Not committed** — pending review.

### State of the 66 pages

| State | Count | |
|---|---|---|
| Written | 23 | getting-started (5), concepts (3), concept-mapping (8), dashboards (5) + 2 |
| Draft stub | 32 | ships today, needs writing (§4a) |
| Planned | 11 | designed, not shipped (§4bis) |

## 0ter. Audit des 23 pages rédigées — 2026-09-20

Quatre audits parallèles, une section chacun, chaque affirmation vérifiée contre le code.
**8 pages en dérive majeure sur 21 auditées.** Par endroits la doc dit le contraire de l'app.

### Verdicts

| Section | Majeure | Mineure | OK |
|---|---|---|---|
| Concept mapping (8) | export, mapping-projects | overview, global-view, suggestions, evaluation | target-concepts, mapping-editor |
| Concepts (3) | versioning-collaboration, workspaces-and-projects | data-pipeline | — |
| Getting started (5) | quickstart-browser, what-is-linkr | install-local, deployment-modes, first-project | — |
| Dashboards (5) | builtin-widgets, tabs-and-widgets, code-widgets | filters-and-more, overview | — |

### Les erreurs qui trompent activement le lecteur

1. **`code-widgets.mdx` annonce SQL** dans son titre, sa description et 3 sections. SQL est
   **délibérément exclu** des widgets de code — commentaire explicite dans
   `AddWidgetDialog.tsx:524` : *"sql_query() targets a DB connection, and datasets are
   file-based at this stage — a SQL widget has nothing to query"*. Touche aussi le titre de
   nav, `overview.mdx` et `tabs-and-widgets.mdx`.
2. **`concept-mapping/export.mdx`** : annonce 4 cartes de format (il y en a 3), ne mentionne
   **jamais C/CR** qui est le défaut, et présente STCM comme « directement importable dans un
   ETL OHDSI » quand l'app affiche *« Table OMOP héritée… non lue par les outils OHDSI »*.
3. **`concepts/versioning-collaboration.mdx`** : encadré *« Ce qui est disponible aujourd'hui »*
   affirmant que le push/pull « arrive avec le mode full-stack ». Livré depuis longtemps.
4. **`quickstart-browser.mdx`** : fait créer un workspace vide alors que la démo s'ouvre
   **déjà peuplée** (la CI lance `data:fetch` avant le build). Promet aussi un terminal
   navigateur, que `deployment-modes` marque serveur-only.
5. **`builtin-widgets.mdx`** : catalogue incomplet (9 documentés, 11 dossiers dans
   `packages/default-plugins/analyses/` — SPC et Questionnaire absents), « Table 1 » renommé
   **« Tableau descriptif »**, et deux fonctionnalités documentées qui **n'existent pas** :
   termes d'interaction en régression et clustering sur la carte (zéro occurrence dans le code).
6. **`workspaces-and-projects.mdx`** : l'arbre d'export est faux sur 4 lignes sur 8
   (`project.json` → `entity.json`, `pipeline/` pas exporté du tout, `databases/` mal décrit).

### Contradictions internes (pages qui se contredisent entre elles)

| Sujet | Page A | Page B | Qui a raison |
|---|---|---|---|
| Données de démo | `first-project` : déjà là | `quickstart-browser` : créer du vide | first-project |
| Terminal navigateur | `quickstart` : disponible | `deployment-modes` : serveur-only | deployment-modes |
| Long → large | `first-project` : via l'IDE | `what-is-linkr` : pipeline DAG | à trancher (canvas non branché) |
| Contenu du ZIP | `mapping-projects` : SSSOM/STCM pré-générés | `export.mdx` : non | export.mdx |
| SPC / Questionnaire | pages planifiées `spc-widgets`, `survey-widgets` | plugins **livrés et enregistrés** | les plugins |

### Dérives systémiques

- **`backend="planned"` sur 16 pages** alors que l'API expose 40 routes et que le rendu
  serveur couvre 12 types de widgets. Décision produit à prendre (§5, décision 5).
- **« jeu de données » vs « dataset »** : `fr.json` dit *dataset* partout, la doc dit
  *jeu de données*. Choix éditorial à acter.
- **« Réglages » vs « Paramètres »** : l'app dit *Paramètres*, la doc dit *Réglages*
  (l'ancre `#réglages` est liée depuis une autre page).
- **Provenance absente partout** : `createdByDetails` (+ ORCID), `organization`, `lineageId`,
  `version`, `license`, `appVersion` sont exportés et documentés nulle part.

### Corrections apportées à mes propres prémisses

Le plan affirmait que l'IDE et l'ETL étaient serveur-only. **Faux** : l'IDE tourne via
Pyodide/webR dans le navigateur, l'ETL a un chemin front. Seuls le terminal, les
environnements gérés et le sélecteur de fichiers serveur sont réellement serveur-only.
De même, la case « Inclure les fichiers de données » **n'a pas été remplacée** par le
marquage par fichier — les deux coexistent (`export-dialog.tsx`, `entity-versioning-dialog.tsx`).

### Bugs côté app repérés au passage (hors périmètre doc)

| St | Item |
|----|------|
| 🐛 | `fr.json:4231` : *« Ce ZIP ne contient pas de projet d'alignement valide (project.json manquant) »* — l'app écrit `entity.json`. Message trompeur. |
| ✅ | `docs/architecture.md` marquait `/catalog` comme `(stub)` : corrigé (la feature fait 1104 lignes). |
| 🔜 | Clé i18n orpheline `project_nav.data_quality` (0 référence dans le code). |

### Ordre de correction recommandé

1. Les **5 contradictions internes** — une doc qui se contredit détruit la confiance.
2. **`code-widgets.mdx`** (SQL) et **`export.mdx`** (C/CR) — les deux pires erreurs factuelles.
3. Trancher **`backend="planned"`**, puis appliquer sur les 16 pages.
4. **`builtin-widgets.mdx`** — catalogue à compléter, 2 fonctionnalités inexistantes à retirer.
5. `versioning-collaboration`, `workspaces-and-projects`, `quickstart-browser`, `what-is-linkr`.
6. Les dérives de libellés (Tableau descriptif, Non vérifié, Paramètres, dataset).

---

## 1. Principles for this pass

1. **A stub is worse than no page.** It costs a click and returns nothing. Either write
   it, or mark it `wip: true` in the nav (non-clickable placeholder) so the sidebar is
   honest. Prefer writing.
2. **Planned features get a real page** with a construction banner that *shows the plan* —
   see §4. This is what the user asked for: a reader should learn what is coming, not
   meet a closed door.
3. **Never document from memory.** Every UI label comes from `apps/web/src/locales/*.json`
   in the page's own locale.
4. **Deployment badges are load-bearing.** Most of what is unwritten (IDE, ETL, wiki,
   reports, agents) is **server-mode only**. Getting this wrong sends a WASM user after a
   feature that cannot exist for them.
5. **FR and EN move together, always.** A locale-orphan page breaks sidebar, prev/next
   and Pagefind for both.

---

## 2. Proposed target structure

Mirrors the app. Sections marked **new**; pages marked ⚑ are planned-feature pages (§4).

```
Getting started          what-is-linkr · deployment-modes · quickstart-browser
                         install-local · first-project · setup-wizard (new)
Core concepts            workspaces-and-projects · data-pipeline
                         versioning-collaboration · entities-and-sharing (new)
Workspace                home · projects · wiki (new) · plugins (new)
                         members-and-roles (new) · settings (new)
  └ Warehouse            schemas · databases · concept-mapping (gateway)
                         sql-scripts (new) · data-quality · data-catalog (new)
                         etl-pipelines
Concept mapping          overview · mapping-projects · global-view · target-concepts
                         mapping-editor · suggestions · evaluation · export
Project                  summary · pipeline · ide (new) · versioning
  └ Warehouse            databases · concepts · cohorts · patient-data
  └ Lab                  datasets · dashboards (gateway) · reports ⚑
Dashboards               overview · tabs-and-widgets · builtin-widgets
                         code-widgets · filters-and-more
                         analysis-widgets (new) · spc-widgets (new)
AI & automation (new)    agents ⚑ · skills ⚑ · mcp-authoring (new)
Sharing & catalog (new)  community-catalog (new) · publishing (new) · import-export (new)
Administration           production-install · auth-permissions · configuration
                         backup-restore · server-files (new)
Reference                glossary · release-notes · keyboard-shortcuts (new)
```

That is ~48 pages. The count barely moves — the work is **filling**, not expanding.

---

## 3. Work items — existing pages

### 3a. Fix now, cheap (S)

| St | Item |
|----|------|
| 🔜 | **Dead links**: `/docs/more/plugins` and `/docs/presenting/reports` are referenced from `dashboards/tabs-and-widgets.mdx` and `dashboards/overview.mdx`. Real targets: `/docs/exploring-analyzing/plugins`, `/docs/exploring-analyzing/reports`. Both locales. |
| 🔜 | **Retire the two gateway pages** (`preparing-data/concept-mapping`, `exploring-analyzing/dashboards`) or convert them into real section intros. They duplicate a full section each. |
| 🔜 | **Stale `CLAUDE.md`** in linkr-website still says `/docs` is "Content Pending" with an empty `docs-nav.ts`. Rewrite that section — it actively misleads the next agent. |

### 3b. Concept mapping — verify against 4 months of change (M)

The 8 pages are the oldest real content. Re-read each against the app before trusting it.
Known changes to check for:

- **OMOP C/CR is now the default** export shape (CONCEPT + CONCEPT_RELATIONSHIP; STCM is
  derived, not built alongside). `export.mdx` was refreshed 09-16 — confirm it landed, and
  that the `CmExportFormatCard` frame shows C/CR first. *(README: OMOP C/CR migration →
  "User docs in ../linkr-website" is still open.)*
- **Schema presets are now installed entities**, not a built-in table. Any page saying
  "choose a preset from the list" needs rewording.
- **Database schemas** (`hosp`/`icu`/`note` qualification) changed how a mapping addresses
  a table. Check `mapping-projects.mdx` and `global-view.mdx`.
- **Provenance/lineage** (author, ORCID, organization) now on every exportable.

### 3c. Getting started & Concepts — light touch (S)

Audited as current. Two additions:

| St | Item |
|----|------|
| 🔜 | `what-is-linkr.mdx` § "Ce que fait Linkr" predates reports, the catalog and agents — add them to the three feature sub-lists. |
| 🔜 | `workspaces-and-projects.mdx` is accurate but does not mention the **community catalog** as a way to populate a workspace. One paragraph + link. |

---

## 4. Work items — the 20 stubs

Grouped by what it takes to write them. **⚑ = planned feature, gets the construction
banner (§4bis) rather than a "coming soon" wall.**

### 4a. Ships today, just undocumented — write in full (the bulk of the work)

| Page | Mode | Notes for the writer |
|---|---|---|
| `preparing-data/schemas` | both | Installed entities now; DDL + mapping + presets from the catalog |
| `preparing-data/databases` | both | Detail page with tabs (Overview/Statistics/Schema); Parquet folders; `serverPath` in server mode |
| `preparing-data/data-quality` | both | DQ rule sets, running them, reading results |
| `preparing-data/etl-pipelines` | **server** | source/target roles, generated SQL, the `ds_<alias>` caveat |
| `exploring-analyzing/data-catalog` | both | — |
| `exploring-analyzing/cohorts` | both | criteria builder, attrition |
| `exploring-analyzing/patient-data` | both | several boards per project (shipped 08-17), timeline, collection |
| `exploring-analyzing/datasets` | both | import, **editing cell-by-cell + manual collection** (shipped 09-06/07) |
| `exploring-analyzing/script-collections` | both | SQL collections; path-keyed tree |
| `exploring-analyzing/ide` | **server** | managed uv/renv envs, sessions, jobs, streaming Run |
| `exploring-analyzing/plugins` | both | install, configure, the two plugin models |
| `collaborating/wiki` | both | tree, attachments, search |
| `collaborating/versioning` | both | push/pull, LFS, mark-for-versioning, conflicts |
| `administration/production-install` | **server** | Docker compose hub images |
| `administration/auth-permissions` | **server** | roles × resources × actions; workspace→project inheritance |
| `administration/configuration` | **server** | env vars, `LINKR_SECRET_KEY`, `LINKR_DATA_DIR`, `fs_browse_roots` |
| `administration/backup-restore` | **server** | — |
| `reference/glossary` | both | mostly link out to `/resources` |
| `reference/release-notes` | both | decide: hand-written, or generated from tags |

### 4b. Planned — construction banner + what's coming ⚑

| Page | Source plan | State to show |
|---|---|---|
| `exploring-analyzing/reports` ⚑ | [reports-plan.md](reports-plan.md) | Design arbitrated 2026-08-05. BlockNote doc mixing prose + live widgets, presentable as slides, exports md/HTML/DOCX/ODT/PDF/PPTX, per-widget frozen filters. 7 steps, none built. |

### 4bis. New pages for planned features ⚑

The user asked explicitly for these: **dedicated pages, with a block saying it is under
construction, that show what is planned.** One page per effort that a *user* would care
about (internal refactors stay out of the user docs).

| New page | Source plan | What to show |
|---|---|---|
| `ai-automation/agents` ⚑ | [ai-agents-plan.md](ai-agents-plan.md) | One project-wide sidebar, **server mode only**. External agent binary (OpenCode) brings the loop; Linkr brings UI + actions over ACP v1 and MCP. Clinician and developer modes. Provider config is **already built** (workspace-scoped, owner-only, encrypted keys, `LINKR_ALLOW_REMOTE_LLM`). Say plainly: local-model-first, remote LLM off by default. |
| `ai-automation/skills` ⚑ | ai-agents-plan §1 | Workspace-scoped entity, one entity = one skill, `SKILL.md` + files, file tree like SQL collections. Per-project selection generates `AGENTS.md`. |
| `ai-automation/mcp-authoring` | shipped | **Not** planned — `packages/linkr-mcp` ships. Authoring entity trees outside Linkr. Honest caveat: no update/move/remove yet, read-back is partial. |
| `project/ide-web-apps` ⚑ | [web-apps-plan.md](web-apps-plan.md) | Run Shiny/Streamlit/Dash/Gradio/plumber/FastAPI from project code, shown in an iframe. Server mode only. Frameworks as presets. Note the no-sharing constraint (same-origin iframe). |
| `dashboards/spc-widgets` ⚑→built | [spc-plugin-plan.md](spc-plugin-plan.md) | Built, awaiting in-app test. p/P'/u/U'/c/np/I-MR/EWMA/g/t, NHSN denominators, Anhoj rules, Phase I/II. Ship as real content once tested. |
| `dashboards/survey-widgets` ⚑ | [survey-plugin-plan.md](survey-plugin-plan.md) | eCRF import (Goupile live; REDCap + XLSForm parsers built but unwired) + the `survey-question` widget. Be precise about which parser actually works today. |
| `preparing-data/datamarts` ⚑ | [database-page-datamarts-plan.md](database-page-datamarts-plan.md) | Derived sub-databases from cohort criteria. Naming not yet arbitrated — say so. |
| `exploring-analyzing/cohorts` §review ⚑ | [cohort-patient-review-plan.md](cohort-patient-review-plan.md) | A section inside the cohorts page, not its own page: the planned patient-review tab. |

### The construction block

A new `<PlannedFeature>` component (sibling of `DraftPage.astro`), amber rather than the
neutral draft grey, that renders **in production** — unlike `<DraftPage>`, whose whole
point is to hide content. Shape:

```
┌─ ⚑ Planned feature ───────────────────────────────┐
│ This is not available yet. Here is what is        │
│ planned, so you can tell whether it will cover    │
│ your need — and tell us if it will not.           │
│ Status: design arbitrated · Target: server mode   │
└───────────────────────────────────────────────────┘
```

Then the page continues with normal `##` sections describing the design in user terms.
Props: `status` (`idea` | `designed` | `building` | `testing`), `mode`
(`client` | `server` | `both`), optional `since`.

**Rule**: a planned page describes *user-visible behaviour only*. No architecture, no file
paths, no effort estimates — those live in `docs/planning/`. If a design is still
unarbitrated (datamart naming, cohort review shape), say "not yet decided" rather than
picking one.

---

## 5. Decisions needed

| # | Decision | Options |
|---|---|---|
| 1 | ~~**Nav restructure**~~ — **decided 2026-09-20: restructure.** Built, see §0bis. |
| 2 | **Stub policy** — the 32 draft stubs stay clickable `<DraftPage>` with a `description`, so the production callout says what is coming. Revisit only if the sidebar feels too promissory. |
| 3 | **Release notes** — hand-written per release, or generated from git tags? |
| 4 | **How much planned content?** This plan proposes 8 planned pages. Fewer = less churn when designs change; more = better signalling of where Linkr is going. |
| 5 | **`backend="planned"` on 16 pages** — the API ships 40 routes and 12 server-side widget renderers. Flip to `available`? A product/release call, not a code fact. |
| 6 | **« jeu de données » vs « dataset »** — `fr.json` says *dataset* everywhere; the docs say *jeu de données*. The style guide says quote the app's real labels. Align, or accept as editorial? |
| 7 | **SPC and Questionnaire ship today** but have `<PlannedFeature>` pages. Promote both to real content, and reconcile `analysis-widgets.mdx` which now overlaps `builtin-widgets.mdx`. |

---

## 6. Suggested order

1. **§3a** — dead links, gateway pages, stale `CLAUDE.md`. Half a day, removes real bugs.
2. **Decision 1** (nav), then execute the move if yes.
3. **`<PlannedFeature>` component** + the two highest-value planned pages (`agents`,
   `reports`). These are what the user asked for and what people ask about.
4. **§4a, the ships-today pages**, in this order — they are what users hit first:
   `databases` → `datasets` → `cohorts` → `patient-data` → `ide` → `versioning` → `wiki`.
5. **§3b** — concept-mapping verification pass.
6. **Administration** (4 pages) — one sitting, server mode only, shared vocabulary.
7. **Reference** — glossary, release notes, shortcuts.

Each step ends with the skill's four checks (FR/EN pairing, i18n keys, internal links,
`npm run build`).

---

## 7. Cross-repo notes

- Two README items already point here and get closed by this plan: *Export format
  harmonization → "User docs in ../linkr-website"* and *OMOP C/CR migration → "User docs
  in ../linkr-website (docs/concept-mapping/export.mdx, FR + EN, and the
  `CmExportFormatCard` frame)"*.
- New frame components go in `src/components/docs/`. The set already has
  `LinkrDashboardFrames`, `LinkrConceptMappingFrames`, `LinkrFirstProjectFrames` — an IDE
  and a versioning family are the two obvious gaps.
- Screenshots are **not** the house style: frames are hand-drawn React mockups, so they
  survive a UI restyle and theme correctly in dark mode.

---

## 8. Progress log

Pages are counted as done only once both locales are written, `draft: true` is
removed from `docs-nav.ts`, and the skill's four checks pass.

### Done — 2026-09-20

| Section | Pages |
|---|---|
| Concepts | `entities-and-sharing` |
| AI & automation | `agents` ⚑ · `llm-providers` · `skills` ⚑ · `mcp-authoring` |
| Workspace | `overview` · `projects` · `wiki` · `plugins` · `members-and-roles` · `settings` |
| Warehouse | **whole section** — `schemas` · `databases` · `datamarts` ⚑ · `data-quality` · `data-catalog` · `sql-scripts` · `etl-pipelines` |

### Sections complete

Getting started · Core concepts · Workspace · **Data warehouse** · Concept mapping ·
AI & automation. Six of twelve, 27 draft pages left.

⚑ = planned feature, shipped as a `<PlannedFeature>` page (renders in production).

### Next — the Project section (9 drafts)

`overview` is written; the rest are drafts: `datasets`, `cohorts`, `concepts`,
`patient-data`, `ide`, `pipeline`, `versioning`, `web-apps` ⚑. This is the biggest
remaining block and the one users hit most, so it comes before Dashboards (3),
Sharing (3), Administration (5), Reference (3) and Reports (3, all planned).

**Naming trap to handle when writing**: there are two unrelated "catalogs" and two
unrelated "pipelines". `warehouse/data-catalog` is a DCAT-AP description of a
database's contents; `sharing/community-catalog` is the index of published entities.
`project/pipeline` turns long-format warehouse data into wide datasets;
`warehouse/etl-pipelines` feeds one database from another. Each page must say which
one it is not.

### App-side fixes made while documenting

Documenting against the code keeps surfacing labels that no longer match the UI.
Fixed in `linkr` as they were found:

- `databases.type_database_desc` promised **SQL Server**; the dialog only ever offers
  PostgreSQL, MySQL, DuckDB and SQLite (commit `d294eef8`).

Found while documenting data quality, **not fixed** (app-side, needs a decision):

- A quality check whose SQL throws counts in the score's denominator but never among
  the passes, so broken SQL reads as bad data. Worth either excluding errored checks
  from the score or surfacing them separately.
- The MCP `upsert_dq_check` severity enum is `error | warning | info`, but the app's is
  `error | warning | notice`. `info` is not a valid app severity.
- Another dead key: `sql_scripts.script_db_default` ("défaut"/"default") has zero code
  references — there is one active database per collection, not a per-script override.
- `app_warehouse.nav_etl` has no left-sidebar entry; ETL pipelines are reachable only
  from the workspace home card. Worth checking whether that is deliberate.

Still open, not fixed:

- `fr.json` `import_invalid_zip` says "project.json manquant" though the app writes
  `entity.json`.
- Dead i18n keys found so far: `workspaces.tab_danger`, `export_include_data`,
  `project_nav.data_quality`, and the whole `data_sources.*` namespace (zero code
  references — `type_omop`, `type_file` etc. are not type choices in the product).
- `databases.identifier_info` says the slug is "le nom du schéma"; it is a DuckDB
  **catalog** (`ATTACH`), and in server mode the `ds_` prefix does not exist at all.

**Lesson, recorded because it cost time twice**: read the component, not the locale
file. A key existing in `fr.json` proves nothing about what the UI renders.

## Progress: the Project section is written (9/9)

All nine pages, both locales, four checks green, 232 pages built. Commits
`45b2803`, `c65ccad`, `d7cf4bd`, `2d36fbf`, `7c9b2e2` in `linkr-website`.

Seven are ordinary pages; two carry `<PlannedFeature>` and keep `draft: true` in the
nav so the sidebar shows a WIP badge while the page still renders in production:

- `project/pipeline` — `status="building"`. The page is a diagram editor with no
  execution. The app says so itself in a permanent banner, and `entity-io.ts`
  deliberately excludes `pipeline/` from the export.
- `project/web-apps` — `status="designed"`. Nothing is implemented; the page is
  written from `docs/planning/web-apps-plan.md`, including its undecided points.

### Corrections the audits forced

Three things I would have written wrongly from memory:

- **Datasets are not "stored as Parquet"**. Browser mode is IndexedDB; server mode's
  Parquet is a *cache* over an authoritative CSV/XLSX on disk.
- **Server-mode datasets are not read-only**, despite six comments in
  `dataset-store.ts` saying so — those guard dead legacy paths. The live UI edits
  through `applyOps`/`recordOps`, which has a working server branch.
- **The ETL Quality tab's Concepts view reads both columns from the target**, not
  source vs target (already fixed in the warehouse section).

### App-side issues found while documenting the Project section

Not fixed — recorded for a decision:

- `SummaryOverviewTab.tsx:243` renders a hardcoded English `rows` in both locales.
- `SummaryOverviewTab.tsx:269` wires the Reports section to `count={0}`, so it always
  shows "coming soon" regardless of content.
- The Summary header's "Owner" shows the signed-in user, not the project's author
  (`SummaryPage.tsx:80`).
- The pipeline inspector panel is not write-gated: a reader can edit a node's label.
  Server mode rejects it; browser mode silently accepts.
- The "Datasets" counter on Summary counts pipeline nodes, not datasets — expected
  while the pipeline is unbuilt, but it will need rewiring with it.
- More dead keys: `project_nav.data_quality`, 9 in `summary.*`, 8 in
  `project_settings.*`, 8 in `projects.*`, 4 in `pipeline.*`, 38 in `patient_data.*`,
  13 in `files.*`/`environments.*`, 61 of 331 in `datasets.*`.
- `files.ipynb_readonly_notice` is dead — `.ipynb` files ARE editable. Do not
  document them as read-only on the strength of that string.

### Next

Dashboards (3 drafts), Sharing (3), Administration (5), Reference (3), Reports (3,
all planned features). Written so far: 7 of 12 sections, 18 drafts remaining.

### Review pass on the Project section

The user reviewed the nine pages in the browser and sent corrections. What changed,
and what is worth remembering:

- **`project/concepts` was wrong at its root**, not just in its title. It was called
  "Concepts OMOP" and its prose assumed OMOP throughout, but the page reads whatever
  **dictionary the schema declares** — `d_items`/`d_labitems` on MIMIC, a home-grown
  reference table, or OMOP's `concept`. Retitled to **Concepts** (which is also the
  app's own label in both locales), rewritten around the dictionary, and every
  general claim made conditional. Two facts surfaced while verifying: a database can
  declare **several dictionaries** (a `_dict_key` column says which a row came from),
  and with no code column a concept list can only be copied **by id**.
  The same OMOP presupposition was fixed in `getting-started/first-project` and
  `quickstart-browser`.
- **"Wide format = one row per patient" was an approximation** in four places. It is
  one row per **unit of analysis** — patient, hospitalization, unit stay, day of stay
  — chosen exactly as a cohort's level is.
- **Both `PlannedFeature` pages lost their nav `draft: true`** on request, so the
  Project section now shows no WIP badge at all. The in-page banners stay: they are
  what tells a reader the feature is not available.
- `project/pipeline` gained the concrete "why": the executable chain
  (database → cohort → scripts → dataset → dashboard) and the daily unit-monitoring
  dashboard that refreshes itself. That example is what makes the feature legible.

### Screenshots

The demo pages carry 26 screenshots per locale in `public/images/demo/`, rendered by
`components/demo/DemoShot.astro`, which resolves the `-fr`/`-en` suffix from the URL.
Five now illustrate Project pages: `cohort-builder`, `concepts`, `board-haemodynamics`,
`datasets`, `ide`. The `concepts` one happens to be a MIMIC-IV database, so it proves
the page's own point. The list-page shots (`cohorts-list`, `databases-list`,
`patient-data-list`) were skipped — one card on an empty list illustrates nothing.

**Reusable for other sections**: `dash-*` (5) for Dashboards, `ecrf-*` (3) for the
collection/eCRF story, `analysis-table1`, `widget-config`, `widget-settings`,
`database-stats`, `board-summary`, `board-overview`.

## Sharing & catalog section written (2026-09-20)

Three pages × 2 locales: `import-export`, `community-catalog`, `publishing`. No
`PlannedFeature` banner — the catalog app side is complete (planning README §"Default
data & catalog") and publishing, although manual, is a real procedure rather than a
missing feature. Build: 232 pages, all four checks clean.

### The load-bearing distinction, repeated on both catalog-facing pages

**Browsing the catalog works in client mode; installing does not.** The reason is worth
keeping: the index is read through the **GitLab API v4 raw-file route**, the only one
sending `access-control-allow-origin: *`, so a static/WASM build reads it with no
backend and no token. Installing clones a repo, which needs the server.
`DeploymentBadges` has no "partial" value, so the catalog page carries
`client="unavailable"` plus one sentence saying the badge is about installing.

### Facts that shaped the pages

- **Three import sources, one dialog** — Upload ZIP · From Git · From the catalog
  (`import-source-dialog.tsx`), the third filtered to the calling page's type. This is
  the spine of `import-export`.
- **Conflicts are never resolved silently**: "Create copy" / "Overwrite", matched on
  `lineageId` **scoped to the target workspace**. The same entity in another workspace
  is deliberately not a conflict.
- **Git-linked asymmetry**: an entity's *own* export carries full content; only a
  **workspace** export reduces it to metadata + pointer. Both locales' hint strings say
  so explicitly, and the pages now do too.
- **Credentials are stripped by an allowlist** (`engine`, `inMemory`, `managed`), not a
  denylist — so a newly added field is withheld until listed. A database export carries
  **no rows at all**; publishing an open dataset means adding files to the repo by hand,
  outside the app.
- **Publishing is manual and has no button.** Fill provenance → push to a public repo →
  open a merge request on `linkr-catalog`. The app's only mention is the one-line
  `catalog.contribute` footer. A "Propose to catalog" prefill is 💤 in the planning
  README, so the page says it is "under consideration" in one sentence rather than
  carrying a banner.
- **The licence picker is real and worth documenting**: 12 SPDX licences in 5 families
  plus a custom option, text snapshotted into `LICENSE.md`, id+name kept in
  `entity.json`. The page groups them by family with a "which family for what" note —
  EUPL/CeCILL flagged for European and French contexts.
- **The Attribution tab is edit-only** (on create the author is you), and **unlocking a
  field commits the displayed value** — a trap worth a warning callout.
- **ORCID is entered on the profile, not the entity**, and is how another instance
  re-resolves the author on import instead of crediting the importer.

### Corrected mid-write

The per-project **Export** tab has **no include-data checkbox** — only the "mark it for
versioning" hint; `exportZip({})` is called with no options. The checkbox lives in the
per-entity `entity-versioning-dialog.tsx`. The first draft attributed it to the general
export window; fixed in both locales, reframed around per-file marking (there is no
blanket toggle: `BuildProjectZipOptions` is `{ _reserved?: never }`).

Also corrected: the workspace-export table said a project carries its "pipeline", copied
from the app's own i18n hint — but the pipeline is explicitly not versioned
(`entity-io.ts`). Replaced with "concept lists". **The app string itself is stale** and
should be fixed there: `app_versioning.export_section_desc_projects`, both locales.

### Partial installs

Installing a published **workspace** clones each child repo separately and best-effort;
a private child leaves its content behind and the dialog reports "Installed, but some
content is missing", naming which. Documented on the catalog page — it is the most
user-visible edge case of the whole section.

### Remaining

Dashboards (3 drafts), Administration (5), Reference (3), Reports (3, all planned
features). Written so far: **8 of 12 sections**, 14 drafts remaining.

### Restructure: git versioning moved out of Project (2026-09-20, user review)

The user's objection was structural and right: the git mechanism is **identical for
the nine entity types**, so detailing it on `project/versioning` made it both misplaced
and invisible to anyone working on an ETL pipeline, a mapping project or a workspace.

- **New page `sharing/git-versioning`** (4th in the section) owns the generic half:
  connecting a repository, the token (per user *and per host*), Quick actions vs
  Details, pulling, and what never leaves.
- **`project/versioning` trimmed 170 → 104 lines**, keeping only what a project export
  contains; its duplicated "why git" section was removed outright.
- Inbound links repointed: `concepts/entities-and-sharing` (the git card of the three
  ways to circulate), `dashboards/filters-and-more` (whose own text already said the
  mechanism is not dashboard-specific), and the sharing pages' git references.

**The workspace nuance the user asked for**, now the centre of the new page: a workspace
can carry its children **in full**, but the recommended arrangement is **one repository
per element**, each with its own cycle — the workspace then holding only a **pointer**.
Verified in `entity-io.ts`: the export branches per element on whether it is git-linked
(pointer) or not (full content), so **a mixed workspace is the normal outcome**, not a
special case. A typical one: the ETL pipeline and OMOP schema in their own repos, the
ongoing projects inside the workspace. Paired with the trap that an element's **own**
export always carries full content — only *workspace* exports reduce it to a pointer.

### Two more user corrections on `import-export`

1. "Toute entité s'exporte en ZIP et se réimporte de trois façons" made the ZIP the
   mandatory path, implying one must produce an archive even to version. Rewritten:
   **two mechanisms** (ZIP, git), the section now opening on two sibling route cards
   with Download/GitBranch icons.
2. The **catalog is not a third mechanism** — it is a **directory of git repositories**,
   and installing an entry is a clone. Both the summary and the catalog page now say so;
   the import dialog's third tab is presented as a shortcut onto the git route.

Also: the nine catalog types became **icon cards** in the app's own hues and lucide icons
(`entry-meta.ts` + `entity-colors.ts`), verified present in the built stylesheet — and
two frontmatter descriptions wrongly promised **plugins** in the catalog, which is not
one of the nine `ENTRY_TYPES`.

## Administration section written (2026-09-20)

Five pages × 2 locales: `production-install`, `configuration`, `auth-permissions`,
`server-files`, `backup-restore`. No `PlannedFeature` banner — everything documented
ships today. Build: 234 pages, all four checks clean.

Different reader from every other section: an IT administrator, not a clinician. The
pages are written accordingly — runbooks, variable tables, and explicit statements of
what does *not* exist.

### Documented as facts, each verified in code before writing

These would have been costly to get wrong, so none was taken on trust:

- **No SSO.** `auth_providers/__init__.py` registers exactly one provider; the `User`
  model already carries `auth_provider`/`external_id` and a nullable `password_hash`, so
  the *shape* is ready — but LDAP/OIDC/SAML have **zero implementation**. The page says
  so plainly rather than implying "configurable".
- **A user cannot change their own password.** `ChangePasswordDialog` POSTs to
  `/auth/change-password`, which **does not exist** (`auth.py` declares only
  login/refresh/logout/me), and the URL even misses the `/api/v1` prefix. Documented as
  "only an administrator resets a password". **App-side bug worth fixing.**
- **Users and roles are administrator-only**, despite `users:*`/`roles:*` appearing in
  the permission matrix: those routes depend on `get_current_admin`, a literal
  `role != "admin"` check. Granting them to a custom role makes the tab visible but every
  call 403s. Organizations, by contrast, *are* genuinely permission-gated
  (`require_global_permission`), and the page draws that contrast explicitly.
- **`LINKR_FS_BROWSE_ROOTS` empty = the whole filesystem** (the RStudio Server model,
  stated in `fs_browser.py`). This is the single most important line on the server-files
  page for a hospital admin.
- **The General tab's database form is localStorage-only** and does not reconfigure the
  backend; PostgreSQL is deliberately absent from it since switching engines mid-life has
  no migration path. Documented as a warning, since the form looks like it configures the
  server.

### Deployment traps the pages now cover

- **CORS**: the shipped compose hardcodes `http://localhost:3000`, and a wildcard makes
  the API *refuse to boot*. Deploying at a real hostname without editing this silently
  breaks every call in the browser. This was the biggest gap.
- **No TLS**: nginx listens on `:80` only, no 443 anywhere. The admin must front it.
  Paired with the two proxy traps: WebSockets must be upgraded on **`/api/`** too (the
  terminal lives there, not under `/ws/`), and timeouts must be long.
- **Two upload ceilings**: nginx 512 MB vs the API's 2 GB — the lower wins, which no file
  says. The page points at server paths as the better answer.
- **Rollback is not symmetrical**: migrations run on every start and do not replay
  backwards, so reverting the image tag does not revert the schema. Backup first.
- **A backup without the secret key is incomplete** — and fails *silently*, since
  `decrypt()` returns `None` rather than raising. The restore checklist ends on
  "connect to a database", the step that actually reveals it.

### Structure correction (user review, mid-write)

The user asked whether administration was coherent with the install page, and whether
install had been over-complicated. It had: the secret key and the data directory were
detailed in both. Install now keeps the runbook and defers the detail via anchors
(`configuration#la-clé-secrète`, `#le-dossier-de-données`), verified against built HTML.
The CORS/TLS section stays on install — it is about exposing an instance, not configuring
one.

### App-side issues found (not fixed)

- `/auth/change-password` called by the UI but never implemented (above).
- `app_version` is `"2.0.0-dev"` while `VERSION` is `2.4.1`, so `/health` reports a stale
  version — an admin verifying an upgrade there will be misled.
- `LINKR_POOL_TTL_SECONDS` is declared in config with no reader found; possibly vestigial.
- `LINKR_APP_MODE` claims `full|dashboard|viewer` but is only logged.
- `home.action_catalog_description` says "Browse plugins and extensions", but plugins are
  **not** a catalog entry type.
- `app_versioning.export_section_desc_projects` still mentions the pipeline, which is
  explicitly not versioned (already noted in the sharing log).

### Remaining

Dashboards (3 drafts), Reference (3), Reports (3, all planned features). Written so far:
**9 of 12 sections**, 9 drafts remaining.

## Last drafts finished — the doc set is complete (2026-09-20)

Nine pages × 2 locales across three sections. **No `DraftPage` remains anywhere, and the
built sidebar carries zero WIP badges.** Build: 234 pages, 124 internal links and 36
anchors all resolving.

### Dashboards

- **`analysis-widgets`** — the five statistical analyses, and how the test is chosen
  (auto via per-group normality, leaning non-parametric on doubt; chi² vs Fisher on the
  expected-count rule; per-variable pinning). Documented that displaying one needs only
  **read** access: the server owns the program per analysis and accepts a validated spec,
  never client code — the opposite of a code widget.
- **`spc-widgets`** — 10 chart types + auto, the four denominators (incl. patient-days and
  device-days by overlap), Anhøj by default with the reason WECO stacking was rejected,
  the single frozen baseline, and the five warnings. Carries a discreet note that the
  plugin is **built but never exercised in the running app** (plan §3, still 🔜 TO TEST).
- **`survey-widgets`** — **the brief's premise was wrong and the page corrects it.** The
  widget *analyses* an imported questionnaire export; it collects nothing. Collection is
  the patient board's feature, and the page cross-links rather than conflating them.
  **Only the Goupile preset parses today** — REDCap and XLSForm appear in the dropdown but
  are not wired to any `.tsx`, so the page says to import them as a plain table meanwhile.
  Also documents *why* no pie chart for multiple choice, and why a scale must keep its order.

### Reports — banner, and one corrected value

Nothing is built (all 7 plan steps 🔜); only a route, a stub page and a permission exist.
All three pages keep `status="designed"` and **`mode` changed from `both` to `server`**,
following this plan's own rule #4 (reports are server-mode only; getting it wrong sends a
WASM user after a feature that cannot exist for them). The browser-mode availability of
the exporters is listed as unsettled, since the bundle cost was never measured.

Two traps avoided in the copy: **inserting a figure freezes its filters, not its data**
(freezing is a second, deliberate act), and **no speaker notes / presenter view / slide
overview** — absent from the plan, so listed under what is not settled.

### Reference

- **`glossary`** — grouped by domain rather than alphabetical, each term linking to the
  page that develops it. Draws the two-catalogs distinction again.
- **`keyboard-shortcuts`** — all 33 bindings extracted from `types/shortcuts.ts`, the R vs
  Jupyter notebook split, the RStudio/Jupyter presets, conflict detection, and why
  `Cmd+N` is not used.
- **`release-notes`** — deliberately **not** a copied changelog: there is no CHANGELOG file
  and 1066 commits sit between the last two tags. The page explains how to read a version,
  points at the tagged releases, and covers the asymmetric rollback. It also warns that the
  health endpoint's version is a different number — see the app-side issue below.

### Status

**All 12 sections written**, FR + EN. Pages carrying a `PlannedFeature` banner (feature
designed, not built): `project/pipeline`, `project/web-apps`, and the three `reports/*`.

### App-side issues still open (unchanged, none fixed)

`/auth/change-password` called by the UI but never implemented · `app_version`
`"2.0.0-dev"` vs `VERSION` 2.4.1 on `/health` · `home.action_catalog_description` promises
plugins the catalog cannot list · `app_versioning.export_section_desc_projects` still names
the pipeline · SPC missing from `SYSTEM_PLUGIN_IDS` · `LINKR_POOL_TTL_SECONDS` and
`LINKR_APP_MODE` appear inert.
