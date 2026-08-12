# Versioning — remaining work

> Merge of what remained from three mostly-completed efforts: `git-sync-plan.md`
> (bidirectional pull), `server-export-plan.md` (server-side export ZIP) and
> `workspace-source-concept-ids-ownership.md` (source-concept-id ownership).
> The as-built is documented in `docs/architecture.md` ("Versioning (as-built)" and
> "Fullstack Storage & Compute"). This document keeps only the remaining work.
> Rewritten 2026-08-12: the **pull redesign** (part II) is now the bulk of it.

## Done (see docs/architecture.md)

- Behind/diverged detection (`git_sync_state` table, anchor written at push/pull, lazy
  adoption after import), banner + safety guard: **push refused while behind**.
- Pull for **mapping-project** (fine-grained 3-way merge: mappings line by line keyed by
  source+target, metadata per field, source-concepts/scores as whole blocks, LFS via
  `pull-file`) and pull for **project** (clone-based, diff per group, re-applied via
  `importProjectContent`).
- Export ZIP built **server-side for every scope** (`serverBuildsZip` returns true in
  server mode; the git routes fall back to their `assemble_fn` when no file is
  uploaded). TS↔Python parity pinned by golden tests (one frozen `expected/` tree per
  scope, compared per extracted file, never zip-container bytes). Like the
  mapping-project builder, server-built ZIPs don't take per-file LFS overrides
  (documented trade-off — the entity scopes are light JSON content).
- Settings versioning (scope `account`: orgs/users/roles, passwords never exported,
  re-imported user without a hash = disabled).
- Source-concept-id ownership: root `ranges.json` only, entries per project, monotone
  merge (`nextId = max`) on import/seed, root entries read as legacy fallback.
- **Instance/volatile field stripping — done for every scope** (verified 2026-07-22):
  `stripInstanceFields` (entity-io.ts) is applied by `buildProjectZip` (meta, pipelines,
  cohorts, databases, dashboards/tabs/widgets, dataset trees/assets), `buildWorkspaceZip`
  (meta + per-project reuse) and all six standalone entity builders (user-plugins use an
  explicit whitelist, stricter). Python twins each carry the matching `_INSTANCE_FIELDS`,
  reused by `workspace_export_assemble.py` for the child scopes.
- Empty commit selection can no longer fall through to the server's "commit everything"
  path (`_commitPushPaths` refuses an empty array; a missing `paths` field means
  `git add -A` server-side).
- **Path-keyed `_tree.json` for sql-collections / etl-pipelines** (done 2026-08-04,
  still export format `2.2.1` — the `VERSION` bump is deliberately deferred to the
  next release): the versioned tree carries `path` instead of
  `id`/`parentId`/`name`/`collectionId`, and local ids are derived on import via
  `deterministicId(<owner id>, path)` — see `lib/entity-tree.ts`. Kills the id churn
  (the tree no longer holds an instance-local identity at all) and makes the ids
  idempotent per target without any collision-recovery pass. Same family as the
  dataset `col_<slug>` ids and the dashboard/tab/widget content keys. `readPathTree`
  keeps reading legacy id-keyed trees (repos pushed before the bump). Side effect
  fixed in passing: the seed loader read nested script content at a flat
  `<folder>/<name>` path, so a script in a subfolder seeded empty.
  Extended to **`scripts/_tree.json`** (a project's IDE files) the same day: same
  reasoning, ids derived from `deterministicId(projectUid, <path relative to
  scripts/>)`. `project-pull` already selected scripts by path, so it got simpler.
  **Still NOT applied to `datasets/_tree.json`**: widgets and filters point at
  dataset + column ids, so a rename-driven re-mint would break those references —
  datasets keep the name-derived `col_<slug>` / `deterministicId(projectUid, oldId)`
  remap. The rule is "the natural key must be at least as stable as the references
  pointing at it", not "paths everywhere".
  `../linkr-portal/scripts/build.sh` was updated in step (commit `ef9de69`): its seed
  manifest index now recurses and keys `sqlScriptFiles`/`etlFiles` by tree path, so a
  script in a subfolder is seeded with its content (a flat basename key also made two
  same-named files in different folders collide). Since the seed loader reads a legacy
  id-keyed tree too, that portal change is safe either way.
- **Similarity scores removed from the pull** (2026-08-12) and **row-level
  source-concept diff by `(vocabulary_id, concept_code)`** — see part II,
  "Already shipped".

---

# Part I — Remaining (outside the pull redesign)

### 1. [TO TEST] End-to-end pull flow, especially the LFS path

Full 2-workspace flow (crossed pull/push), and above all the **LFS** path of
`pull-file` (source CSV) against a real endpoint (GitLab/GitHub with LFS enabled) —
validated in logic only so far. The plumbing exists (`_ensure_lfs`,
`GIT_LFS_SKIP_SMUDGE` fetches, pointer resolution in `pull_file_bytes`, git-lfs in
`Dockerfile.api`) but no test round-trips a real LFS object
(`tests/test_git_service.py` pushes plain CSVs to a local `file://` remote).
Manual validation first (~0.5 d); an automated integration test needs git-lfs in CI.

### 2. [TODO — small] Foreign files: server-side guard + optional listing

The UI is safe: every commit path passes explicit `paths`, empty selections are refused
client-side, and `defaultSelectedPaths` never checks unowned files by default. What
remains is defense in depth: the server still trusts `paths is None` → `git add -A` on
a tree wiped by `_unpack_zip_into`
([git_service.py](../../apps/api/app/services/git_service.py)) → it would record the
**deletion** of the remote's foreign files if a client ever omitted the field.
Optional hardening: refuse `paths=None` on the HTTP route (internal callers keep the
service default), and/or a read-only "Files outside the application" listing in the
sync UI (cosmetic — droppable).

### 3. [LATER] Server-side import (the big remaining offloading effort)

Import is today **100% client-side**: JSZip in the browser
(`parseProjectZip`/`parseWorkspaceZip`/`importProjectContent`) + per-entity HTTP calls —
the main remaining heavy client path in fullstack mode. Target: `POST /projects/import`
and `POST /workspaces/import` endpoints (ZIP → DB on the server). Twin project of the
server export, with the same duplication/consistency stakes (Python parsers for
`_tree.json` + contents; the TS parsers stay for front-only) — to tackle now that the
format contract (golden) is stable. Invariant to reproduce: a `sourceConceptId` is
global per `(vocab, code)` within a workspace — the client applies
`reconcileImportedEntries` (keeps the local id). Only worth it if client weight in
fullstack mode is an actual user pain; several days of work.

> Known parity reminder: JS `JSON.stringify` writes a round float as `0` where Python
> (a `Float` column) writes `0.0`. Not solved globally — the golden fixtures avoid round
> floats; if it surfaces in real data, normalize at the serializer or accept the diff.

---

# Part II — Pull redesign (bidirectional versioning UI)

> Design arbitrated 2026-08-12. Supersedes the pull sections of `git-sync-plan.md`
> and the former "pull for the 6 other scopes" item.

## Why

Three problems with the pull as it stands, all from the same root: **pull was built
as a dialog bolted onto a push-shaped panel**, with its own vocabulary, its own
mental model, and no relationship to the push UI beside it.

1. **A modal, disconnected from the panel.** The user learns one interface for push
   (files, checkboxes, diffs) and a second, unrelated one for pull (categories,
   prose sentences, block choices). Two models for one job.
2. **The push file list stays visible while behind**, ending in a disabled button.
   It shows what the user cannot do, next to a banner telling them so.
3. **Concept-mapping specifics leak into the UI**: "Replace my similarity scores with
   the remote ones (?)" — for a file that is gitignored and cannot exist in any repo —
   and "Replace my source concepts with the remote list (61925)", where 61925 is a
   total, not a change. It reads the same whether two concepts were added or every
   one was replaced.

The fix is to make the panel **bidirectional**: the same file list, the same diffs,
the same quick-action cards, pointing the other way.

## Design principles

Load-bearing decisions; everything below follows from them.

### P1 — Files to choose, business objects to apply

There are no local files. The local truth is the database; the repo tree is a
*projection* generated at export time. So a pull cannot apply "40% of
`mappings.json`" — the applicable unit is the mapping, the concept, the metadata
field.

But the *file* remains the right unit of **choice**: it is the vocabulary the push
already uses, on the same screen. So: **file as the interface, business object as
the mechanism.** Details lists files; applying dispatches to per-object appliers.

### P2 — The diff shows what will happen, not what differs

A raw `git diff` on `project.json` shows `uid`, `createdAt`, `gitRemoteConfig`,
`ownerId` — all different between two instances, all normal, none ever imported.
Showing them would be a lie: the user ticks expecting all of it and gets six fields.

So the pull diff is a **projection of the merge plan**, not a file comparison: only
the candidate fields (in `METADATA_FIELDS` *and* actually changed by the remote since
BASE), only the mappings the merge classified as actionable, only the source-concept
rows that moved. What is displayed and what is applied come from one source, so they
cannot drift.

Corollary: this also solves the size problem. The rendered content is already reduced
to actionable items, so Monaco never receives 61 925 lines; the server-side
`truncationMode: 'hunks'` truncation becomes a safety net rather than the mechanism.

(The **push** diff stays a true file diff — there we really do send the whole
generated file. The two directions differ in nature, and that is correct.)

### P3 — Deciding is not the same as not-deciding

The current model has two outcomes: took everything (anchor advances), took nothing
(anchor advances, *keep local*). The in-between — "I take these three mappings and
keep mine on the other two" — is inexpressible, so it leaves the banner up and the
push blocked forever.

The confusion is that `syncedOid` carries two meanings at once: *"I hold this commit's
content"* (the 3-way base) and *"I have processed this commit"* (the push gate).
Split them:

- `synced_oid` keeps meaning 1 — advances **only on a complete pull**. It is the merge
  base; moving it on a partial pull would bury the un-taken items forever.
- `reviewed_oid` carries meaning 2 — "every incoming item got an explicit decision".
  **This is what unblocks the push.**

An item the user declined stays local and **reappears in the push list** as a local
modification — which is the truth: they decided their version wins, so they push it.
Nothing is buried, because what was refused did not disappear; it became their
position, visible before they push it.

The strict condition: **an explicit refusal is a decision, an untouched checkbox is
not.** Otherwise validating without reading would bury everything incoming. Hence the
to-review / reviewed split (P4) and an explicit finalize step.

### P4 — To review / reviewed, and a finalize step

A checkbox has two states; we need three: untouched, accepted, declined. Taken from
the SNOMED Authoring Platform's Concept Merges screen (see Prior art): everything
lands in **To review**, each decision moves the row to **Reviewed** with a badge
saying which way, and **Finalize** is disabled while To review is non-empty.

Closing the panel mid-way keeps the decisions as a draft (the draft cache already
exists in `PullResolveDialog`) but applies nothing and unblocks nothing.

### P5 — Bulk-accept the consensual, never the contested

A clean change can be accepted en masse. A **conflict** (both sides changed the same
unit differently) always requires an individual gesture: a card's accept-all button
disables when conflicts are present and points at the table.

This is what keeps P4's rigour from making the common case painful: **Pull all** is
one click for whoever just wants to be up to date. The per-item discipline only
applies to whoever opens the detail.

### P6 — Symmetry between push and pull, but not uniformity

Same cards, same categories, same file rows, same diff viewer. Two deliberate
asymmetries:

- **Verbs stay different** — "Sync" for push, "Pull" for pull. Unifying on "Sync"
  would make the direction ambiguous exactly where it matters.
- **Empty cards: hidden in pull, shown-disabled in push.** Push is a permanent state
  one consults ("nothing to send, good"); pull is an event one processes, where three
  greyed cards around one active card drown the signal.

## Prior art (researched 2026-08-12)

Establishes that the design is not a deviation from git through ignorance, but
convergence with the products that actually solved this problem.

**No git GUI does selective pull.** GitHub Desktop, GitKraken, Sourcetree, Fork,
Tower, SmartGit, VS Code, JetBrains: pull is all-or-nothing everywhere. Selectivity
appears only *after* a conflict is raised, never as a pre-pull "choose what to take".
None records "I saw this remote version and kept mine" — git records the merge
*result*, not the deliberation.

| Product | Granularity | Pre-pull review | "Reviewed & declined" state |
|---|---|---|---|
| **ServiceNow update sets** | per-record | Yes (Preview) | **Yes — Skip Remote Update** |
| **SNOMED Authoring Platform** | per-concept | Yes (Concept Merges) | No (resolution only) |
| **Redgate SQL Compare** | per-object checkbox | Yes (diff grid) | Partial (selection saved in project) |
| Dolt | per-row / per-cell | Merge preview | No |
| Liquibase | per-changeset | Drift report | Partial ("mark as run") |
| Salesforce change sets | per-component, **build-time only** | No (inbound = all) | No |
| Figma | **per-page at best** | Yes (rich visual) | No |
| lakeFS | merge-wide strategy only | No | No |
| Dataiku | none (`pull --rebase`, aborts on conflict) | No | No |
| **OHDSI Usagi** | **no merge model at all** | No | No |

Three things to take from it:

- **ServiceNow's *Skip Remote Update*** is exactly P3: a persisted, per-record "I
  reviewed this incoming change and deliberately kept mine", after which the commit
  proceeds honouring the skips. (Known rough edge reported by their community: the
  preview list re-appearing after reload — persistence is the part to get right.)
- **SNOMED's Concept Merges** is P4: *Merges To Review* / *Merges Accepted* tabs, a
  three-version panel (project / merged / task), per-concept accept, and a *Finalize
  Merges* step. Per business object, not per file.
- **Figma is a cautionary tale, not a model.** Best *review* UI in the survey —
  changes grouped by page, objects tagged added/edited/removed, side-by-side — paired
  with all-or-nothing *resolution*: *"Branch reviews apply to all changes in a branch.
  There isn't a way to approve some changes and reject others."* There is a standing
  feature request for exactly the checkbox UI we are building. **Rich review without
  selective resolution frustrates users.**

And the domain argument: **Usagi, the dominant OMOP mapping tool, has no merge model
whatsoever** — a single-user Java desktop app whose own security note says it was
designed "for use within a secure and trusted environment". Teams share mappings by
passing the file around. The gap is real.

## Target UI

```
┌─ Repository ──────────────────────────────── [⚙ Config] ─┐   ← Config modal (URL/token/disconnect)
│ ┌ Quick actions | Details ─────────────────────────────┐ │
│ │ Branch: [main ▾]              [⚙ Config] [↻ Refresh] │ │   ← Config sits LEFT of Refresh
│ │ ⓘ The remote has changes you don't have yet.         │ │   ← ONE banner (see below)
│ │                                                       │ │
│ │  ── PULL MODE (remote ahead) ──                      │ │
│ │  [Pull all]  [Pull general info]                     │ │
│ │  [Pull mappings]  [Pull source concepts]             │ │
│ │                                                       │ │
│ │  ── PUSH MODE (in sync) ──                           │ │
│ │  [Sync all]  [Sync general info]                     │ │
│ │  [Sync mappings]  [Sync source concepts]             │ │
│ └───────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

**Mode switch.** When `behind || diverged`, the panel is in **pull mode**: the push
file list and the commit box are **hidden** (not disabled), and both tabs show pull
content. Once reviewed (P3), it returns to push mode.

**Banner cleanup.** Today two notices overlap: `sync_behind` ("The remote has changes
you don't have yet") and `quick_pull_required` ("...syncing isn't possible until you
pull them first (use the Pull button below)"). Since the quick-actions area *becomes*
the pull UI, the second is redundant → **remove `quick_pull_required`**, keep
`sync_behind`. Same for `sync_pull_first` (the inline note beside the now-hidden push
button).

## Quick action cards — element by element

Four cards, **symmetric between push and pull**, derived from the existing
`gitFileMeta` categories so one path is never called two different things across two
screens.

| Card | Files | Push label | Pull label |
|---|---|---|---|
| All | everything owned | Sync all | Pull all |
| General info | `project.json`, `README*.md`, `LICENSE.md` | Sync general info | Pull general info |
| Mappings | `mappings.json` | Sync mappings | Pull mappings |
| Source concepts | `source-concepts.csv` | Sync source concepts | Pull source concepts |

**This fixes the push side too.** Today `mapping-projects` has only two cards, and
"Sync mappings" matches `project.json` **and** `mappings.json` — so it pushes metadata
under a name that says it doesn't. And there is **no card for source concepts at
all**. Both are corrected here: `quick_sync_mappings` → `[/^mappings\.json$/]` only,
plus two new cards.

### Card: All

Primary, carries `SYNC_ALL_ACCENT`. Summary line ("12 mappings, 5 concepts, 3
fields"). One click takes everything, marks everything reviewed, finalizes. This is
the counterpart to P5 — the common case must stay one click.

### Card: General info

The finest case: metadata merges **per field** (`METADATA_FIELDS` =
`name, description, badges, status, readme, license`).

- Lists each candidate field inline with a remote preview — `Name: "Adult ICU Rennes"
  → "Adult ICU Rennes v2"`. On 3–4 short fields no table is needed; a checkbox per
  line suffices.
- `readme` / `license` are long text → no inline preview, a "view diff" button
  instead.
- **README language variants are distinct rows** (`README.md`, `README.fr.md`):
  taking English without French is legitimate.
- Conflicted fields get the mine/theirs choice, never a bulk accept (P5).

**What is never imported** (P2 and the ownership rules): `id`/`uid` (local identity —
overwriting orphans every mapping, concept and badge pointing at it), instance fields
(`gitRemoteConfig`, `ownerId`, `createdAt`/`updatedAt` — the `createdAt` drift bug of
2026-08-01), and `fileSourceData` (heavy, has its own card). The whitelist stays
closed: a wholly foreign `project.json` can only ever move those six fields.

### Card: Mappings

- Counts by change type, reusing the existing colours: `+12` add (emerald), `~4`
  update (sky), `−1` delete (rose), conflicts (amber).
- "Choose" opens `PullMappingsTable` (exists, good, just needs rewiring) with the
  To review / Reviewed split.
- **If conflicts exist, the card's accept-all is disabled** and points at the table (P5).
- Identity is `mappingKey` (source+target), never `id`. Compared on `COMPARED_FIELDS`
  — which includes `comments` and `reviews`.

### Card: Source concepts

- Counts by identity pair `(vocabulary_id, concept_code)`: `+2 / −5 / ~13`, with the
  total for context ("61 925 concepts total"). **Already built** — see below.
- Default gesture is take-all (the source list usually comes wholesale from an
  upstream export), but per-row choice must exist — above all for **deletions**:
  losing 5 concepts that have mappings attached is exactly what one wants to see first.
- **Unkeyable fallback**: when `keyed === false` (unsmudged LFS pointer, missing
  identity column, absent file), the counts are meaningless. The card must say "full
  list, 61 925 rows" and offer only the whole-file choice — never `+0/−0`.

### Empty cards

Hidden in pull, shown-disabled in push (P6).

## Details tab — element by element

Strictly file-based, the mirror of push. Same `groupGitFiles` categories, same sticky
headers, same row layout, same `GitDiffDialog` (with `oldContent` = remote,
`newContent` = local).

| File | Category | Ticking it means | Applier |
|---|---|---|---|
| `project.json` | general | take all **clean** field updates | `mergeMetadata` → `mappingProjects.update` |
| `README*.md`, `LICENSE.md` | readme | take the docs | same, via `readEntityDocsFrom` |
| `mappings.json` | mappings | take all **clean** mapping changes | `applyMappingChange` per object |
| `source-concepts.csv` | concepts | replace the list | `replaceSourceConcepts` |
| `source-concept-ids/*.json` | concepts | *(see Not yet pullable)* | — |
| `attachments/**` | readme | *(see Not yet pullable)* | — |
| `.gitignore`, `.gitattributes` | config/attrs | not pulled (repo machinery) | — |

**Conflicts in a file-level view.** A file containing conflicts gets an amber badge
("3 conflicts") and ticking it does **not** silently resolve them: it takes the clean
changes and leaves the conflicts to the table in Quick actions. A conflict is
precisely the case where an implicit choice is wrong (P5).

## Not yet pullable — designed now, built later

Everything a mapping-project repo carries that the pull ignores today. Listed so the
gaps are known rather than discovered later.

### 1. `source-concept-ids/` — the badge allocation registry ✅ DONE (2026-08-12)

`entries.json` (per-project `(vocab, code) → sourceConceptId`) and `ranges.json`
(per-badge allocation counter) were **pushed but never pulled**. Two instances
allocating badges in parallel diverged silently — and these ids end up in generated
OMOP concepts, so the divergence was not cosmetic.

The merge rule already exists on the import path and should be reused verbatim:
**monotone union** — entries merged keeping the local id on collision
(`reconcileImportedEntries`), ranges merged with `nextId = max`. It is commutative and
idempotent, so it needs no user choice: **no card, no checkbox, always applied**, like
a CRDT counter. Mention it in the summary ("badge allocation synchronised"), don't ask
about it.

Built as `lib/concept-mapping/pull-source-concept-ids.ts`, fed by
`source-concept-ids/*.json` now in `_PULL_TEXT_FILES`. Deliberately absent from the
file list: listing it would ask the user to arbitrate something with no wrong answer.

### 2. `attachments/` — README images

Pushed, never pulled: a README pulled from the remote can reference images that never
arrive, rendering broken. `applyClonedEntity` already handles them for the clone path
(`createEntityAttachments` + `readEntityDocs`), so the applier exists.

They belong to the **General info** card (category `readme`), following the README
rather than being a card of their own — nobody wants to arbitrate images separately
from the text that references them. Needs `attachments/_meta.json` + blobs in the
preview payload (binary → a `pull-file` whitelist extension). Effort **S/M**.

### 3. The six other entity scopes + workspaces

`sql-script-collection`, `etl-pipeline` (has its own dialog), `data-catalog`,
`dq-rule-set`, `schema-preset`, `user-plugin`, `workspace`. Most have Link + Push
only: no banner, no pull.

**Do not build a fine-grained merger for these** (decided 2026-07-22, still right):
`applyClonedEntity` already reconstitutes all of them from a cloned repo
(delete-first) — an effective pull-overwrite. What is missing is the behind/diverged
banner per scope (`syncStateSupported` gate + `sync-state` endpoints) and a "Pull
(overwrite from remote)" action.

With this plan they fit the same shell for free: file list from the clone, per-file
checkboxes, per-file diff, Pull all card. The **General info** card is universal
(every entity has name/description/README/licence); only the content cards differ per
scope. So the generic pull view should be written **scope-agnostic from the start**,
with mapping-projects as the first implementation rather than the only one.

`project` and `etl-pipeline` already have clone-based dialogs (`ProjectPullDialog`,
`EtlPullDialog`) that should converge onto the same shell once it exists — they
already group by `gitFileMeta` categories deliberately. Effort **M** per wave.

### 4. Databases / connections

Deliberately excluded from project pull (instance-level resource, credentials
encrypted at rest, never travel). **Keep excluding.** Noted so the omission is
recorded as a decision rather than an oversight.

### 5. Similarity scores — closed

Gitignored (re-derivable, ~100 MB), so never in a repo. Removed from the pull
(shipped, below). Still exported in ZIP form, which is legitimate and unchanged.

## Data model

```sql
-- existing
git_sync_state(scope, entity_id, branch, synced_oid)
-- added
                                          , reviewed_oid   -- P3: "every incoming item got a decision"
```

`behind` is computed against `reviewed_oid` (falling back to `synced_oid` when null,
so existing rows keep their current behaviour). `synced_oid` keeps its strict meaning
and still only advances on a complete pull.

**Per-object declines.** Storing "this mapping, this remote version, declined" (rather
than a single commit cursor) is what lets a *later* remote change to the same object
be re-proposed: the decline covered that version, not that object forever. A disputed
mapping may come back more than once — tiring but honest.

```sql
git_pull_decision(scope, entity_id, branch, object_kind, object_key, declined_oid, decided_at)
```

Keyed by the same natural keys as the merge (`mappingKey`, field name, `vocab|code`),
never by local id.

## Implementation status

Steps 1–8 shipped 2026-08-12 on `feature/fastapi-backend`. Step 9 remains.

| # | Item | Status |
|---|---|---|
| 1 | `reviewed_oid` column + Alembic + `sync-state` + `behind` against it | ✅ |
| 2 | `lib/pull-plan.ts` (scope-agnostic) + `pull-plan-builder.ts` | ✅ |
| 3 | Pull mode in `GitSyncPanel` (push hidden while behind, banner cleanup) | ✅ |
| 4 | Details pull list (`PullFileRow`) + `PullDiffDialog` | ✅ |
| 5 | Four symmetric cards + push-side fixes | ✅ |
| 6 | Per-item decisions + Finalize gate | ✅ |
| 7 | `source-concept-ids/` monotone merge | ✅ |
| 8 | Config dialog (URL / token / disconnect) | ✅ |
| 9 | Scope generalisation: converge Project/Etl dialogs, then the 6 scopes | 🔜 |

### As built — where things live

- **Cursors**: `git_sync_state.reviewed_oid` (migration `d0e1f2a3b4c5`),
  `set_reviewed_oid` in `git_sync_state_service`, `reviewedOnly` on
  `set-sync-state`, `behind` measured against the review cursor with a fallback to
  the anchor for rows predating the split.
- **Plan**: `lib/pull-plan.ts` — `PullFile`/`PullItem`, `isFullyReviewed` (the
  finalize gate), `isCompletePull` (which cursor may advance). Mapping-project
  builder in `lib/concept-mapping/pull-plan-builder.ts`.
- **UI**: `PullPanel` (cards + Details), `PullFileRow`, `PullDiffDialog`,
  `MappingProjectPull` (owns the merge + verdicts), `GitConfigDialog`.
  `PullResolveDialog` deleted.
- **Diff**: `lib/concept-mapping/pull-diff.ts` — the P2 projection.
- **Registry**: `lib/concept-mapping/pull-source-concept-ids.ts`, applied on every
  pull, never offered as a choice.

### Deviations from the design above

- **`pickable`** was added to `PullFile`: the file's items can be chosen one by
  one, in a table. Both `mappings.json` (`PullMappingsTable`) and
  `source-concepts.csv` (`PullConceptsDialog`) are pickable, and the two tables
  are deliberately the SAME interaction — checkbox column, sortable headers,
  per-column filters. Two tables doing the same job must not be driven differently.
  The source CSV is still written as one blob, but `mergeSourceConceptsCsv`
  rebuilds that blob around the refusals (keep my row on a declined change or
  removal, drop a declined addition), so ticking rows is a real choice rather than
  a decoration. A partial apply on an unkeyable file **throws** rather than falling
  back to "take everything", which would apply what the user refused.
- **Items expand inline** under a non-pickable row. Without it, a `project.json`
  carrying a conflicted field was a dead end — bulk-accept refused (P5) with no
  picker to route to. Metadata fields are now decided on the row itself, and the
  card points at Details when that is where the choice lives.
- **`sourceConceptsChanged`** replaced the bare oid test. `listChangedByOid` asks
  "did the remote move since our anchor?", which is a *different question* from
  "does the remote differ from what we hold" — so a local list that had drifted
  from an unmoved remote never appeared in the pull at all. The server's row diff
  is now authoritative; the oid test stays as the fallback for a CSV that could
  not be keyed. It also suppresses the reverse noise: a re-export that changes the
  bytes (column order, quoting) without changing a concept no longer offers a pull.
- **The server lists the changed rows**, capped at 2 000
  (`_MAX_LISTED_CONCEPT_CHANGES`), with the counts left exact — a truncated
  listing must never understate what is being accepted.
- **Identity columns come from the project, not from guessed names.** A source CSV
  is the *user's* file: the real RiCDC/mimic-iv export heads its vocabulary column
  `terminology_code`, which is in no guess list, so name-guessing alone declared a
  perfectly good 61 579-row file "not comparable" and the pull offered no row diff
  at all. `fileSourceData.columnMapping` now takes priority on both sides (Python
  and TS twins), with the guessed names kept as the fallback for a stale mapping.
- **`_materialize_at`** replaced `git show` for reading the remote CSV: `git show`
  returns the LFS *pointer* for a tracked file (our fetches skip the smudge
  filter), so any caller needing real content — not just a fingerprint — must go
  through it. Extracted from `pull_file_bytes`, which already did this correctly.
- **The mappings diff keys on source → target**, not source alone: one source
  concept can legitimately have several mappings, and keying on the source made
  them collide so the diff showed fewer changes than the pull would apply.
  Absent/unchanged sides render as `(absent)` / `(unchanged)` rather than `null`,
  which read as "the value is null".
- **ONE quick-action card per scope for mapping projects, both directions.** The
  four symmetric cards were a false symmetry: `stats` in `project.json` is DERIVED
  from `mappings.json`, so "Sync mappings" pushed rows whose counters stayed behind
  in a `project.json` it never touched — a repo contradicting itself. And on the
  pull side the choice is already per element inside each picker, so a coarser
  grouping on top only asked the user to choose twice. A genuine subset lives in
  the Details tab, where the whole file list is in view. (`projects` keeps its
  dashboards/scripts cards — those files have no such derived coupling.)
- **A pull recomputes the project stats.** A pull writes mappings straight to the
  DB, bypassing the store paths that normally schedule a recompute, so the
  counters kept describing the pre-pull state and the next push would have
  committed a `project.json` contradicting its own `mappings.json`.
- **`(vocabulary, code)` is NOT unique in a real source file.** MIMIC ships
  `Acetaminophen` and `Acetaminophen ` (trailing space) as distinct concepts — 345
  such pairs in the RiCDC export. Keying rows on the bare pair collapsed them: the
  diff under-counted (61 579 keys for 61 925 rows) and a partial merge would have
  DROPPED every repeat from the rebuilt CSV. Repeats now carry an occurrence
  suffix (`pair#1`, `pair#2`), on both the TS and Python sides.
- **CSV parsing honours quoted newlines.** `split('\n')` cut a concept whose
  `metadata_json` contains a wrapped JSON value into several half-rows, shifting
  every later column. `csvRecords` parses properly.
- **The push diff trims common affixes before `difflib`.** These files are
  generated: a 59 000-line `mappings.json` with three changed blocks took **5.5 s**
  to diff, because every identical line was still compared (difflib is ~O(n·m)).
  Skipping the untouched head and tail leaves ~80 lines and takes **13 ms** — a
  420× speedup — with the `@@` offsets added back so line numbers stay real. This
  is why the pull felt instant while the push diff hung: the pull renders a
  projection of the merge plan (a few objects) and never diffs text at all.

### Left for step 9

Converge `ProjectPullDialog` / `EtlPullDialog` onto the same shell (they already
group by `gitFileMeta` categories), then give the six push-only scopes the
behind/diverged banner plus a pull-overwrite action via `applyClonedEntity`. The
plan layer is already scope-agnostic, so this is mostly wiring a builder per scope.

Also still open, from "Not yet pullable": `attachments/` (§2) — a pulled README can
reference images that never arrive.

## Tests

Pure logic, per `docs/conventions.md`: `buildPullPlan` classification (file rows +
conflict counts), the anchor rules (`mayAnchor` — complete / keep-local /
partial+reviewed), the metadata field whitelist (a foreign `project.json` moves only
the six fields), the monotone source-concept-id merge, and the existing
`merge.test.ts` / `source-concepts-diff.test.ts` extended. No UI unit tests.

## Already shipped (2026-08-12, on `feature/fastapi-backend`)

Groundwork done before the design discussion; independent of the rest.

- **Similarity scores removed from the pull.** `_PULL_STAT_FILES` no longer carries the
  parquet; the `pull-file` whitelist is `source-concepts.csv` only. Kills the "Replace
  my similarity scores with the remote ones (?)" row, which offered a file that cannot
  exist in a repo. ZIP export unchanged.
- **Row-level source-concept diff by `(vocabulary_id, concept_code)`.** Computed
  **server-side** (`_key_source_concepts` / `_diff_source_concepts` in
  `git_service.py`), since both sides are already on disk there — shipping two ~5 MB
  CSVs to the browser to count rows would cost more than the pull itself. Returned as
  `sourceConceptsDiff` on `pull-preview`. A `keyed: false` flag marks an unparseable
  side (LFS pointer, missing identity column) so the UI never shows a misleading `0/0`.
  TS twin in `lib/concept-mapping/source-concepts-diff.ts` for the front-only path,
  with a **shared fixture asserting identical numbers on both sides** so the two
  implementations cannot drift. Tests: 14 (vitest) + 10 (pytest), all passing.

---

## Won't do (decided 2026-07-22)

- **Client-side pull (front-only / WASM)** — everything git-related in front-only mode
  stays push-only; pull requires the backend. Decision: not doing it.
- **Exact client-side source-concept-id entry scoping** — the front-only client keeps
  exporting the **whole badge** (`buildProjectSourceConceptIds`): faithful scoping would
  require reproducing the server's deduplicated-dictionary read (CSV quoting, QUALIFY
  dedup, terminology fallback) = a third divergent implementation. **Known limitation**
  (see the note in
  [source-concept-ids-io.ts](../../apps/web/src/lib/concept-mapping/source-concept-ids-io.ts)):
  a mixed front-only/server team on the same remote sees churn on `entries.json`.
  Accepted while the mixed case stays marginal.
- **Fine-grained merge for the 6 entity scopes** — superseded by the pull-overwrite
  approach (Part II, "Not yet pullable" §3).
