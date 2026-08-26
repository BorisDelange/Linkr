# Export format harmonization

**Status**: 🚧 in progress — steps 0–4b shipped 2026-08-26; what remains is
5–7 (sibling repos, MCP, docs). Every entity writes `entity.json`, declares its `type`,
and opens with the same five identity keys; every reader accepts both the new name and the
one it used before. Step 5 is the one that touches published content.
**Decided**: `entity.json` for every entity, at every depth (containers and git-link stubs
included); the manifest declares **`type`**, sharing the catalog's field name and vocabulary;
git URL authored in the linked stub's `entity.json`, `git-links.json` regenerated as an index
(§6.2c); ETL and SQL collections get a **`scripts/`** container so `_tree.json` always sits
inside the folder it describes (§3.2); `_` means "sidecar", never a manifest (§6.3i); no
`entityId` for workspaces and no `Workspace.version`; `plugin.json` (the widget manifest) is
**not** renamed; the preset's `name`/`description` are promoted out of `mapping` to the root
(§3.4b, and removed from `mapping` there) while `mapping` moves out to its own `mapping.json` —
`entity.json` stays metadata-only (§3.4c); every identity + provenance key is always written, `null` when unset (§3.3).
**Net model change: zero** — all export-layer.
**Effort**: L (several days), spread over ~7 steps
**Touches**: `apps/web/src/lib/entity-io.ts`, `packages/linkr-format`, `packages/linkr-mcp`,
`apps/api/app/services/workspace_export*.py`, the seed loader, the catalog client, plus the
three sibling repos (`linkr-portal`, `linkr-catalog`, `linkr-public-content`).

## 1. Why

Every exportable entity got its export format written on its own day, with its own habits.
Nothing is *broken* — each entity round-trips — but the union of them has no rule anyone
could state in a sentence. That costs us three ways:

- **Authoring outside the app** (the whole point of `linkr-format` + MCP) needs a rule to
  teach. Today the answer to "where is the manifest?" is a lookup table with 8 entries.
- **Sibling repos hardcode our filenames.** The portal, the catalog and every public-content
  repo each carry their own copy of the naming table. A format change means four repos.
- **New entities keep inventing.** Reports (planned) and datamarts (planned) will each pick
  a name unless there is a convention to point at.

The goal is a format a newcomer can predict without reading `entity-io.ts`.

## 2. Where we are — the inventory

Manifest filename per entity, as emitted today:

| Entity | Manifest | Location | Extra root files |
|---|---|---|---|
| Project | `project.json` | root | `README.md`, `LICENSE.md`, `.gitignore`, `tasks.json` |
| Workspace | `workspace.json` | root | `README.md`, `organization.json`, `git-links.json` |
| Mapping project | `project.json` + `mappings.json` | root | `source-concepts.csv` |
| ETL pipeline | `_pipeline.json` | root | `README.md`, `LICENSE.md`, `.gitignore`, `_tree.json` |
| SQL collection | `_collection.json` | root | `README.md`, `LICENSE.md`, `_tree.json` |
| User plugin | `_plugin.json` **and** `plugin.json` | root | `README.md`, `LICENSE.md` |
| Schema preset | `preset.json` | root | `README.md`, `LICENSE.md`, `schema.ddl` |
| DQ rule set | `rule-set.json` | root | `README.md`, `LICENSE.md`, `checks.json` |
| Data catalog | `catalog.json` | root | `README.md`, `LICENSE.md` |

Five naming conventions for one concept: bare noun (`project`, `preset`, `catalog`),
underscore-prefixed (`_pipeline`, `_collection`, `_plugin`), and kebab (`rule-set`).

Add `_database.json` (databases, not standalone-exportable today) and the picture is worse
still: the same entity kind changes manifest name depending on **where** it is exported.

| Entity | Standalone | Nested in a workspace |
|---|---|---|
| Data catalog | `catalog.json` | `catalogs/<folder>/_catalog.json` (`entity-io.ts:3233`) |
| Mapping project | `project.json` | `project.json`, with `_project.json` still accepted on read (`entity-io.ts:3560`) |

### 2.1 The five real problems

**(a) No common manifest name.** Covered above. The `_` prefix was meant to sort the
manifest above the content, but it is applied to 3 entities out of 9 — and not even
consistently for a single kind (the catalog table above).

**(b) Plugins carry two manifests that both call themselves `plugin`.** In a workspace
export, `plugins/my-plugin/` holds `_plugin.json` (Linkr entity metadata: `id`, `entityId`,
`workspaceId`, `createdBy`, `createdAt`) *and* `plugin.json` (the plugin's own functional
manifest: `id`, `name`). Two files, two different meanings of `id`. This is the single most
confusing spot in the format.

**(c) Loose files at the root instead of folders.** Project scripts live in `scripts/` (good)
and the ETL's generated vocabulary CSV in `mapping/` (good) — but an ETL's own scripts sit
loose at the pipeline root, DQ checks are a root `checks.json`, the
schema DDL is a root `schema.ddl`, project tasks are a root `tasks.json`. The rule "README +
LICENSE + manifest at the root, content in folders" is followed about half the time.

Worse, inside a workspace **the same entity is a flat file or a folder depending on whether
it is git-linked** — three entities, same asymmetry, nobody else has it:

| Entity | Not linked | Git-linked |
|---|---|---|
| Schema preset | `schemas/<slug>.json` | `schemas/<slug>/_schema.json` |
| DQ rule set | `data-quality/<eid>.json` | `data-quality/<eid>/_ruleset.json` |
| Data catalog | `catalogs/<eid>.json` | `catalogs/<eid>/_catalog.json` |

Note `rule-set.json` (standalone repo) vs `_ruleset.json` (workspace pointer): kebab on one
side, collapsed on the other, for one concept. Always-a-folder removes the branch entirely —
and is what the existing backlog item about README/LICENSE not shipping in workspaces needs.

Folder naming is unprincipled too: `pipeline/` singular holding an array while `cohorts/`,
`dashboards/`, `datasets/` are plural; `sql-scripts/` vs `etl/` vs `data-quality/`. And
`databases/` means **two different types** — `IdeConnection` in a project (`entity-io.ts:1001`),
`DataSource` in a workspace (`:3089`).

**(d) Manifest fields diverge in presence and in order.** There is already a de-facto
**provenance block** — `createdBy`, `createdByDetails`, `lineageId`, `parentLineageId`,
`createdAt`, `version`, `license`, `organization` — emitted in exactly that order by the DQ
rule set, the SQL collection and the data catalog. But:

- `schema-preset` has **no `id`, no `name`, no `description`, no `lineageId`** (its
  `entityId` did all three jobs — see [schema-preset-identity-plan.md](schema-preset-identity-plan.md),
  whose step 5 is the matching cleanup). This is the user's "put an `id` even if unused" case.
- `project` puts `lineageId`/`parentLineageId` *before* `createdBy`, uses `projectId`
  alongside `entityId`, and has no `id`.
- `workspace` has `id` but no `entityId`, no `version`, no `license`, and spells the org
  `organizationId` (a string) where everyone else emits `organization` (an object).
- `appVersion` sits last on `project`/`workspace` and is **absent everywhere else** — yet it
  is the export-format version stamp, which every entity should carry.
- `user-plugin` writes `LICENSE.md` but no `license: {id, name}` block in its manifest (it is
  hand-built at `entity-io.ts:2328`), so **the licence identity is lost on round-trip**.
- `_plugin.json` differs between standalone and workspace: the workspace form drops `version`
  and lineage but writes `workspaceId` — an instance field that should never be exported.
- `organization` is inline-last for 7 entities, a **sidecar `organization.json`** for the
  workspace, and absent for a database exported by the app.

### 2.1b The identity fields, entity by entity

Extracted from the golden fixtures (what is *actually* emitted, not what the types allow):

| Kind | Identity, in order | Provenance, in order |
|---|---|---|
| `dq-rule-set` | `id, entityId, name, description` | `createdBy, createdByDetails, lineageId, parentLineageId, createdAt, version, license, organization` |
| `sql-collection` | `id, entityId, name, description` | *(identical to above)* |
| `data-catalog` | `id, entityId, name, description` | *(identical to above)* |
| `mapping-project` | `id, entityId, name, description` | `badges, createdBy, createdByDetails, lineageId, parentLineageId, createdAt, version` — **no `license`, no `organization`** |
| `project` | `entityId, projectId, name, description` — **no `id`** | `badges, lineageId, parentLineageId, createdBy, createdByDetails, version, createdAt, license, appVersion, organization` — **lineage before author, `version` before `createdAt`** |
| `workspace` | `id, name, description` — **no `entityId`** | `badges, createdBy, createdByDetails, lineageId, parentLineageId, createdAt, organizationId, appVersion` — **no `version`, no `license`** |
| `user-plugin` | `id, entityId` — **no `name`/`description`** | `createdBy, createdByDetails, createdAt, version, organization` — **no lineage, no `license`** |
| `schema-preset` | `entityId` only | `createdBy, createdByDetails, createdAt, version, license, organization` — **no lineage** |

**Three kinds already agree exactly** (`dq-rule-set`, `sql-collection`, `data-catalog`). That
shared order is the de-facto canon and §3.3 simply promotes it. The other five each break it
in a different way, so no two of the five are alike.

**The model itself is sound — only its application is not.** The types already express
identity as shared mixins (`types/author.ts`): `Authored` = `createdById?, createdBy?,
createdByDetails?` and `Lineaged` = `lineageId?, parentLineageId?`, both documented with a
clear rationale (the local PK may be regenerated on import; `lineageId` survives verbatim so
the *same work* stays recognisable across instances; a fork mints a new one and records the
old in `parentLineageId`). So the answer to "does everything have a lineageId?" is: **the type
says it should, the exporter forgets it for `schema-preset` and `user-plugin`.**

The four id-ish fields, and what each is for:

| Field | Meaning | Should every entity export it? |
|---|---|---|
| `id` | local primary key, regenerated on import | Yes — harmless, and its absence on `project` is an inconsistency, not a safety feature |
| `entityId` | the human-chosen slug at creation | Yes — `workspace` lacks it *on the type*, which is the real gap |
| `lineageId` | cross-instance identity of the work | Yes — required for catalog dedup and update detection |
| `parentLineageId` | the fork's origin, weak ref | Yes, `null` when not a fork |

`createdById` is correctly **not** exported (it is in `INSTANCE_FIELDS`): a local user PK is
meaningless on another instance, which is exactly why `createdBy` + `createdByDetails` exist
as the portable snapshot. Keep that.

Two consequences worth flagging before §3.3 is accepted:
- **`workspace` has no `entityId` on its type — DECIDED 2026-08-26: leave it that way.**
  Giving it one would mean a new field + migration + slug UI, and a workspace is not a
  publishable/forkable unit the way the others are: it is never installed from the catalog, so
  the cross-instance slug has no consumer. `entityId` is therefore **optional in the identity
  block** (`null` for workspaces), not universal. The format doc should say why, so it does not
  get re-raised as an oversight.
- **`schema-preset` and `user-plugin` missing `lineageId` breaks catalog update detection** —
  the catalog matches installed entities by `lineageId` (per the catalog plan). So this is not
  cosmetic: a published preset or plugin cannot currently be recognised as "already installed,
  newer version available". Schema-preset step 6 in its own plan already calls for re-exporting
  the 4 published preset repos to carry a `lineageId`; this is the same fix, generalised.

**Instance fields leak in exactly the un-goldened paths.** `updatedAt`, `createdById` and
`workspaceId` are stripped everywhere except the six workspace paths that write the raw row
(`schemas/`, `data-quality/`, `catalogs/`, `databases/`, `checks.json`, `wiki/_tree.json`).
That is the same set as divergence 1 in §2.2 — one root cause, two symptoms.

**(e) Not one filename is a named constant.** Every manifest name is a bare string literal,
retyped in the reader, the writer, the kind-detector and the human-readable error text —
`project.json` alone appears at 8 sites in `entity-io.ts` and 6 in `linkr-format`. The only
exported constant in the whole format is `SCHEMA_PRESET_DDL_FILE` (`entity-io.ts:673`).

This is not cosmetic: **the list has already drifted, in three separate places.**

*Prose lists.* The manifest names are retyped in two error messages and they disagree —
`linkr-format/src/node/cli.ts:26-28` omits `_database.json`, `linkr-mcp/src/server.ts:79-82`
includes it. A user validating a database repo with the CLI is told it is "not a Linkr
entity tree" while the MCP accepts it.

*Three lookup tables, kept in sync by hand, across two repos:*

| Table | Location | `mapping-project` says |
|---|---|---|
| `METADATA_FILE` | `linkr-format/src/validate/entities.ts:33-41` | `mappings.json` |
| `META_FILE` | `apps/web/src/lib/catalog/install.ts:51-59` | `_project.json` |
| `MARKERS` | `linkr-catalog/scripts/scan.mjs:36-44` | `_project.json` |

They already disagree, and none of them matches what is actually on disk: the published
`mapping-projects/mimic-iv-demo/` repo contains **`project.json`**, not `_project.json`.
Both the catalog scanner (`scan.mjs:350-355`) and the seed loader (`seed-loader.ts:577-578`)
carry an explicit comment + fallback to paper over this. An `entity.json` with a `type` field
deletes that heuristic outright rather than moving it.

*A fourth alignment.* `entry.schema.json`'s `type` enum mirrors `GitLinkedEntity['type']`,
so the catalog vocabulary is a fourth thing to keep in step (see §6.4).

The same pattern repeats below the filenames: `slugify` is byte-identical in
`entity-io.ts:403-410` and `ids.ts:47-56` with **no parity test**; the `json()` writer
(2-space, no trailing newline) is redefined 5 times; `SCRIPT_LANGUAGES` 3 times; the
`localized()` helper 3 times. Step 1 exists to end this, and is worth doing on its own
merits even if §6 is never decided.

## 2.2 Found while surveying: bugs that exist today

These are **not** consequences of harmonizing — they are live divergences the survey
turned up. They matter here because step 3 leans on the golden tests to prove a front/back
flip is byte-identical, and in these sections the goldens prove nothing.

**The workspace golden covers 6 of 12 sections.** `export-golden/workspace/input.json` has
no `schemaPresets`, `sqlCollections`, `etlPipelines`, `dqRuleSets`, `dataCatalogs` or
`serviceMappings` keys at all, and the Python twin passes empty lists
(`test_workspace_export.py:152-160`). The six per-entity goldens exercise only the
**standalone** layout, which is a different tree from the workspace-nested one. So the
nested layouts have **zero byte-parity coverage** — and that is exactly where these sit:

| # | Divergence | Front | Back |
|---|---|---|---|
| 1 | Workspace DQ / catalogs / schemas | writes the **raw** row — `json(sp)` (`entity-io.ts:3085`), `json(cat)` (`:3237`), `json({ruleSet, checks})` (`:3177`), keeping `readme`, `license` text, `updatedAt`, `ownerId` | writes `strip_entity_docs(...)` (`workspace_export_assemble.py:543, 604, 628`) |
| 2 | `workspace.json` `readmeLang` | never emitted (`entity-io.ts:2949-2955` adds only `licenseMeta`) | appended when the primary README is not English (`entity_docs.py:98-100`) |
| 3 | `git-links.json` order | `localeCompare` (`entity-io.ts:3270`) | code-point tuple sort (`workspace_export.py:560`) |

Divergence 3 is the subtle one: `entity-io.ts:724` already documents *in this very file*
that `localeCompare` reorders per locale and must not be used for ids — then uses it here.

**Recommendation:** fix these as **step 0**, before any renaming, each with the golden
fixture that should have caught it. Otherwise step 3's regenerated fixtures bake today's
divergence in as the new expected output, and the format change gets blamed for it later.

**Two more that are worse, because they lose or reject data:**

| # | Bug | Evidence |
|---|---|---|
| 4 | **A database repo exported by the app cannot be re-imported.** `buildDataSourceFolder` spreads a `DataSource`, whose field is `schemaMapping` (`types/index.ts:395`). The reader consumes `meta.schema` (`entity-io.ts:2489`, `DatabaseRepoMeta.schema`). So `meta.schema` is `undefined` and install throws *"declares the schema undefined, which is not installed"* | `entity-io.ts:2066` vs `:2489` |
| 5 | **Workspace concept sets are silently dropped on export.** `concept-sets/` is parsed (`:3538-3542`), typed into `ParsedWorkspaceZip` (`:3307`) and documented in the layout comment (`:1986`) — but `buildWorkspaceZip` never writes it. Export → reimport loses every concept set | no `zip.file('concept-sets/…')` exists |

Bug 4 has a trap for whoever fixes it: `applyClonedDatabase`'s docstring says *"Do not
harmonise the export to match."* That refers to **never writing data rows** (the safety
property that patient data cannot leave via the app) — not to the field name. Rename the
key; keep the metadata-only rule.

Two lesser ones, not blocking: `serialize/project.ts:336-352` re-derives tab keys inline
keyed by *label*, with none of the `#n` collision handling in the shared `keys.ts` it was
written to use — two tabs sharing an English name silently overwrite each other in the
authoring path. And the backend never writes dataset rows (`project_export_assemble.py:245`),
so the same project exports differently depending on which side builds it (intended, but a trap).

## 3. Target format

### 3.1 One manifest name

Every entity's manifest becomes **`entity.json`** at the root of the entity folder.

For entities that already own a *functional* manifest with a different meaning — plugins —
the functional file keeps its own name (`plugin.json`) and the Linkr entity metadata moves
into `entity.json`. That resolves problem (b) by giving the two files honest names instead
of a leading underscore.

**`plugin.json` is NOT renamed — the two files are different documents.** This is the easiest
thing in the plan to get wrong, so, explicitly:

| File | Is | Holds | After |
|---|---|---|---|
| `_plugin.json` | Linkr **entity metadata** — the same block every other entity has | `id`, `entityId`, `createdBy`, `lineageId`, `createdAt`, `version`… | **→ `entity.json`** |
| `plugin.json` | the **widget manifest** the app reads to load and render the plugin | `scope`, `category`, `runtime`, `languages`, `icon`, `iconColor`, `configSchema`, `tags`, plus its own `id`/`name`/`version` | **unchanged** |

A real default plugin's `plugin.json` (`packages/default-plugins/patient-data/*/plugin.json`)
carries `"scope": "warehouse"`, `"runtime": ["component"]`, `"icon": "User"` — none of which
is entity metadata. It is a plugin-ecosystem file, closer to a `package.json` than to a Linkr
manifest, and renaming it to `entity.json` would collide with the metadata file and break
`plugin-editor-store.ts`, `plugin-hash.ts` and the `@default-plugins/…/plugin.json` Vite
imports. The two simply coexist, each now honestly named.

### 3.2 One layout rule

> **Root** = `entity.json`, `README.md` (+ `README.<lang>.md`), `LICENSE.md`, `.gitignore`,
> the entity's own functional manifest if it has one, and **whole-repo sidecars** describing
> the export as a whole rather than one folder's contents.
> **Everything else** = in a folder, named by what it holds (plural noun).

The whole-repo sidecar clause covers the workspace's two root files, **confirmed 2026-08-26**:
`organization.json` (the publishing org — one per export, not a collection, so a folder would
be false precision) and `git-links.json` (the generated index from §6.2, which by definition
spans every folder and could not live inside any one of them). Both stay unprefixed: `_` marks
a sidecar describing *sibling files*, which is not what these do.

Concretely:

| Entity | Root | Folders |
|---|---|---|
| Project | `entity.json` README LICENSE .gitignore | `scripts/` `datasets/` `dashboards/` `patient-dashboards/` `cohorts/` `databases/` `pipeline/` `attachments/` `tasks/` |
| Workspace | `entity.json` README LICENSE `organization.json` `git-links.json` | `projects/` `mapping-projects/` `plugins/` `databases/` `wiki/` `schemas/` `dq/` `catalogs/` `source-concept-ids/` `service-mappings/` |
| ETL pipeline | `entity.json` README LICENSE .gitignore | `scripts/` — the whole *user* tree, any depth; `mapping/` — machine-managed (`MAPPING_DIR`), stays at the root |
| SQL collection | `entity.json` README LICENSE | `scripts/` — idem |
| User plugin | `entity.json` `plugin.json` README LICENSE | `src/` |
| Schema preset | `entity.json` `mapping.json` `schema.ddl` README LICENSE | — (payload is the two sibling files, §3.4c) |
| DQ rule set | `entity.json` README LICENSE | `checks/` |
| Data catalog | `entity.json` README LICENSE | `dimensions/` if it ever splits |

**Where `_tree.json` sits — and why ETL/SQL are the exception to fix.** Today the placement
differs, and it is a *symptom*, not an independent choice:

| Entity | Today | Why |
|---|---|---|
| Project | `scripts/_tree.json` | all scripts live under `scripts/`, so the sidecar describes that folder ✅ |
| Project | `datasets/_tree.json` | same ✅ |
| ETL pipeline | **`_tree.json` at the root** | files are scattered: `load.py` at the root **and** `steps/`, `mapping/` ❌ |
| SQL collection | **`_tree.json` at the root** | same: `top.sql` at the root **and** `queries/` ❌ |

The ETL and SQL trees sit at the root because they have to: their files are not under a single
container, so nothing else could describe them.

**What these files actually are.** An ETL pipeline's content is one flat table of `EtlFile`
rows (`types/index.ts`), each just `{name, type: 'file' | 'folder', parentId, content,
language, order, dataSourceId?, disabled?}` — a SQL collection has the same shape. So
`steps/`, `queries/`, `load.py`, `top.sql` in the fixtures carry **no format meaning**: they
are folders and files a user created in the file-tree UI and named however they liked. The
real published pipeline confirms it — its author put `00_vocabulary.sql` at the root and the
other 16 scripts in a folder they named **`etl/`**, matching none of the fixture names.

So the format must keep supporting an **arbitrary user tree** of any depth: `scripts/` is a
container, not a vocabulary.

**`mapping/` is the one exception — it *is* a format concept.** `MAPPING_DIR = 'mapping'`
(`lib/duckdb/mapping-source.ts:18`) is an exported constant. The Vocabulary tab auto-creates
the folder **at the pipeline root** (`!f.parentId`, checked at `EtlVocabularyTab.tsx:122, 334,
366, 458`) and writes the generated STCM/CCR export to `mapping/<name>.csv`; the generated SQL
script reads that exact path, and `mappingCsvPath`/its inverse parse it with a regex anchored
on `^mapping/`. The rows are deliberately kept out of the script (a mapping project is often a
private dictionary) and gitignored by default, with the per-file mark able to re-include them.

**Consequence for §3.2: `mapping/` stays a root-level sibling of `scripts/`, not inside it.**
Moving it would break the generated scripts, the readiness check and the path regex. It is a
machine-managed folder with a fixed name — the same class of thing as `attachments/`, not a
user folder. Only the *user's* tree moves under `scripts/`.

So the fix is not to move `_tree.json` — it is to give these two entities a real container,
exactly as the project has `scripts/`. The **entire user tree** moves inside it, unchanged and
at any depth, and the sidecar follows it down automatically.

**DECIDED 2026-08-26: `scripts/` for both.** One word means one thing across every entity, so
"where does code live in a Linkr entity?" is answerable once.

```
etl-pipeline/                     sql-collection/
  entity.json                       entity.json
  README.md  LICENSE.md             README.md  LICENSE.md
  .gitignore                        scripts/
  scripts/                            _tree.json
    _tree.json                        top.sql
    load.py                           queries/cohort.sql
    steps/extract.sql
  mapping/kept.csv    ← machine-managed, stays at the root
```

(Using the fixture's names for the *user* tree; a real pipeline's is whatever its author made —
the published one would become `scripts/00_vocabulary.sql` + `scripts/etl/01_…sql`.)

**Rule, once containers exist:** `_tree.json` always lives **inside the folder it describes**,
never at the entity root. One sentence, no exceptions.

Note that `config.versionedDataFiles` / `excludedFiles` are keyed by **export-tree path**
(`entity-io.ts:548`), so every path that gains a `scripts/` segment invalidates its stored
mark — **step 3 must rewrite those marks**, not just move the files. Getting this wrong
silently un-marks a user's versioned data file. (`mapping/` paths are unaffected: that folder
does not move.) The `.gitignore` `!path` exceptions are regenerated from the marks, so they
follow automatically once the marks are right.

### 3.3 One field order

**Yes — the same fields, in the same order, on every entity.** That is the whole point of this
section. The identity and provenance blocks below are **fixed and universal**; only block 2
varies by kind. `entity.json` is written in three blocks, always in this order:

```jsonc
{
  // 1. identity — same 5 keys on every entity, `null` when not applicable
  "id":              "dq1",
  "entityId":        "adult-icu-checks",
  "type":            "dq-rule-set",
  "name":            { "en": "…", "fr": "…" },
  "description":     { "en": "…", "fr": "…" },

  // 2. entity-specific payload — whatever this kind needs
  "dataSourceId":    "warehouse",
  "status":          "ready",

  // 3. provenance — same 9 keys on every entity, always last, always this order
  "createdBy":        "Boris Delange",
  "createdByDetails": { … },
  "lineageId":        "…",
  "parentLineageId":  null,
  "createdAt":        "2026-01-01T00:00:00.000Z",
  "version":          "1.0.0",
  "license":          { … },
  "organization":     { … },
  "appVersion":       "2.x.y"
}
```

**`null` or omitted? A decision with a hard constraint attached.**

Writing every key always, with `null` when unset, is the cleaner contract: a reader can tell
"known to be empty" from "written before this field existed". But it collides with something
load-bearing — **the front is JS and the back is Python, and they must emit byte-identical
files.** `JSON.stringify` drops `undefined` keys; Pydantic always emits an explicit `null`. The
backend therefore carries hand-written shims that pop nulls back out purely to match JS:

```python
# workspace_export_assemble.py:824
for key in ("lineageId", "parentLineageId", "id", "entityId"):
    if dumped.get(key) is None:
        dumped.pop(key, None)
```

and `_badged_dump` (`:104-115`) does the same for `badges`, with a comment noting that
**projects and workspaces store the field explicitly, so their null must be *kept*** — i.e.
the current rule is not even uniform across entities. This is the fiddliest, most drift-prone
corner of the whole format.

Harmonising to **always-write-null actually simplifies both sides**: the Python shims delete
themselves, and the JS side writes `x ?? null` instead of a conditional spread. The rule
becomes one sentence with no per-entity exceptions. The cost is a one-time diff on every
existing export (keys appear with `null` where they were absent), which step 3 is already
paying for the rename.

**DECIDED 2026-08-26: always write the key, `null` when unset**, for the 5 identity + 9
provenance keys. Block 2 (entity-specific payload) keeps using omission for genuinely optional
fields — forcing `null` on every unused config key would bloat the files for no gain.
Consequence to carry into step 3: the Python null-popping shims (`:824`, `_badged_dump`) are
**deleted**, not extended, and the JS side writes `x ?? null` instead of a conditional spread.

**Is the current order logical, or should it change?** Mostly logical — it should be *adopted*,
not redesigned. The `dq-rule-set` / `sql-collection` / `data-catalog` order above reads well:
*who am I* → *what am I* → *where do I come from*, with the volatile/derived values
(`version`, `license`, `organization`, `appVersion`) trailing. Diffs stay readable because the
stable identity sits at the top and churn collects at the bottom.

Two things I would change from that de-facto canon:

1. **`name`/`description` belong with identity, not payload.** They already do in the canon;
   the point is to state it, so nobody puts them after a `status` field again.
2. **`appVersion` last, after `organization`.** Today `project` puts `appVersion` before
   `organization` only because `attachEntityOrganization` re-opens the file and appends
   (`entity-io.ts:2138`). That is an implementation artifact, not a decision. Since it is the
   format-version stamp, the natural home is the very end — or arguably the very top, as
   format-version markers usually come first. I lean **last**, to keep the whole provenance
   block contiguous, but it is a fair thing to overrule.

`project`'s order (lineage before author, `version` before `createdAt`) has no rationale I can
find — it is simply the order the record happened to be built in. Same for `workspace`'s
`organizationId` sitting between `createdAt` and `appVersion`.

Three deliberate changes beyond reordering:

- **`type` is new** (field name and values settled in §6.4 — same vocabulary as the catalog
  entry schema). Today the importer sniffs the entity type from filenames (`mappings.json`
  present ⇒ mapping project). An explicit `type` makes detection a field read, and is what
  lets a single `entity.json` name work at all.
- **Identity fields are always present, even when unused** — the schema-preset case. A preset
  gets `id`, `name`, `description`, `lineageId`; a plugin gets `name`, `description`, lineage;
  a project gets `id`; a workspace gets `version` and `license`. `null` beats absent: a reader
  can tell "known to be empty" from "this writer predates the field". **One documented
  exception:** `workspace.entityId` stays absent by decision (§2.1b) — a workspace is never
  catalog-installed, so a cross-instance slug has no consumer.
- **`organizationId` → `organization`**, so the workspace matches everyone else.
  `appVersion` moves onto every entity.

### 3.4 What changes, entity by entity

The target restated as a delta — every cell is a field that has to start being written
(all under step 3b unless noted). Compare with the as-is table in §2.1b:

| Kind | Gains |
|---|---|
| `dq-rule-set` | `type` only — already canonical |
| `sql-collection` | `type` only — already canonical |
| `data-catalog` | `type` only — already canonical |
| `mapping-project` | `type`, `license`, `organization`, `appVersion` |
| `project` | `type`, `id`, `appVersion` moved last; lineage/author reordered; `projectId` retired¹ |
| `workspace` | `type`, `license`, `organization` (replacing `organizationId`), `appVersion` last; **not** `entityId`, and `version` stays `null` (§3.4) |
| `user-plugin` | `type`, `name`³, `description`³, `lineageId`, `parentLineageId`, `license`², `appVersion` |
| `schema-preset` | `type`, `id`, `name`³, `description`³, `lineageId`, `parentLineageId`, `appVersion`; `presetId` retired¹ |
| `database` | `type`, `name`/`description` confirmed, lineage, `license`, `organization`, `appVersion`; `schemaMapping`→`schema` (bug 4) |

¹ `projectId` and `presetId` are the legacy identity fields that `entityId` replaced; retiring
them is schema-preset-identity step 5, which this plan absorbs.
² `user-plugin` currently writes `LICENSE.md` with no `license` block, losing the licence
identity on round-trip (§2.1d).
³ Not top-level today — derived from `plugin.json` (plugin) or promoted out of `mapping` (preset, §3.4b).

So: **three entities are already right, and the other six each need between 3 and 7 fields
added.** Most of it is export-layer only — the field exists on the type and the exporter simply
never wrote it (`license` and `version` on `UserPlugin`, `lineageId`/`parentLineageId`
everywhere via the `Lineaged` mixin, `license` on `Workspace`).

**Three cases were not just an exporter change — all decided 2026-08-26:**

| Field | Situation | Decision |
|---|---|---|
| `UserPlugin.name` / `.description` | Not on the type — they live in the *functional* `plugin.json` (which is **not** renamed, see §3.1) | **Derive at export** from `plugin.json`. One source of truth, no migration, and the plugin keeps naming itself where its ecosystem expects |
| `Workspace.version` | Not on the type | **Do not add it.** A workspace is not a published, versioned unit — it is the container. `version` stays `null` in its manifest |
| `CustomSchemaPreset.name` / `.description` | Not top-level — they live *inside* `mapping`, as `presetLabel` and `description` | **Harmonise: promote them to the root** as `name`/`description`. See §3.4b — this does **not** touch `MAPPING_FIELD_ORDER` |

So the net model change is **zero**: three derivations/promotions and one deliberate `null`.
Step 3b stays entirely in the export layer — which is the outcome that keeps it S/M.

### 3.4b Schema preset: promoting `name` and `description` to the root

An earlier draft of this plan declined this as "too entangled with `MAPPING_FIELD_ORDER`'s
three byte-identical implementations". **That was wrong, and the distinction matters:**

`mapping` is a *nested object* with its own internal key order. The manifest **root** —
`entityId`, `mapping`, `createdBy`, `createdAt`, … — is a separate level with its own order.
Adding `name`/`description` at the root changes the root key order only; `MAPPING_FIELD_ORDER`
governs what happens *inside* `mapping` and is untouched. The three implementations
(`schema-mapping.ts`, `entity-io.ts`, `_canonical_schema_mapping`) stay as they are.

**The app already wants this.** `toSchemaPresetItem` (`use-schema-preset-actions.tsx:13-22`)
exists purely to synthesise the missing field, and its comment states the anomaly outright:
*"a preset carries its label inside the mapping (`presetLabel`) rather than at the top level."*
Every shared component taking an `{ id, name }` contract needs that wrapper today. Promoting
`name` deletes the reason for it.

**The data already exists**, populated, in every published preset:

```jsonc
// @Linkr public content/database-schemas/omop-cdm-5.4/preset.json — today
{
  "presetId": "omop-cdm-5-4",
  "mapping": {
    "presetId":    "omop-cdm-5-4",
    "presetLabel": { "en": "OMOP CDM 5.4", "fr": "OMOP CDM 5.4" },
    "description": { "en": "OMOP Common Data Model 5.4 — 39 tables…", "fr": "…" },
    …
  },
  …
}
```

Two `LocalizedString`s, exactly the shape every other entity's `name`/`description` has —
just nested one level deeper, where no generic reader looks. The catalog scanner, the
validator and the portal all read `name`/`description` from the root for the other eight
kinds and have to special-case the preset today.

**Target:**

```jsonc
{
  "id": "sp1", "entityId": "omop-cdm-5-4", "type": "schema-preset",
  "name":        { "en": "OMOP CDM 5.4", … },        // ← was mapping.presetLabel
  "description": { "en": "OMOP CDM 5.4 — 39 tables…", … },  // ← was mapping.description
  "mapping": { … },                                  // internal order unchanged
  "createdBy": …, "lineageId": …, "appVersion": …
}
```

**DECIDED 2026-08-26: remove them from `mapping` — but only in the preset's own export.**
The check against `schema-mapping.ts` that this decision was waiting on found a constraint
that narrows the scope:

`SchemaMapping` is documented as *"Stored per DataSource"* (`schema-mapping.ts:20-24`), and
`presetLabel` is a **required** field on it (`:27`). A database does not *reference* a preset —
it **copies** `preset.mapping` into its own row (`DataSource.schemaMapping`,
`types/index.ts:395`). That copy is what lets a database show its schema name
(`DatabaseCard.tsx:49`, `DatabaseDetailPage.tsx:73, 515`, `AddDatabaseDialog.tsx:508, 704`)
without resolving a preset that may not be installed on this instance at all.

So the rule is scoped by *whose* mapping it is:

| Where | `presetLabel` / `description` |
|---|---|
| **`schema-preset/mapping.json`** — the preset's own export | **Removed.** The entity's `entity.json` carries `name`/`description`; keeping them inside too would be the duplication we are eliminating |
| **`DataSource.schemaMapping`** — a database's copied mapping | **Kept.** It is that database's only record of which schema it uses; nothing else in a `databases/<eid>.json` names it |

Consequences for the implementation:
- `MAPPING_FIELD_ORDER` keeps both keys (the DataSource case still emits them); the preset
  writer simply omits them. The order constant only ever shrinks by *not writing* a key, never
  by losing it — so the three byte-identical implementations stay aligned.
- The preset **reader** must reconstruct `mapping.presetLabel` from the root `name` when
  loading a preset into the app, since `SchemaMapping` requires it. That is a few lines in the
  import path, not a type change — and worth a comment saying why the asymmetry exists.
- `use-schema-preset-actions.tsx:22` already papers over this today
  (`name: preset.mapping.presetLabel`, with a comment noting the label lives inside the
  mapping "rather than at the top level"). After §3.4b that shim disappears — the root `name`
  is real.

### 3.4c `entity.json` is metadata — payload goes in its own file

**A general rule, prompted by looking at a real published `preset.json`.** Measured on
`database-schemas/omop-cdm-5.4/preset.json` (9 055 bytes):

| Part | Size | Share |
|---|---|---|
| `mapping` | 7 558 B | **83 %** |
| everything else (identity + provenance) | 972 B | 11 % |

The manifest is 83% payload. That is backwards for a file whose job is to say *what this
entity is* — and it is the file a human opens first on the forge, the one the catalog scanner
parses, and the one a `git diff` should keep readable.

**The format already does this elsewhere — the preset just stopped halfway:**

| Entity | Manifest | Payload lives in |
|---|---|---|
| DQ rule set | `rule-set.json` (1.0 KB) | `checks.json` ✅ |
| ETL pipeline / SQL collection | manifest | `scripts/` + `_tree.json` ✅ |
| Schema preset | `preset.json` | `schema.ddl` ✅ **and `mapping` inline** ❌ |

The preset already externalised its DDL, for reasons stated in `buildSchemaPresetFolder`'s
docstring (~50 kB of SQL on one escaped line makes an unreadable diff). Exactly the same
argument applies to a 7.5 KB mapping — it is just below the threshold where anyone noticed.

**Rule for the target format:**

> `entity.json` carries identity + provenance + small scalar config. Any substantial
> structured payload — more than a few hundred bytes, or anything a user meaningfully edits —
> gets its own file beside it.

Applied:

```
schema-preset/
  entity.json      ← id, entityId, type, name, description, provenance   (~1 KB)
  mapping.json     ← the 7.5 KB mapping                                   ← NEW
  schema.ddl
  README.md  LICENSE.md
```

This also makes §3.4b's promotion feel natural rather than arbitrary: `name`/`description`
belong to the *entity*, so they rise into `entity.json`; the table/column mapping belongs to
the *schema*, so it moves out to `mapping.json`. One file per concern.

**Consequences to weigh** (worth your call before step 3 commits to it):
- `MAPPING_FIELD_ORDER` and its three implementations still govern `mapping.json`'s contents —
  unchanged work, just a different file. No extra coordination cost.
- Readers gain one file to fetch. The catalog scanner benefits: it reads root `name`/`type`
  and can skip a 7.5 KB body it never uses.
- Same question arises for `data-catalog`'s `dimensions` (small today, 152 B in the fixture) —
  I would **not** split it yet; the rule is about size and edit-frequency, not symmetry.

**Checked against the other entities: the preset is the only real offender.** A published
`project.json` is 1 647 bytes with nothing inline above ~330 B (its dashboards, datasets and
scripts are already separate files); the DQ rule set already externalises `checks.json`. So
this is a one-entity fix that establishes a rule for the future, not a sweep — which is what
keeps it inside step 3 rather than becoming its own effort.

The rule earns its place mainly for **new entities**: reports and datamarts (both planned)
will each have a substantial body, and without a stated rule each would default to stuffing it
into its manifest, exactly as the preset did.

This does mean `null` appears in a few manifests (`workspace.version`). That is the §3.3 rule
working as intended: a reader sees "known to be empty", not "this writer was older than the
field".

## 4. Plan

Each step ends green (tests + a real export/import round trip). Steps 1–2 are the
load-bearing ones; 3–6 are mechanical once they land.

**Step 0 — Close the golden blind spot, then fix the 5 bugs (M). DONE 2026-08-26 (`f11baa0f`).**
Prerequisite, not cleanup. First extend `export-golden/workspace/input.json` (and the Python
twin's inputs) to populate the six empty sections, so the nested layouts are byte-compared at
all. That alone should turn divergences 1–3 red. Then fix them: decide raw-vs-stripped for the
workspace DQ/catalog/schema sections (stripped, to match every other scope), emit `readmeLang`
on the front, and replace `localeCompare` with a code-point compare in `git-links.json`.
Ship before any rename — these fixes are readable on their own, and burying them inside a
5 000-line format diff makes both unreviewable.

**Step 1 — Centralise the names (S). DONE 2026-08-26 (`fe411b39`).**
No behaviour change. Extract every literal filename into one exported table in
`packages/linkr-format` (`layout.ts`: manifest name, folder names, sidecar names, per kind)
and make `entity-io.ts`, the validator, the serializer and the MCP import it. Fold in the
three drifted lookup tables (`METADATA_FILE`, `META_FILE`, `MARKERS`) and the two prose error
lists, plus the `slugify` / `json()` / `SCRIPT_LANGUAGES` / `localized()` copies from §2.1(e).

Two constraints the survey surfaced: `linkr-catalog` is a **separate repo** and cannot import
the package, so its `MARKERS` stays a copy — give it a generated-from-source check in CI
instead of hoping. And the Python side has no access to a TS module, so `layout.ts` needs a
Python twin kept in step the way `_canonical_schema_mapping` already is, guarded by goldens.

This step is worth doing even if the rest is deferred — it turns the later rename into a
one-file edit and immediately fixes the CLI-rejects-a-database-repo bug.

**Step 2 — `entity.json` + `type` + field order, readers first (M). DONE 2026-08-26 (`1fa363e9`).**
Teach every reader to accept `entity.json` **and** the current name, and to accept both
field orders (a reader never cares about key order — only the writers do). Add `type`,
defaulted from the sniffing logic when absent. Ship this alone: after it, an old export still
imports and a new one already does. Readers to touch: `entity-io.ts`, the validator's
`detectTreeKind`, `install.ts`, `seed-loader.ts`, `scan.mjs`, and the portal's `build.sh`.

**Step 3 — Flip the writers (M). DONE 2026-08-26 (`93099957`).**
Emit `entity.json` and declare `type`; give ETL and SQL collections a `scripts/` container,
which moves their `_tree.json` off the root and is the change most visible to existing repos.
A pipeline's `mapping/` deliberately stays at the root: it is machine-managed and the
generated vocabulary script reads `mapping/<name>.csv` by that exact path.
Front and back flipped in the same commit — the golden tests compare them byte for byte, so
a half-flip is a red build. `app/services/export_layout.py` is the hand-kept Python twin of
`layout.ts`. All 9 golden fixtures regenerated; that diff *is* the format change.

*Deferred out of step 3, into 3b:* the new field order, the always-present identity fields,
`organization` on the workspace, `appVersion` everywhere, splitting the preset's `mapping`
out to `mapping.json` (§3.4c), and folding the git URL into the linked stubs (§6.2). Step 3
renamed the **pointer files** to `entity.json` too — a workspace tree with two manifest names
side by side would have defeated the point — but left their five inconsistent *shapes* alone.

**Step 3a — Flip the readers (M). DONE 2026-08-26 (`7ebe5cd0`).**
Not in the original plan, and the step that mattered most in practice. The writers alone left
Duplicate broken on every foldered entity: it round-trips through the current writer, so it
read back a ZIP whose names it no longer knew and produced an entity with no files. Each
importer had spelled its own fallback chain out inline, which is precisely why one move broke
six pages at once — `readImportedManifest` / `readImportedTree` are now the single place that
knows which names a tree may carry. The ETL and preset pulls threw outright; the
mapping-project pull was worse, falling back to `{}` and reporting "no metadata changes".

Two writer bugs surfaced here, both the same shape: `attachEntityOrganization` no-opped when
handed a path the zip did not contain, so two call sites still asking for `project.json`
silently dropped the publishing organization. It throws now.

**Step 3b — Make the identity + provenance blocks universal (S/M). DONE 2026-08-26.**
Every kind now opens with the same identity block — `entityId, type, name, description` — and
ends with the same provenance block, contiguous and in one order:

```
… payload …
createdAt                                  when
createdBy, createdByDetails, organization  by whom (person AND publishing org)
lineageId, parentLineageId                 from what
version, license                           how it is published
appVersion                                 the file's format version, last
```

`organization` sits with the author rather than beside `version`/`license`: the Edit dialog's
authoring section (`authoring-fields.tsx`) edits the two together and `AuthoringValue` groups
them in one type — it is co-authorship, not packaging. It used to trail the whole file only
because `attachEntityOrganization` re-opens the manifest and a plain assignment appends.
`workspace` keeps its documented `entityId` exception.
Delivered: `name`/`description` for `schema-preset` (promoted out of `mapping`) and
`user-plugin` (derived from its `plugin.json`), `license` for `user-plugin` (which wrote
`LICENSE.md` with no `license` block, losing the identity on every round trip) and for
`workspace`, `appVersion` everywhere, `projectId`/`presetId` retired,
`organizationId` → inline `organization` on the workspace, and the preset's `mapping` split
out to its own `mapping.json` (§3.4c) — measured at **88%** of the published
`omop-cdm-5.4/preset.json`, so that file goes from 9 KB to ~1 KB of identity.

**`id` — removed from every manifest.** The plan justified adding it by saying other kinds
round-trip theirs. Investigating who actually *reads* it settled the question the other way:

- `isSameEntity` (`install.ts:150`) matches on `lineageId` or the git remote and explicitly
  refuses to treat a shared `id` as identity — it is documented there as a hazard, since "a
  hostile or careless catalog entry must never be able to destroy a local entity by
  id-collision".
- The three import paths each mint or keep their own key: a ZIP import mints
  (`crypto.randomUUID()`), a git clone keeps the row it already has, and the catalog install
  adopts the repo's only as a *convenience default*.
- Cross-entity references do not need it either: they are deliberately destroyed on export
  (`dataSourceId: ''`, `EXTRA_INSTANCE_PIPELINE_FIELDS`), never resolved. *Within* one tree
  the links survive by remapping every id through `deterministicId(projectUid, oldId)`, which
  needs the value only as a join key.

So `entityId` is the portable slug, `lineageId` the cross-instance identity, and `id` had no
third job. It is gone from all 22 manifests, the git pointers included — the pointers now carry
`entityId` + `lineageId` instead.

**The import had to move with it** (step 3b would otherwise have broken re-import):
`parseWorkspaceZip` mints a local key when the manifest carries none, and `doImport` matches an
existing workspace, and each of the five lineage-bearing child kinds, on `lineageId` via a new
`resolveByLineage`. That helper reports the row it *replaces* rather than inferring it from
`id === child.id` — a test that only worked while the ZIP carried the writing instance's key,
and would now silently never fire, leaving duplicates behind on every re-import.

Two kinds keep `id`: `concept-set` and `service-mapping` are **not** application entities (they
are absent from `ENTITY_TYPES`, have no repo, no `entityId` and no lineage), so their local id
is all that identifies them inside a workspace.

**Gap closed** (commit `7f02e073`). The resolution used to live inside `WorkspacesPage.doImport`,
a 1000-line component with no tests at all — the golden suites cover the export bytes, not the
import that consumes them, so the re-import-overwrites-in-place path rested on manual testing.
The three resolvers now live in `lib/import-identity.ts` with 16 tests; the component keeps its
storage plumbing and calls the tested rule, so what runs is what the tests pin. Checked by
mutation: restoring the old `id`-based match fails three of them, including the
every-round-trip-duplicates case that motivated the switch to lineage.

**One more bug found on the way.** `service-mappings/*.json` was written raw (`json(sm)`),
with no `stripInstanceFields` — so every workspace export published `workspaceId` (this
instance's) and `updatedAt` (churns on every edit). Same bug the schema/DQ/catalog sections
had at step 0, in a section that had no golden coverage until this effort widened it.

**`projectId` retired** at the same time, for the same reason `presetId` was: it is `entityId`
under its former name, written twice. Every reader already tries `entityId` first, so old
repos keep importing and nothing new emits it.

`presetLabel`/`description` are removed from the preset's own `mapping.json` but **kept** in a
database's copied `schemaMapping` — `SchemaMapping.presetLabel` is required, and it is that
database's only record of which schema it uses. `reassemblePresetMapping` restores them on
import from the root `name`, so the asymmetry never leaves the export layer.

**Entirely export-layer — no model change** (§3.4 settles the three edge cases): plugin
`name`/`description` are derived from its `plugin.json`, the preset's are promoted out of
`mapping` to the root (§3.4b), and `Workspace.version` stays `null`. `workspace.entityId` stays
out of scope (§2.1b). Do this **with** schema-preset-identity step 5/6, which already calls for
re-exporting the 4 published preset repos with a `lineageId` — the same re-export carries the
promoted `name`/`description`, so the two land in one pass over those repos.

**Step 4 — Plugins: split the two manifests (S). DONE 2026-08-26.**
Delivered by step 3: `_plugin.json` → `entity.json`, with the plugin's own `plugin.json`
keeping its name and its functional meaning, in both the standalone and the workspace-nested
layouts. The remaining `_plugin.json` mentions are reader fallbacks (`layout.ts`,
`seed-loader.ts`) and stay, so a seed baked before the rename still loads.

**Step 4b — The git pointers, which step 3 renamed but never reshaped (S). DONE 2026-08-26.**
Step 3 renamed the pointer files to `entity.json` and explicitly left their five *shapes*
alone. Reviewing them against the finished identity block showed the drift was worse than
"inconsistent field sets" — three of the seven were still writing retired or forbidden fields:

- **`dq-rule-set`** nested itself under `{ ruleSet, checks: [] }` instead of being a manifest,
  and was **the last writer still emitting the local `id`** — the earlier "zero remaining"
  sweep only inspected top-level keys, so it hid one level down.
- **`project`** still wrote `projectId`, retired in step 3b.
- **`schema-preset`** still wrote `presetId` *and* inlined the `mapping` payload the same step
  had just split out to `mapping.json`.
- None of the seven declared `type`, and only four carried `lineageId` — without which a
  re-import matches nothing and lands as a duplicate (§3b, `resolveByLineage`).

One `gitPointerManifest` helper (plus its Python twin in `export_layout.py`) now writes all
seven: `uid?, entityId, type, name, createdAt?, lineageId, gitRemoteConfig`. `lineageId` is
written even when null — omitting it is what made a pointer re-import as a duplicate.
The DQ reader accepts both shapes, since the `{ ruleSet, checks }` bundle is still the right
form for an *unlinked* rule set, where the checks are its content.

**Step 5 — Sibling repos (M).**
In lockstep, since they read our trees. The survey found more attachment points than expected:
- `linkr-portal` — `scripts/build.sh` has ~25 `[ -f "$dir/<marker>.json" ]` tests (l. 94-342);
  its `tree_files_json` helper (l. 38-50) is already parameterised by the marker, so that is
  the clean hook. `sync-git-links.sh:54` + `dir_for_type:40-51`. Plus
  **`.claude/skills/add-element-to-workspace/SKILL.md`** — executable, writes stubs, silently
  breaks otherwise. `linkr-portal-ricdc`'s scripts are byte-identical to the template, so fix
  once, re-sync twice.
- `linkr-catalog` — `MARKERS` (`scan.mjs:36-44`), the root-only lookup (`:341`), the
  `mappings.json` heuristic (`:350-355`), and `entry.schema.json`'s `type` enum.
  **CI risk:** `--verify` compares committed entries against `DERIVED_FIELDS` re-read from
  each repo (`scan.mjs:405-412`), so a manifest rename without a scanner update **turns the
  catalog CI red on all 9 entries**. Note `git.path` already exists in the entry schema for
  non-root entities but `scan.mjs` never emits it.
- `linkr-public-content` — ~10 independent git repos, each re-exported by hand once step 3
  lands. Beware: the public folder names (`etl-pipelines/`, `database-schemas/`) differ from
  the portal's (`etl/`, `schemas/`) — independent namespaces, not a bug to "fix".
- Our side: `seed-loader.ts` (~20 hardcoded paths) cannot list directories over `fetch`
  (`:813`), so every path is explicit and must be updated by hand.

**Step 6 — MCP + authoring surface (S/M).**
`describe_entity_schema` / `describe_tree` / `validate_entity` / `write_entity` describe the
layout to an LLM, so their prose and examples are part of the format. Update the
`linkr-authoring` skill references too.

**Step 7 — Docs (S).**
`docs/architecture.md` § *Format package & MCP authoring* becomes the single written
statement of the rules in §3, and `../linkr-website` gets the user-facing version.

## 5. Migration & compatibility

The user's standing preference is **no complex back-compat layers** — clean the base rather
than carry a compatibility shim. Applied here, the cheap-but-tolerant reading:

- **Readers stay tolerant permanently.** Accepting a second filename and a second field
  order is a handful of lines in one place (after step 1), not a layer. It costs ~nothing
  and it is what makes every already-published repo keep working.
- **Writers are not tolerant.** One format out, no flag, no option.
- **No migration script.** Content already in git re-exports itself the next time it is
  pushed from the app. The public-content repos get re-exported by hand in step 5.

The risk to name: a repo exported by the new app and read by an old portal build breaks.
Sequence step 5 so the portal is updated **before** the public-content repos are re-exported.

## 6. Decisions (all settled 2026-08-26)

**6.1 `entity.json` for projects and workspaces too? — DECIDED 2026-08-26: yes.**
`entity.json` everywhere, no exceptions, containers included. The rule is worth more than
the familiarity of `project.json`. Consequence to plan for: `project.json` is the name every
published repo, the MCP tool docs and the website currently use, so step 2's tolerant reader
is what keeps those working, and step 5 re-exports them.

**6.2 Git pointers — DECIDED 2026-08-26: (c), URL in the stub + generated index.**

There are **two** separate things, and only the first is really in question.

*The per-entity pointer.* When an entity inside a workspace is git-linked, its content is not
written; instead a stub manifest is written with just enough to find the repo. Today each
kind invents its own stub shape:

| Kind | Stub path | Keys |
|---|---|---|
| project | `projects/<f>/project.json` | `uid, entityId, projectId, name, createdAt?, gitRemoteConfig` |
| sql-collection | `sql-scripts/<f>/_collection.json` | `id, name, createdAt?, gitRemoteConfig` |
| dq-rule-set | `data-quality/<f>/_ruleset.json` | `{ruleSet: {id, name, createdAt?, gitRemoteConfig}, checks: []}` |
| schema-preset | `schemas/<f>/_schema.json` | `entityId, presetId, mapping.presetLabel?, gitRemoteConfig` — no `id`, no `createdAt` |

Note the DQ stub wraps itself in `{ruleSet, checks: []}` and the preset stub carries neither
`id` nor `createdAt`. **After harmonization all four collapse to one shape** —
`<folder>/entity.json`, standard identity + provenance blocks, plus a `git: {url, branch}`
key — so this table stops existing (see §6.3i):

```jsonc
// schemas/omop-5-4/entity.json — a git-linked schema preset
{
  "id": "sp1", "entityId": "omop-5-4", "type": "schema-preset",
  "name": { "en": "OMOP CDM 5.4" }, "description": null,
  "git": { "url": "https://framagit.org/…/omop-cdm-5.4", "branch": "main" },
  "createdBy": "…", "lineageId": "…", "createdAt": "…", "version": "1.0.0",
  "appVersion": "2.x.y"
}
```

A reader can then tell linked from unlinked by one field (`git` present) instead of by
filename, folder shape and wrapper object.

*The root `git-links.json`.* A workspace-level index: `{appVersion, links: [{type, id, folder,
url, branch}]}`. The portal's `sync-git-links.sh:54` reads **only this file** to `git submodule
add` each linked repo, and `dir_for_type` (`:40-51`) maps type → folder.

**The choice.** Where does the remote URL live?

- **(a) Status quo, harmonized.** URL in both the stub's `entity.json` and `git-links.json`.
  Portal unchanged. Cost: the URL is written twice and can disagree.
- **(b) URL only in `entity.json`** (under a `git: {url, branch}` key), `git-links.json`
  dropped. Single source of truth. Cost: the portal must walk every entity folder to discover
  submodules instead of reading one file — a real rewrite of `sync-git-links.sh`.
- **(c) URL only in `entity.json`, `git-links.json` kept as a generated index.** Same single
  source of truth, portal keeps its cheap one-file read; the index is derived, never authored.

**DECIDED 2026-08-26: (c).** The URL is authored in the linked entity's `entity.json` under a
`git: {url, branch}` key; `git-links.json` stays at the workspace root as a **generated index**,
never hand-authored. The portal keeps its single-file read (`sync-git-links.sh:54`) and the
duplication stops being a source of truth conflict — if the two disagree, `entity.json` wins
and the index is rebuilt.

**6.2b Should a *standalone* entity repo carry its own `git` key?** Today it does not — the
remote is instance state (`gitRemoteConfig` is an `INSTANCE_FIELD`, stripped on export), and
a repo knowing its own URL breaks when forked or mirrored. Recommend **no**, and stating that
explicitly in the format doc so nobody re-adds it. The `git` key from 6.2 is therefore a
**workspace-nested-stub-only** field, not part of the standalone manifest.

**6.3 `_tree.json` — DECIDED 2026-08-26 (placement, name; schema recommended).**

*(0) Placement — DECIDED 2026-08-26 (see §3.2).* The root `_tree.json` in ETL/SQL is a symptom
of those entities having no container folder. Both get **`scripts/`**, and the sidecar follows
it down. Rule: **`_tree.json` always lives inside the folder it describes, never at the entity
root.**

*(i) The name — DECIDED 2026-08-26: no `_` at the repo root, `_` kept inside folders.*

This is sharper than "keep it" or "drop it", and it turns out the format already satisfies it
once the manifests are renamed. Every `_`-prefixed file in the golden fixtures today:

| At a repo root (→ becomes `entity.json`) | Inside a folder (→ keeps `_`) |
|---|---|
| `_collection.json`, `_pipeline.json`, `_plugin.json` | `scripts/_tree.json`, `datasets/_tree.json`, `wiki/_tree.json`, `attachments/_meta.json`, `wiki/_attachments/_meta.json` |

Every root-level `_` file is a **manifest** — and all three are being renamed to `entity.json`
regardless. Every folder-level `_` file is a **genuine sidecar** describing its siblings. So
the rule costs nothing extra and states plainly what `_` means:

> `_` marks a machine sidecar describing the files beside it. It never appears at the root of
> an entity — the root holds `entity.json`, docs, and content.

`_data.json` / `_columns.json` (portal-generated, inside `datasets/<folder>/`) and
`_index.json` (inside a project folder) also satisfy it unchanged.

**The git-link stubs become `entity.json` too — DECIDED 2026-08-26.**
`schemas/<f>/_schema.json`, `data-quality/<f>/_ruleset.json`, `catalogs/<f>/_catalog.json`
(`entity-io.ts:3081, 3172, 3233`) are `_`-prefixed and sit inside a folder, but they are
**manifests**, not sidecars: each is the manifest of a nested entity that happens to be stored
by reference rather than by value. So they follow the same rule as everything else. The `_`
rule is scoped by *role*, not by depth:

> `_` marks a sidecar. An entity's manifest is `entity.json` **wherever it sits** — repo root
> or nested folder, stored by value or by reference.

Three things fall out of this, which is why it is worth stating rather than treating as an
exception:

1. **The flat-vs-folder asymmetry in §2.1(c) disappears.** Linked and unlinked are both
   `<folder>/entity.json`; the only difference is that a linked one carries a `git` key and
   less content. The reader stops branching on shape.
2. **The `rule-set.json` vs `_ruleset.json` spelling split dies with it** — one concept, one
   filename, at last.
3. **The DQ stub's `{ruleSet: {...}, checks: []}` wrapper goes away.** It exists only because
   the unlinked workspace form is a bundle; as an `entity.json` the stub is a flat manifest
   like every other, and the empty `checks: []` stops being written at all.

*(ii) The schema — this one actually matters.* `_tree.json` is **four incompatible shapes**
wearing one filename:

| Location | Keys |
|---|---|
| `scripts/_tree.json` | `path, type, language, createdAt` |
| `sql-scripts/…/_tree.json` | `path, type, order, dataSourceId, createdAt` |
| `etl/…/_tree.json` | `path, type, language, order, dataSourceId, disabled, createdAt` |
| `datasets/_tree.json` | **`id, name, type, parentId, path, columns?, parseOptions?`** — keyed by id, not path |
| `wiki/_tree.json` | raw `WikiPage` dump, no `toPathTree` at all — leaks `createdById`, `updatedAt` |

The first three are one schema with optional fields and could genuinely unify. `datasets/`
is deliberately different — widgets and filters reference dataset column ids, so it must keep
`id`/`parentId` (justified at `entity-tree.ts:16-19`); **leave it alone.** `wiki/` bypassing
the shared helper is not deliberate — it is the instance-field leak from §2.2 in another guise.

Recommended: unify the three script-ish trees onto one schema with optional fields, route
`wiki/` through `toPathTree` (fixing the leak), exempt `datasets/` with a comment saying why.

**Question for you:** keep `_` as the sidecar marker (my lean), or drop it everywhere?

**6.4 `kind` values — DECIDED 2026-08-26: one field name, one vocabulary.**
The manifest field and the catalog entry field must be **the same name** carrying the **same
values**. Since `entry.schema.json` already ships `type` publicly (and mirrors
`GitLinkedEntity['type']`), the cheapest single vocabulary is to name the manifest field
**`type`** rather than `kind`, and reuse the existing values:

`project`, `workspace`, `mapping-project`, `etl-pipeline`, `sql-collection`, `user-plugin`,
`schema-preset`, `dq-rule-set`, `data-catalog`, `database`

Two gaps to close while doing it: the catalog's enum has no `workspace` or `user-plugin`, and
`scan.mjs` never detects `database` even though `install.ts` handles it. Once the manifest
declares its own `type`, `scan.mjs:350-355`'s `mappings.json` heuristic and
`seed-loader.ts:577-578`'s fallback both get deleted rather than maintained.

## 7. Sequencing note

This plan overlaps two live efforts, and should be scheduled with them rather than against:

- **[schema-preset-identity-plan.md](schema-preset-identity-plan.md) step 5** retires
  `presetId` from the export format. That is the same edit as giving the preset a real
  `id`/`lineageId` here — do them together.
- **[mcp-authoring-plan.md](mcp-authoring-plan.md)** owns `linkr-format` and the MCP, and
  the planning README's *Split entity-io.ts* debt item touches the same 3.6k-line file.
  Step 1 here (centralising the names) is a natural first cut of that split.
