# Portable cross-entity links — plan

**Status**: 🔜 diagnosed, not started · **Effort**: S/M · **Date**: 2026-08-28

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
| `sourceDataSourceId` | `EtlPipeline` | yes, local PK | ❌ dead cross-instance |
| `targetDataSourceId` | `EtlPipeline` | yes, local PK | ❌ dead cross-instance |
| `mappingProjectId` | `EtlPipeline` | yes, local PK | ❌ dead cross-instance |
| `defaultDataSourceId` | `SqlScriptCollection` | yes, local PK | ❌ dead cross-instance |
| `linkedDataSourceIds` | `Project` | **no** — in `INSTANCE_FIELDS` | ✅ fine: dropped on purpose, "databases stay unlinked" |

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
| 🔜 | 1. Export: translate the 4 fields to `lineageId` (front `entity-io.ts` + the Python twin, so both stamp the same bytes) | S |
| 🔜 | 2. Import: second pass over pipelines + SQL collections resolving lineage → local PK, after databases/mapping projects are written | S |
| 🔜 | 3. Unit tests on the pure resolution (a lineage that matches, one that does not, a null) + a golden round-trip: export → import into a fresh instance → the pipeline still names its databases | S |
| 🔜 | 4. Re-export the published ETL repos so they carry lineages (`linkr-public-content`, `linkr-content-private`) | S |
| 💤 | 5. `source.`/`target.` role aliases in generated SQL — separate effort, see §3 | L |

## 5. Related

- [default-data-repos-plan.md](default-data-repos-plan.md) — the seed inherits this
  fix automatically; it must **not** work around it with a hand-maintained link table.
- [versioning-plan.md](versioning-plan.md) — same family of "what does an id mean on
  another instance" questions.
