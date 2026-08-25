# Schema presets: harmonise identity with every other entity

**Status**: 🤔 planned, not started. Investigation done 2026-08-25 (full map below).

Schema presets are the only entity whose identity does not follow the house pattern.
Every other exportable entity carries three separate things:

| Field | Role | Example |
|---|---|---|
| `id` | local primary key, uuid, regenerated on import for uniqueness | `9f3c…` |
| `entityId` | human-readable slug, set once at creation, never changes | `omop-cdm-5-4` |
| `lineageId` | cross-instance identity, preserved verbatim | `lin-…` |

A preset has **only `presetId`**, which plays all three roles at once. That is the whole
problem, and everything below follows from it.

## Why it matters (not cosmetic)

**1. A confirmed data-corruption path.** `applyClonedEntity`
([entity-io.ts:2695](../../apps/web/src/lib/entity-io.ts#L2695)) sets `presetId: targetId`
but rebuilds `mapping` as `{ ...preset.mapping, ddl }` — so `mapping.presetId` keeps the
*repo's* id while the entity takes a fresh one. The two drift apart. Then a ZIP import
reads `mapping.presetId` as the entity id
([SchemaPresetsPage.tsx:1807](../../apps/web/src/features/warehouse/SchemaPresetsPage.tsx#L1807))
**and deletes the preset holding that id** (`:1816`). So: install from the catalog as a
duplicate, then import the same ZIP, and the delete lands on the wrong preset. Same drift
on cross-workspace move ([WorkspacesPage.tsx:430](../../apps/web/src/features/workspaces/WorkspacesPage.tsx#L430)).

**2. A uuid would show in the UI.** `freshId()` mints `custom-<8hex>` for presets rather
than a uuid, and the code says why
([install.ts:83-94](../../apps/web/src/lib/catalog/install.ts#L83)): *"A schema preset's
id IS its user-facing Identifier… Minting a raw uuid there put a 36-character string in
front of the user."* That constraint exists **only** because one field serves both the PK
and the label. Splitting them dissolves it.

**3. Special-casing spreads.** Each site that treats presets differently is a place to get
wrong later:
- [git.py:1024](../../apps/api/app/api/v1/routes/git.py#L1024) — `getattr(entity, "id", None) or entity.preset_id`
- [installed.ts:38](../../apps/web/src/lib/catalog/installed.ts#L38) — `row.uid ?? row.id ?? row.presetId`
- [use-schema-preset-actions.tsx:15](../../apps/web/src/features/warehouse/use-schema-preset-actions.tsx#L15) — an adapter shim faking `id`+`name` for `EntityActionsMenu`
- [WsExportTab.tsx:187](../../apps/web/src/features/versioning/WsExportTab.tsx#L187) — "presetId for schemas, id otherwise"
- `idOf` / `freshId` / `deleteExisting` / `createShell` in `install.ts`

## What makes it tractable

- **No foreign key points at `schema_presets`.** Checked the models and
  `000000000001_initial_schema.py`: `preset_id` is the PK
  ([schema_preset.py:11](../../apps/api/app/models/schema_preset.py#L11)) and nothing
  references it. A database **copies** the mapping rather than referencing the preset, so
  renaming the PK breaks no join.
- **`lineage_id` already exists** on both the TS type and the server model — half the
  target shape is in place.
- **Databases already stopped depending on `presetId`**: they record provenance as
  `SchemaProvenance { lineageId, label, version }` (done 2026-08-25), deliberately not the
  preset's own id.

## Scale (measured, not estimated)

| Scope | Files | Occurrences |
|---|---|---|
| all `.ts/.tsx/.py/.json` | 48 | 215 |
| non-test | 36 | 164 |
| tests + fixtures | 12 | 51 |

Split by meaning: **~140** the entity id, **12** `SchemaMapping.presetId`, **11** built-in
id literals (`'omop-5.4'`, `'mimic-iv'` — the only two still live).

## Target shape

```ts
export interface CustomSchemaPreset extends Authored, Lineaged {
  id: string           // uuid, local PK          (was: presetId)
  entityId?: string    // readable slug, set once (was: presetId, again)
  mapping: SchemaMapping
  …
}
```

`SchemaMapping.presetId` stays — it is part of the mapping payload copied into every
database, and renaming it would rewrite stored data for no gain. But it stops being read
as an identity: the one place that does
([SchemaPresetsPage.tsx:1807](../../apps/web/src/features/warehouse/SchemaPresetsPage.tsx#L1807))
switches to `lineageId`, which is what fixes defect 1.

## Steps

| # | Step | Effort | Notes |
|---|---|---|---|
| 1 | ✅ **Fix the drift first, on its own** — clone/move rewrite `mapping.presetId`, and ZIP import matches on `lineageId` instead | S | Done: commit `5626004f` |
| 2 | ✅ Add `id` + `entityId` to the TS type and the server model; write both on every save path | M | Done. Additive — nothing *reads* them yet, so the app behaves identically |
| 3 | Switch the **key**: IndexedDB store keyed on `id`, alembic PK move, `presetId` retired | M | The irreversible step; no FK to update. The columns are populated by then |
| 4 | Switch readers to `id`/`entityId`: routes + `paths.ts` (**shortened uuid, like the others**), catalog `idOf`/`freshId`/`findExisting`, storage, git `_entity_id`, export/import, versioning | L | Mechanical once 2–3 land; `freshId` becomes `crypto.randomUUID()` |
| 5 | Delete the special-cases (`installed.ts` three-way fallback, the actions shim, the git getattr, the WsExportTab note) | S | The payoff |
| 6 | Regenerate the golden export fixtures; re-export the 4 published preset repos | S | `__fixtures__/export-golden/schema-preset/` |

**Step 1 was worth doing now even if the rest waits** — a real defect with a data-loss
outcome, independent of the rename.

### Where step 2 left things (2026-08-25)

Both columns exist and are **written on every path** — `buildSchemaPreset` (the one UI
writer), the catalog/git clone, the seed loader, and the cross-workspace move — plus an
alembic revision (`d5e6f7a8b9c0`) that adds them and backfills `id = entity_id =
preset_id` on existing rows. Backfilling `id` from `preset_id` rather than a fresh uuid is
deliberate: git working trees, README attachment owners and `git_sync_state` all already
point at that value, so a new one would orphan them.

Both survive export/import for free — `id`/`entityId` are not in `INSTANCE_FIELDS`, which
is exactly how every other entity carries them. The golden fixture now covers it, and the
Python twin drops them when null so an old row does not export explicit `null`s where the
client omits the keys (a false git diff).

Nothing reads them yet, so behaviour is unchanged — that is what makes step 3 safe to do
separately.

⚠️ The Python-side changes (model, schemas, service, export twin, golden test) were
verified by reading and by key-order comparison, **not** by running the suite: the API's
dependencies are not installed in this environment. Run `pytest apps/api` before relying
on them.

## Decisions (2026-08-25)

**The governing rule: harmonise with the other entities wherever there is a choice.** A
preset is not special; every deviation below had a local reason that no longer holds.

1. **The URL carries the shortened uuid**, like every other entity — not the slug. So
   `paths.warehouseSchema` stops being the exception documented at
   [paths.ts:75](../../apps/web/src/lib/paths.ts#L75), and `freshId` becomes a plain
   `crypto.randomUUID()` (the reason it minted `custom-<8hex>` — "the id IS the
   user-facing Identifier" — disappears once `entityId` holds the slug).

2. **`ATHENA_SCHEMA_MAPPING` is independent of the installed schemas** — done, see below.

### `ATHENA_SCHEMA_MAPPING` — settled

Not a preset reference at all: a `SchemaMapping` written out in
[ConceptSetsTab.tsx](../../apps/web/src/features/warehouse/concept-mapping/ConceptSetsTab.tsx)
to read OHDSI ATHENA vocabulary files, used to build the vocabulary reference database and
to generate the concept search query. It resolved nothing — `presetId: 'omop-cdm-5.4'` was
an inert label satisfying a required field, next to a `presetLabel` of "ATHENA
Vocabulary". It named a slug that is not even the built-in table's key (`omop-5.4`).

Now `presetId: 'athena-vocabulary'`. An ATHENA download always has the same shape and the
concept search must work with no OMOP schema installed, so this stays hardcoded **on
purpose** — the fix was removing the false dependency, not adding a real one.

This is also the case that shows why the target shape is right: a mapping can legitimately
come from no preset at all. After harmonisation `mapping.presetId` is a label, and identity
lives in `schemaSource.lineageId` — already true for databases.

## Open questions

- **`String(36)` on the PK column** ([schema_preset.py:11](../../apps/api/app/models/schema_preset.py#L11))
  is uuid-width but currently holds slugs. Fine for a uuid `id`; `entityId` needs its own
  column with a length that fits a slug.
- Whether the **built-in `SCHEMA_PRESETS` table** disappears first (plan §10 of
  `default-data-repos-plan.md`) or after. It only holds `omop-5.4` and `mimic-iv`, kept
  alive for seeded databases; doing that first removes 11 literal sites from this effort.
