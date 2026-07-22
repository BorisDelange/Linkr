# Server-side export / versioning (fullstack mode)

> Design document. **Nothing is implemented yet** beyond the pilot groundwork — validate
> before writing more code.
>
> **Motivation.** In fullstack mode the browser today builds the entire export/versioning ZIP
> (DB→files), then **uploads** it to the server, which merely commits/pushes it. For a mapping
> project of ~180k concepts this heavily loads the client (reading data, DuckDB, JSZip,
> uploading several MB) — the opposite of fullstack's goal, which is to **offload the
> browser**. We want to move ZIP construction to the server **whenever a server exists**.
>
> **Cardinal constraint.** The **front-only / WASM** deployment has **no server**. The TS
> export logic therefore cannot be *removed* — at most *bypassed* when `isServerMode()`. See §3:
> this is what makes a naïve "everything server-side" dangerous (two DB→files implementations
> to keep identical, or git sees false diffs).

## Validated decisions (see §5)

- **Option A** — port **all** scopes to the server; TS builders stay for front-only (bypassed
  in server mode, never deleted).
- **Golden ZIP tests** as the TS↔Python consistency guard, compared **per extracted file**
  (not raw ZIP-container bytes — JSZip and Python `zipfile` differ on headers/CRC/DEFLATE, and
  git versions the extracted files anyway). See §4bis.
- **Pull = variant (b)**: the server produces LOCAL/REMOTE/BASE; the front keeps the business
  diff + resolution UI (logic shared with front-only, never ported to Python). See §9bis.

## Status

- **[DONE]** pilot scope **mapping project** (steps 1–7): golden contract (TS + Python parity),
  pure Python builder, DB-backed assembler, server build+commit/push (optional-file endpoints),
  server export-zip download endpoint, project-scoped `entries.json` (the original "point 2"),
  client switch (server builds the ZIP in server mode), pull left as-is (§9bis — no rebuild to
  offload). Front-only unchanged throughout.
- **[TODO]** step 8: extend to the other 8 scopes (projects, workspaces, sql/etl/catalogs/dq/
  presets/plugins), each following the same golden → builder → assembler → endpoints → switch
  pattern.
- **[LATER]** step 9: server-side import (separate document).

---

## 0 — Scope

Covers **all versionable scopes** (current dispatch: [git-sync-store.ts:37-73](../../apps/web/src/stores/git-sync-store.ts)):

| Scope | Current client builder | Heavy data? |
|---|---|---|
| `projects` | `buildProjectZip` ([entity-io.ts:384](../../apps/web/src/lib/entity-io.ts)) | Yes — dataset blobs (raw files) |
| `workspaces` | `buildWorkspaceZip` ([entity-io.ts:1567](../../apps/web/src/lib/entity-io.ts)) | Yes — reuses buildProjectZip + mapping folders |
| `mapping-projects` | `buildMappingProjectZip`/`Folder` ([export.ts:594,734](../../apps/web/src/lib/concept-mapping/export.ts)) | Yes — source-concepts.csv, scores.parquet, source-concept-ids, DuckDB (Export tab only) |
| `sql-script-collections` | `buildSqlCollectionZip` ([entity-io.ts:1264](../../apps/web/src/lib/entity-io.ts)) | No — metadata + scripts |
| `etl-pipelines` | `buildEtlPipelineZip` ([entity-io.ts:1278](../../apps/web/src/lib/entity-io.ts)) | No |
| `data-catalogs` | `buildDataCatalogZip` ([entity-io.ts:1303](../../apps/web/src/lib/entity-io.ts)) | No |
| `dq-rule-sets` | `buildDqRuleSetZip` ([entity-io.ts:1330](../../apps/web/src/lib/entity-io.ts)) | No |
| `schema-presets` | `buildSchemaPresetZip` ([entity-io.ts:1354](../../apps/web/src/lib/entity-io.ts)) | No |
| `user-plugins` | `buildUserPluginZip` ([entity-io.ts:1388](../../apps/web/src/lib/entity-io.ts)) | No |

**Two outputs share these builders**: the **Export** button (ZIP download) and **git sync**
(upload then server commit/push). They must produce an **identical** ZIP for the same state —
otherwise switching export method fabricates a false git diff.

**The client build is NOT triggered only at push.** `buildZipUncached`
([git-sync-store.ts:37-73](../../apps/web/src/stores/git-sync-store.ts)) also runs on
`refreshStatus` (opening the Versioning panel, switching branch, toggling "include data")
**and on every per-file diff**. Only `_zipCache` mitigates. The client cost is therefore
**frequent**, not occasional — which sharpens the migration's urgency.

**Reading trap — the `isServerMode()` guards in `export.ts` (657, 693) do NOT delegate to the
server: they are *download triggers*.** In server mode the browser **fetches**
`source-concepts.csv` and `similarity-scores.parquet` (~100 MB) from the blob store to re-zip
them, then re-uploads. That is backwards. Likewise `buildWorkspaceZip` forces
`includeDataFiles: true` per project ([entity-io.ts:1632](../../apps/web/src/lib/entity-io.ts))
then re-unzips each sub-ZIP in memory — a worst case, and another argument for Option A.

---

## 1 — Current model (what we build on)

- **Front = all DB→files logic.** Each builder reads the `Storage` façade (`getStorage()`,
  IndexedDB front-only or the API adapter in server mode), assembles a `JSZip`, computes
  `.gitattributes`/LFS ([entity-io.ts:1252](../../apps/web/src/lib/entity-io.ts)), inlines the
  organization ([entity-io.ts:1234](../../apps/web/src/lib/entity-io.ts)).
- **Server = opaque bytes.** [git_service.py](../../apps/api/app/services/git_service.py)
  unpacks the received ZIP into a working tree (`_unpack_zip_into`), `fetch`es the remote to
  compare, then `status`/`diff`/`commit_push`. It **does not know what a "mapping" is**.
- **Only server-side ZIP construction today**: `clone_to_zip`
  ([git_service.py:990-1051](../../apps/api/app/services/git_service.py)) — clones a remote and
  zips it. The only server packing model to imitate (`io.BytesIO` + `zipfile`).
- **Server git repos**: under `data_dir/<kind>/<id>/versioning` (projects under
  `project_fs.cache_dir(uid)/versioning`).
- **Server detection**: `isServerMode()` = `!!VITE_API_URL`
  ([api-client.ts:8](../../apps/web/src/lib/api-client.ts)).
- **Import = symmetric and 100% client**: the server never parses an import ZIP
  (`parseProjectZip`/`parseWorkspaceZip`/`importProjectContent`). Out of immediate scope but
  worth keeping in mind (§7).

---

## 2 — The real challenge: don't duplicate the DB→files logic

The trap in a naïve "everything server-side": rewrite `buildProjectZip` & co in Python **on
top of** keeping them in TS for front-only. We would then have **two implementations** of the
DB→files projection. Any divergence (JSON key order, sorting, CSV formatting, LFS handling)
yields different ZIPs → **false git diffs** between a front-only client and a server client
working the same repo. That is exactly the consistency problem that motivated this work, moved
up to the level of the two engines.

**Design consequence:** we need a **format contract tested on both sides** (golden files, §4bis).

---

## 3 — What must stay client, no matter what

- **All front-only export** (`isServerMode() === false`). With no server, the TS builders are
  the only option. We can only *bypass* them in server mode, never delete them.
- **DuckDB extraction** of a mapping project's source concepts on a **DB** data source
  ([export.ts:669-686](../../apps/web/src/lib/concept-mapping/export.ts)): DuckDB-WASM lives in
  the browser. Note: this path is **not** on the git route today (`buildMappingProjectZip` never
  passes `queryDataSource`) — only the Export button uses it. So moving the git ZIP server-side
  does **not** require porting DuckDB.
- **Import** (parse ZIP→DB) stays client (§7).

---

## 4 — Architecture options (recorded; A chosen)

- **Option A (chosen)** — port every scope to Python; front-only keeps its TS builders.
  Uniform; largest surface, mitigated by golden tests and incremental delivery.
- **Option B** — server-side only for the heavy scopes (projects/workspaces/mapping-projects),
  the 6 light scopes stay client. Less Python, two behaviors by scope.
- **Option C** — extract a declarative `{path → content}` description shared by both, JSZip and
  Python packers being trivial wrappers. Reduces divergence to packing but needs a front
  refactor and still duplicates serialization.
- **Option D** — don't migrate; just reduce client cost (streaming, avoid re-downloading blobs
  already on the server, cache). Least ambitious; doesn't meet the fullstack goal.

### 4bis — Golden ZIP tests (the format contract)

Shared fixtures, compared **per extracted file** (not raw `.zip` bytes — the container is not
byte-reproducible across JSZip and Python `zipfile`, and git versions the extracted files
anyway):

```
apps/web/src/lib/__fixtures__/export-golden/mapping-project/
  input.json      ← frozen input (project, mappings, badges, ranges, entries…)
  expected/       ← expected extracted tree, readable in a git diff
    project.json  mappings.json  source-concepts.csv
    source-concept-ids/{ranges.json,entries.json}  .gitignore  [.gitattributes]
```

- **TS test**: load `input.json`, run the builder, **unzip**, compare each file to `expected/`.
- **Python test**: load the **same** `input.json`, run the server builder, compare to `expected/`.

Byte-level contract the golden must pin (from the current TS builder — see §6 detail):

- **All JSON** is `JSON.stringify(x, null, 2)`: 2-space indent, `\n` separators, **insertion-order
  keys (never sorted)**, no trailing newline, `undefined`-valued keys omitted. Python must match
  (`json.dumps(..., indent=2, ensure_ascii=False)` + item separator `","` not `", "`, and
  preserve key order — do NOT `sort_keys`).
- **`mappings.json`**: drop `id`/`projectId`/`createdAt`/`updatedAt` per mapping; sort by
  `sourceConceptCode` then `mappingKey` (`src…→…tgt`, [merge.ts:25-29](../../apps/web/src/lib/concept-mapping/merge.ts)).
- **`entries.json`**: `{columns:['badgeLabel','vocabularyId','conceptCode','sourceConceptId'], entries:[...]}` —
  **exactly 4 columns, `createdAt` dropped**; rows sorted by (badgeLabel, vocabularyId, conceptCode).
- **`ranges.json`**: `toPortableRanges` picks `{badgeLabel,rangeStart,rangeEnd,nextId,totalConcepts}`
  (that key order; drops workspaceId/timestamps/id), sorted by badgeLabel.
- **`source-concepts.csv`**: column order = terminology, concept_code, concept_id, concept_name,
  domain, concept_class, record_count, patient_count, info_json (only mapped ones), then
  extraColumns; `csvEscape` quotes on `,`/`"`/`\n` and doubles `"`; **`\n` line terminator, no
  trailing newline**. In the git variant this file is usually the **raw source buffer verbatim**
  (STORE, no re-serialization) — a golden fixture should use the raw-buffer or parsed-rows path,
  never the server-fetch path (non-reproducible).
- **`project.json`**: strip `INSTANCE_FIELDS` (ownerId, createdById, origin, workspaceId,
  gitRemoteConfig, gitUrl, catalogVisibility, organization, organizationId, createdAt, updatedAt);
  drop conceptSetIds/importBatches/vocabularyDataSourceId; **reset `dataSourceId:''` in place**
  (keeps its original key position); re-add `fileSourceData` with `rawFileBuffer` omitted and
  `rows:[]`; then `attachEntityOrganization` **appends `organization` at the end** if one resolves.
- **`.gitignore`** = literal `"similarity-scores.parquet\n"`.
- **`.gitattributes`** = only when LFS overrides exist (none in the default git variant → file
  absent); line template `"<pattern> filter=lfs diff=lfs merge=lfs -text"`, sorted, joined `\n`,
  trailing `\n`.

**`localeCompare` caveat:** every sort tiebreak uses default-locale `localeCompare`. Pin the
locale (or replicate its ordering) in the Python builder, or the sorts diverge under different
ICU. Include this in the golden test setup.

**No `Date.now()`/`Math.random()`/`crypto.randomUUID()`** on the git-ZIP export path, so the
output is deterministic given a fixed input + org record.

---

## 5 — Decision (validated)

**Option A** — all scopes server-side — **with golden ZIP tests**, using `clone_to_zip` as the
server packing model. TS builders **remain** for front-only (bypassed under `isServerMode()`,
never deleted).

- **Deliver incrementally**, one scope at a time, **starting with the mapping-project pilot**
  (heaviest and most complete: it validates golden tests + scoped entries.json + pull coupling).
- Golden tests (same input → same bytes, checked on **both** TS and Python in CI) neutralize the
  format-divergence risk — the hard part (§2).

---

## 6 — Mapping project + `entries.json` (the deferred "point 2")

**Current state (to fix):** in server mode the browser **re-downloads** `source-concepts.csv`
and `similarity-scores.parquet` (~100 MB) from the blob store to re-zip them (the
`isServerMode()` guards at [export.ts:657,693](../../apps/web/src/lib/concept-mapping/export.ts)
are download triggers, cf. §0). This is exactly what the migration removes.

**Target, once mapping-project export is server-side:**

- `source-concepts.csv`: already **on the server** (blob store) → the server reads it directly,
  the browser no longer downloads it.
- `scores.parquet`: already **on the server** (blob store), opt-in, never versioned — no ~100 MB
  client download.
- `source-concept-ids/entries.json` **scoped to the project**: becomes a **`SELECT`**. The
  registry is in the DB (`source_concept_id_entries`,
  [source_concept_id_service.py](../../apps/api/app/services/source_concept_id_service.py)); the
  project's concepts are in its source dictionary (on disk) + its mappings (in the DB). Scope =
  `entries WHERE (vocab, code) ∈ concepts(project)` — pure server SQL/join, **zero browser
  DuckDB**. This is why we did **not** code this scoping in TS: it will be trivial here.
- Invariant to preserve: a `sourceConceptId` is **global per `(vocab, code)`** in a workspace
  (verified in DB). The client import already applies `reconcileImportedEntries` (keeps the local
  id). If import ever moves server-side (§7), reproduce this rule.

---

## 7 — Import (out of immediate scope, to be planned later)

Import (ZIP→DB) is today **100% client** and symmetric to export. Moving it server-side is a
**twin project** (Python parsers for `_tree.json` + content), with the same duplication/consistency
concerns. Tackle it **after** export, in a separate document, once the format contract (§4bis) is
stable.

---

## 8 — Steps (Option A, mapping-project pilot first)

1. **Format contract + golden tests** (§4bis): freeze the expected `{path → bytes}` extracted
   tree for the mapping project; generate `expected/` from the current front; write the TS test
   (front reproduces the golden). This is the anti-divergence net (§2).
2. **Python builder** for the mapping project + its Python test (reproduces the same golden).
3. **Server `build+commit/push` endpoint**: the server builds the ZIP (model `clone_to_zip`) and
   continues into the existing git flow, no client upload.
4. **Server `build→download` endpoint** for the Export button (server mode): returns the
   server-built ZIP (front only triggers + downloads).
5. **Client switch**: under `isServerMode()`, `buildZipUncached`
   ([git-sync-store.ts:37](../../apps/web/src/stores/git-sync-store.ts)) and the Export button
   call the server instead of the TS builders. Front-only: unchanged.
6. **Scoped entries.json** (§6) integrated into the server mapping-project builder.
7. **Pull** (§9bis): left as-is — the pull reads LOCAL as DB objects, not an export rebuild, so
   there is nothing heavy to offload.
8. **Extend** to the other 8 scopes (projects, workspaces reuse the mapping folder; then
   sql/etl/catalogs/dq/presets/plugins).
9. (Later) **Server-side import** (§7), separate document.

### [FAIT] Standalone builders for the remaining workspace children

sql-script-collection, etl-pipeline, dq-rule-set, data-catalog, schema-preset and
user-plugin now have a server-side standalone export builder
(`workspace_export_assemble.build_<type>_tree` / `assemble_<type>_zip`), so their git
commit-push no longer depends on the client-built ZIP — same as project/mapping/workspace.
Each inlines the inherited organization as the last key of its metadata JSON (via
`resolve_entity_org_snapshot`), except schema-preset which inlines none (matching the
front `buildSchemaPresetZip`). The git routes (factory `_register_entity_git_routes` +
the manual sql-collection routes) take the file upload as optional and fall back to the
server builder when absent. Byte parity is pinned by golden fixtures + twin tests on both
sides (`<kind>-export-golden.test.ts` + `test_entity_export_assemble.py`).

> **Known parity edge case — round floats.** JS `JSON.stringify` writes an integer-valued
> float as `0`, while Python (a `Float` column) serializes it as `0.0`. This only bites a
> numeric field that can legitimately hold a round value (e.g. a DQ check `threshold` of 0).
> Not resolved globally — the golden fixtures avoid round floats. If it surfaces in real
> data, normalize at the serializer (round floats → int when whole) or accept the diff.

---

## 9 — Risks / open points

- **TS↔Python format divergence** → golden tests mandatory (§2, §4bis).
- **LFS/`.gitattributes`**: opt-in LFS resolution ([git-lfs.ts](../../apps/web/src/lib/git-lfs.ts))
  must produce the same `.gitattributes` on both sides (include in golden tests).
- **Deterministic ordering**: TS sorts (mappings, entries, ranges) use `localeCompare` — replicate
  byte-for-byte in Python, locale pinned (§4bis).
- **Inline organization** (`attachEntityOrganization`): same serialization on both sides; the org
  record itself may carry instance fields — fix it in the fixture.
- **`buildMappingProjectZip` (git) ≠ Export tab** today (scores off, no DuckDB): the server
  builder must reproduce **exactly the git variant**, not the Export-tab variant, for diff
  consistency.
- **ZIP container not byte-reproducible** across JSZip and Python `zipfile` → golden tests compare
  **extracted files**, which is what git commits anyway (§4bis).

---

## 9bis — Pull coupling (variant b, validated)

The pull ([git-sync-plan.md](git-sync-plan.md)) does a **3-way merge at the entity level**, not a
line diff:
- **LOCAL** = projection of the current state (today the **front** export).
- **REMOTE** / **BASE** = bytes the server provides (`git show`).

**Decision: variant (b) — but no code needed.** On implementing step 5 we found the pull does
**not** rebuild an export ZIP for LOCAL: `prepareMappingProjectPull`
([pull.ts:55-61](../../apps/web/src/lib/concept-mapping/pull.ts)) reads LOCAL as parsed objects
straight from `storage.conceptMappings.getByProject` + `storage.mappingProjects.getById` — which in
server mode already go through the API adapter (DB reads), not a local export build. So the
"offload the heavy rebuild" win of variant (b) **does not apply to the pull** — there is no rebuild
to move. LOCAL is already effectively server-sourced. **Left as-is** (validated): adding a
bundled-LOCAL pull-preview would only save a couple of round-trips while duplicating the LOCAL
projection server-side — not worth it. The front keeps the **3-way merge** (`merge.ts`) and the
**resolution UI** (`PullResolveDialog`/`PullMappingsTable`), shared with front-only; `merge.ts` is
**never** ported to Python.

**What the pull already does NOT do (and we must not regress):**
- **Large blocks** (`source-concepts.csv`, `entries.json`, `scores.parquet`) are **never diffed by
  content**: change detected by **git oid comparison**
  ([pull.ts:40-48](../../apps/web/src/lib/concept-mapping/pull.ts)), whole-block choice (take
  remote / keep local), file downloaded (`gitPullFile`) **only if accepted**, then written to the
  DB without a diff.
- The **line-by-line diff** in the Versioning tab is already bounded server-side
  ([git_service.py:781](../../apps/api/app/services/git_service.py): `_diff_payload` truncates,
  flags binary/LFS, `hunks` mode) and **rendered** front-side by **Monaco** (`DiffEditor`), not a
  hand-rolled algorithm. After migration the server will have `new` **without a client upload** →
  an even lighter diff.
