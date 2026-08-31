# Portable cross-entity links — plan

**Status**: ✅ done (2026-08-31) · **Effort**: S/M · **Date**: 2026-08-28

> **Landed.** All seven links below now travel as portable `*Ref` pointers,
> stamped when the target is picked and resolved on import. Step 5 (`source.` /
> `target.` role aliases) remains a separate, untouched effort — see §3.
>
> The shipped shape differs from §2 as first written: rather than overwrite the
> id field with a `lineageId`, each link gained a **sibling pointer**
> (`{lineageId?, entityId?, label?}`) while the id field is blanked. That is the
> pattern `DataCatalog` had already proven, and it buys three things a bare
> lineage cannot: a readable-slug fallback for rows written before lineage
> existed, a `label` so the UI can name a database this instance does not hold,
> and — decisively — an id field whose meaning never changes, so every consumer
> comparing `p.id === pipeline.mappingProjectId` keeps working untouched.

An exported entity that points at *another* entity writes **this instance's primary
key**, and nothing translates it on import. So a pipeline exported here and imported
there lands pointing at rows that do not exist: the link is silently dead, and the
pipeline reads as "no source database" on the receiving instance.

This is not a seed problem or a demo-workspace problem. It hits **every shared
workspace containing an ETL pipeline or an SQL collection** — the private
`cdc-rennes` workspace as much as the public demo one. Fixing it here fixes the
default data for free, since the seed is only a projection of a published repo
([default-data-repos-plan.md](default-data-repos-plan.md) §0).

---

## 1. What is actually broken

Audited 2026-08-28 against the export and the import.

| Field | Owner | In the export? | Verdict |
|---|---|---|---|
| `sourceDataSourceId` | `EtlPipeline` | no longer — blanked, `sourceDataSourceRef` travels | ✅ **fixed 2026-08-31** |
| `targetDataSourceId` | `EtlPipeline` | no longer — dropped, `targetDataSourceRef` travels | ✅ **fixed 2026-08-31** |
| `mappingProjectId` | `EtlPipeline` | no longer — dropped, `mappingProjectRef` travels | ✅ **fixed 2026-08-31** |
| `defaultDataSourceId` | `SqlScriptCollection` | no longer — dropped, `defaultDataSourceRef` travels | ✅ **fixed 2026-08-31** |
| `dataSourceId` | `DqRuleSet` | no longer — blanked, `dataSourceRef` travels | ✅ **fixed 2026-08-31** |
| `vocabularyDataSourceId` | `MappingProject` | no longer — dropped, `vocabularyDataSourceRef` travels | ✅ **fixed 2026-08-31** |
| `dataSourceId` | `DataCatalog` | no longer — blanked, `dataSourceRef` travels | ✅ fixed 2026-08-30 |
| `linkedDataSourceIds` | `Project` | **no** — in `INSTANCE_FIELDS`; `linkedDataSourceRefs` travels beside it | ✅ **fixed 2026-08-31** |

Two rows the 2026-08-28 audit missed, both found while implementing:
`DqRuleSet.dataSourceId` (same bug, same shape as the catalog's) and
`MappingProject.vocabularyDataSourceId` (which the export simply *dropped*, so a
project's ATHENA vocabulary never survived a round trip at all).

`Project.linkedDataSourceIds` was reclassified rather than fixed in place. The
2026-08-28 verdict — "fine: dropped on purpose" — was right for a world without
portable pointers: stripping a list of meaningless UUIDs beat shipping them. With
pointers available the user chose the portable form, so the ids stay stripped and
`linkedDataSourceRefs` travels beside them; databases that the receiving instance
does not hold are simply dropped from the list.

> `DataCatalog.dataSourceId` was a fifth case this table originally missed. It was
> the worst of them: the git-clone branch (`entity-io.ts`, `applyEntityRepo`) wrote
> the repo's foreign id *over* a correct local link, so a clone could break a
> catalog that had been working. It now follows the `dataSourceRef` pattern
> end-to-end — stamped when the database is picked (dialog + overview card),
> blanked on export both front and back, resolved by `resolvePointer` in the
> workspace import, the clone branch and the seed post-pass. The remaining four
> rows are still open and are what this plan is about.

Evidence, on the real published tree
(`linkr-content-private/etl-pipelines/mimic-iv-to-omop`):

```json
"sourceDataSourceId": "092e7eef-f618-42e0-8d6b-5cded97ca6ea",
"targetDataSourceId": "3618a44d-feb9-455c-9539-4d69ae521af5",
"mappingProjectId":   "e8073269-b652-44d4-b07a-04ec6745866d"
```

None of those three match any `lineageId` or `entityId` of the nine entities in the
workspace that ships them — they are the writing instance's PKs. And
`grep sourceDataSourceId` over `workspace-import.ts`, `entity-io.ts` and
`import-identity.ts` returns **nothing**: no remapping exists anywhere.

**Putting a `lineageId` in the repo by hand does not fix it.** The consumers compare
against the primary key — `mappingProjects.find((p) => p.id === pipeline.mappingProjectId)`
([use-role-schemas.ts:72](../../apps/web/src/features/warehouse/etl/use-role-schemas.ts#L72))
— so a lineage in that field is just a different id that matches nothing. Both ends
have to move together.

## 2. The fix

**Address by lineage in the export; resolve back to a local PK on import.** The
machinery already exists and is already used for the entities themselves —
`resolveByLineage` / `findLineageMatch` in
[import-identity.ts](../../apps/web/src/lib/import-identity.ts) — it is simply not
applied to these four fields.

- **Export**: replace each of the four PKs with the `lineageId` of the entity it
  points at (resolved from the local row at export time). A target with no lineage
  writes `null` rather than a PK that cannot mean anything elsewhere.
- **Import**: after the databases and mapping projects are written — they must exist
  before anything can point at them — walk the pipelines and SQL collections once
  more and turn each lineage back into the PK that actually landed. Unresolvable
  (the database was not part of this import) leaves the field empty, which is what
  the UI already renders as "not selected".

The ordering constraint is why this is a second pass rather than an inline
translation: `importWorkspaceTree` writes pipelines in the same sweep as everything
else, and a pipeline can point at a database written after it.

**Keep the field names and types.** `sourceDataSourceId: string` stays a local PK *in
the model* — this is an export-layer translation, exactly like `INSTANCE_FIELDS`
stripping. Nothing in the ETL runtime changes, so there is no migration and no
behaviour change for an instance that never imports anything.

## 3. Scope note — the `source.` / `target.` alias idea

A separate, larger idea has been floating for the same symptom: address a pipeline's
databases by **role** (`source.`, `target.`) instead of by id, so the SQL itself stops
naming `ds_<alias>`. That is a bigger change (it touches generated SQL and needs
cross-schema support in server mode) and it solves a *different* half of the problem —
how scripts *refer* to a database, not how the pipeline *record* survives a round trip.

Do the lineage translation first: it is small, it is testable in isolation, and it
unblocks every shared workspace today. The alias rework can land later without
undoing it.

## 4. Steps

| St | Item | Effort |
|----|------|--------|
| ✅ | 1. Export: blank each id and ship a `*Ref` pointer beside it (front `entity-io.ts` + the Python twin, so both stamp the same bytes) | S |
| ✅ | 2. Import: resolve the pointers — inline where the target already landed, in a deferred pass for a pipeline's mapping project and a project's databases | S |
| ✅ | 3. Unit tests on the pure resolution + the export/import round trip; golden fixtures now carry real pointers so both sides prove the blanking | S |
| 🔜 | 4. Re-export the published repos so they carry pointers (`linkr-public-content`, `linkr-content-private`) — until then those trees still hold dead UUIDs, which now import as "unlinked" instead of dangling | S |
| 💤 | 5. `source.`/`target.` role aliases in generated SQL — separate effort, see §3 | L |

**Stamped on selection, not derived at export.** The pointer is written when the
user picks the target, because the *server* export builds its manifest from the
stored row alone and cannot look the database up. This is also why step 4 is
still open: an entity whose database was picked before this change has no pointer
until it is re-picked (or re-exported from an instance that has one).

**A pull deliberately does not resolve them.** `EXTRA_INSTANCE_PIPELINE_FIELDS`
refuses the new `*Ref` fields alongside the ids it already refused: a pull brings
code, and taking the pointers *would* resolve — to the collaborator's choice of
database, silently replacing the local user's. Import and clone do resolve them,
because there the entity is arriving and has no local choice to preserve.

## 5. Related

- [default-data-repos-plan.md](default-data-repos-plan.md) — the seed inherits this
  fix automatically; it must **not** work around it with a hand-maintained link table.
- [versioning-plan.md](versioning-plan.md) — same family of "what does an id mean on
  another instance" questions.
