# Community catalog — design

> The `/catalog` page is a stub today (`features/catalog/CatalogPage.tsx`, "coming soon").
> This is the plan to make it real: a **centralized index repo** on framagit that lists
> community-published Linkr entities, read by the app over HTTP.
> Groundwork already in place: `catalogVisibility` on entities, author/ORCID + org/UUID
> snapshots, `lineageId`, `GitRemoteConfig` + `applyClonedEntity` for the install path.

## 1. The repo

**Name: `linkr-catalog`** → `https://framagit.org/interhop/linkr/linkr-catalog`

Sibling of `linkr`, `linkr-portal`, `linkr-website` under the existing `interhop/linkr`
group. Rejected alternatives: `linkr-registry` (npm-ish, implies a package host — we only
hold pointers), `linkr-hub` (vague), reusing `LinkR-content` (already a portal test
fixture: a `workspace.json` + `projects/`, unrelated shape).

### Layout

```
linkr-catalog/
├── README.md                 # how to submit (the contributor-facing doc)
├── CONTRIBUTING.md
├── entries/                  # ← ONE FILE PER ENTRY. This is what contributors touch.
│   ├── ricdc-neoclip.json
│   ├── indicate-dd.json
│   └── …
├── catalog.json              # BUILT — the single aggregated file the app reads
├── catalog-index.json        # BUILT — light: ids + hashes, for update checks
├── schema/entry.schema.json  # JSON Schema, used by CI to validate a PR
├── scripts/build.mjs         # entries/*.json → catalog.json + catalog-index.json
└── .gitlab-ci.yml            # validate on MR; build + commit on main
```

**One file per entry under `entries/`** is the load-bearing choice: two contributors
adding entries in the same week never conflict (a single big JSON array would collide on
every MR). The aggregated `catalog.json` is *generated*, never hand-edited.

## 2. The three files — answering "one file or several?"

You floated 1/2/3 files. Recommendation: **two built files, and the hash lives inside
them** rather than as a third file.

| File | Size | Fetched when | Contains |
|---|---|---|---|
| `catalog-index.json` | ~2–5 KB | every update check | `catalogVersion`, `generatedAt`, `contentHash`, and `{id: hash}` per entry |
| `catalog.json` | ~50–500 KB | initial load + when the hash differs | `generatedAt`, `contentHash`, and every entry in full |

Why not a third hash-only file: the index *is* the hash file — it's already small enough
to fetch on every check, and it additionally tells you **which** entries changed, so the
UI can say "3 new, 1 updated" instead of a bare "something changed". A separate
`hash.txt` would be one more HTTP round-trip and one more thing to keep in sync.

The top-level `contentHash` in both files is the same value (hash of the sorted entry
hashes), so a single index fetch decides whether to re-download `catalog.json`.

This mirrors the existing seed mechanism exactly (`seed-hashes.json` +
`vite-plugin-seed-hashes.ts` → `seed-change-detector.ts`), which already does
manifest-vs-localStorage-baseline diffing and produces added/modified/removed lists.
Same shape, same diff engine, so the two can't drift conceptually.

### `entries/<slug>.json` — what a contributor writes

```json
{
  "id": "ricdc-neoclip",
  "type": "project",
  "git": { "url": "https://framagit.org/ricdc/neoclip", "branch": "main" },
  "name":        { "en": "NeoCLIP", "fr": "NeoCLIP" },
  "description": { "en": "Neonatal ICU …", "fr": "Réanimation néonatale …" },
  "author":      { "name": "Boris Delange", "orcid": "0000-0002-1234-5678" },
  "organization":{ "name": "CHU de Rennes", "id": "<uuid>", "country": "FR",
                   "referenceId": "https://ror.org/02vjkv261" },
  "badges": ["icu", "omop"],
  "license": "AGPL-3.0",
  "linkrVersion": ">=2.2.0",
  "createdAt": "2026-08-01", "updatedAt": "2026-08-04"
}
```

- `type` ∈ the 7 clone-capable scopes already in `GitLinkedEntity['type']`:
  `project | mapping-project | sql-collection | etl-pipeline | data-catalog |
  dq-rule-set | schema-preset`. Reusing that union verbatim means the install button can
  hand straight off to `applyClonedEntity` with no mapping layer.
- `name`/`description` are `LocalizedString` — same type as entities, so `localized()`
  renders them with the existing FR/EN fallback.
- `author`/`organization` mirror `AuthorDetails`/`OrganizationInfo` (ORCID + org UUID +
  ROR), which is what the provenance work was built for.
- `updatedAt` is **the entry's**, not the repo's — a repo can move without the card
  claiming to be updated.

Deliberately *not* in an entry: stars, downloads, install counts. Nothing in this design
can count them (no server, no telemetry), and a permanently-zero counter is worse than
none.

## 3. Hashing + CI — "do I need a build.sh?"

Yes, but it's ~40 lines of Node, and CI runs it so contributors never do.

`scripts/build.mjs`:
1. Read every `entries/*.json`, validate against `schema/entry.schema.json`.
2. Reject duplicate `id`s and duplicate `git.url`s (the two things that break the app).
3. Per entry: `hash = sha256(canonicalJson(entry)).slice(0,16)` — key-sorted before
   hashing, exactly like `plugin-hash.ts`'s `sortKeys`, so key reordering in a PR is not
   a "change".
4. `contentHash = sha256(entries.map(e => id + ':' + hash).sort().join('\n')).slice(0,16)`.
5. Write `catalog.json` + `catalog-index.json`, entries sorted by `id` (deterministic
   diffs — same discipline as `git-links.json`).

`.gitlab-ci.yml`, two jobs:

- **`validate`** (on merge requests): runs the build and `git diff --exit-code`. Fails if
  the entry is invalid *or* if the committed built files don't match. This gives the
  contributor a red pipeline with a real error message instead of a maintainer
  discovering a bad entry after merge.
- **`build`** (on `main`): re-runs the build and, if the output changed, commits it back
  with `[skip ci]` via a project access token.

`generatedAt` must come from the **last commit date** (`git log -1 --format=%cI`), not
`new Date()` — otherwise every CI run rewrites the file and the app reports a fake
update. This is the one non-obvious trap in the whole build.

The alternative — a GitLab Pages job serving the built files — is not needed: the API
route below already serves raw files with CORS, and Pages would add a deploy step and a
second URL to keep straight.

## 4. How the app reads it — the CORS finding

**Measured on framagit, 2026-08-04** (this decides the architecture):

| Route | `access-control-allow-origin` | Rate limit |
|---|---|---|
| `/interhop/linkr/linkr-catalog/-/raw/main/catalog.json` | *absent* | 60/min |
| `/api/v4/projects/<url-encoded-path>/repository/files/catalog.json/raw?ref=main` | `*` | 500/min |

So the app fetches via the **GitLab API v4 route**, and the catalog then works in **both**
deployment modes — including static/WASM — with **no backend endpoint and no CORS proxy**.
That matters because the in-browser CORS-proxy clone was deliberately dropped from this
codebase ("too fragile for too little value", `import-source-dialog.tsx:52`); this
reintroduces nothing — it's a plain `fetch` of a public file on an API that advertises
`allow-origin: *`, the same pattern `ImportConceptSetDialog.tsx` already uses against
GitHub for INDICATE concept sets.

The split that follows:

- **Browsing the catalog** — works everywhere (static WASM included). Read-only fetch.
- **Installing an entry** — needs `gitCloneToZip` → backend, so it stays
  `isServerMode()`-gated, reusing the existing `<ServerModeNotice />`. In WASM mode the
  card still shows everything and offers "Open repository" instead of "Install".

Constants (both files served from one repo path, so one base):

```ts
const CATALOG_PROJECT = 'interhop/linkr/linkr-catalog'
const CATALOG_BASE =
  `https://framagit.org/api/v4/projects/${encodeURIComponent(CATALOG_PROJECT)}/repository/files`
const fileUrl = (f: string) => `${CATALOG_BASE}/${encodeURIComponent(f)}/raw?ref=main`
```

Overridable in Settings so a hospital can point at its own internal catalog repo — the
whole mechanism is host-agnostic (any GitLab; GitHub needs a different URL builder, worth
adding only when someone asks).

## 5. App-side pieces

| Piece | Path | Note |
|---|---|---|
| Types | `lib/catalog/types.ts` | `CatalogEntry`, `CatalogIndex`, `CatalogFile`. **Not** `types/catalog.ts` — that's the DCAT-AP `DataCatalog`, an unrelated feature. |
| Fetch + diff | `lib/catalog/remote.ts` | `fetchCatalogIndex()`, `fetchCatalog()`, `diffCatalog(local, remote)`. Returns `null` on failure, like `fetchSeedHashes()`. Pure → unit-testable. |
| Cache | `lib/catalog/cache.ts` | localStorage under `linkr-catalog-cache`, `{fetchedAt, contentHash, entries}`. **Not** IndexedDB: no `DB_VERSION` bump for a re-downloadable cache. |
| Hook | `hooks/use-catalog.ts` | `{entries, loading, error, lastFetchedAt, updateAvailable, load, refresh}`. Matches the repo's `use-*` convention (TanStack Query is a dependency but unused anywhere — not introducing it here). |
| Page | `features/catalog/CatalogPage.tsx` | Replace the stub. |
| Card | `features/catalog/CatalogEntryCard.tsx` | + `CatalogInstallDialog.tsx` |

Naming caution for whoever picks this up: `catalog` (this, marketplace) vs `data_catalog`
/ `useCatalogStore` (DCAT-AP, `features/warehouse/catalog/`) are different features that
already coexist. Keep the new code under `lib/catalog/` + `features/catalog/`.

### UX flow (matches what you described)

1. **Never loaded** — empty state, one "Load catalog" button. Nothing is fetched at boot;
   the catalog is opt-in, so a fresh install makes zero external requests until asked.
   (Worth stating in the privacy/docs page: browsing the catalog contacts framagit.)
2. **Loaded** — card grid + `ListPageToolbar` (search + filters + sort), reusing the
   `WorkspacesPage` layout: search over name/description/author/org, filters on
   `type` / `badges` / `organization`, sort by name/updatedAt. Footer line:
   *"Updated 2 days ago"* from `lastFetchedAt`.
3. **Update check** — on page mount fetch only `catalog-index.json` (~3 KB) and compare
   `contentHash` to the cached one. If different, an inline button appears next to the
   date: *"Updates available (3 new, 1 updated) — Refresh"*. Never auto-applies.
4. **Install** — server mode: `gitCloneToZip(url, branch)` → create the local entity →
   `applyClonedEntity(zip, type, id, storage, workspaceId, gitRemoteConfig)`. Asks for
   the target workspace. The installed entity lands git-linked, so Versioning can pull
   later updates through the existing path — no new sync machinery.
5. **Already installed** — match cached entries against local entities by `lineageId`
   (falling back to `git.url`) and badge the card "Installed", so re-installing is a
   conscious act.

## 5b. Bulk scanning a group / account — built, `scripts/scan.mjs`

Verified against the live APIs (2026-08-04), unauthenticated:

| Target | Route | Works |
|---|---|---|
| GitLab group + subgroups | `/api/v4/groups/<enc>/projects?include_subgroups=true` | ✓ (500 req/min) |
| GitHub org | `/orgs/<o>/repos` | ✓ (60 req/h unauth → token for big orgs) |
| GitHub user | `/users/<u>/repos` (fallback when the org 404s) | ✓ |

**No AI/skill is needed for this** — detection is mechanical. Every Linkr export writes a
uniquely-named metadata file at the repo root, and that file already contains the name,
description, author (+ORCID) and organization (+UUID):

| Root file | Type |
|---|---|
| `_collection.json` | `sql-collection` |
| `_pipeline.json` | `etl-pipeline` |
| `_project.json` | `mapping-project` |
| `project.json` | `project` |
| `catalog.json` | `data-catalog` |
| `rule-set.json` | `dq-rule-set` |
| `preset.json` | `schema-preset` |

Checked in that order — `_project.json` before `project.json`, so the more specific
mapping-project marker wins. The list mirrors the builders in `entity-io.ts`; changing an
exporter's root filename means updating `MARKERS` in `scan.mjs`.

A re-scan never overwrites an existing entry without `--force`, so hand-added FR
translations, badges and `status` survive. What the scanner *can't* do — and why the
drafts need review — is invent a translation, choose meaningful badges, or know a
collection is WIP.

## 6. Submission flow (for the README)

1. Publish your entity to a public git repo (Versioning → push).
2. Fork `linkr-catalog`, add `entries/<your-slug>.json`, open an MR.
3. CI validates the schema; a maintainer merges; CI rebuilds `catalog.json`.
4. Users see it on their next catalog refresh.

An "Propose to catalog" action in the app that pre-fills the entry JSON (from the
entity's existing name/description/author/org fields) and deep-links to the MR form would
remove most of the friction here — worth doing right after the browse side works, since
every field it needs is already on the entity.

## 7. Steps

| St | Item | Effort |
|----|------|--------|
| ✅ | `linkr-catalog` repo built (`../linkr-catalog`, remote `interhop/linkr/linkr-catalog`): entries/, schema, `build.mjs`, `scan.mjs`, CI, README, CLAUDE.md, first entry `icu-omop-scripts`. **Not pushed yet.** | S |
| 🔜 | `lib/catalog/` types + `remote.ts` + `cache.ts` (+ unit tests for the diff/canonical-hash — pure logic, so per the tests rule) | S |
| 🔜 | `use-catalog.ts` + rewrite `CatalogPage.tsx` (grid, toolbar, load/refresh, i18n both locales) | M |
| 🔜 | Install dialog: workspace picker → clone → `applyClonedEntity`; server-mode gate | M |
| 💤 | "Propose to catalog" prefill + MR deep-link | S |
| 💤 | Installed-state detection by `lineageId` | S |
| 💤 | Custom catalog URL in Settings (self-hosted / internal catalogs) | S |
| 💤 | Doc page in `linkr-website` (`docs/catalog/`) — user-facing submission guide | S |

## 8. Open decisions

- **Moderation bar** — what a maintainer checks before merging (repo reachable? license
  present? content actually loads?). Affects whether CI should also try cloning the
  entry's repo.
- **Dead entries** — a linked repo can vanish. Options: a CI cron that pings each
  `git.url` and marks `"status": "unreachable"`, or leave it to a failed install. The
  cron is cheap (one HEAD per entry) and keeps the catalog honest.
- **Whether `linkrVersion` gates install** or is display-only (recommend display-only
  first; hard-gating needs a semver range check and an escape hatch).
