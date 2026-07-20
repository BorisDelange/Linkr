# Settings versioning (organizations / users / roles)

Version account-level configuration — organizations, users, roles — to a git repo,
so a fresh instance can re-import it instead of re-typing affiliations, professions,
ORCID, role permissions, etc. by hand.

**Never export passwords.** A user re-imported without a password hash lands
**disabled** (`is_active = false`) and must be given a password (and re-enabled)
before they can log in.

## Decisions (validated with the user)

- **UI**: one **global "Versioning" tab** in Settings (not a sub-tab per entity).
  Checkboxes pick what's included: Organizations / Users / Roles. One git repo,
  one token config (reuses the per-(user, host) token work already shipped).
- **Content of the first versioned ZIP**: Organizations + Users (no passwords) + Roles.
- **Conflict policy on import**: **upsert by stable identity** — `username` for users,
  `name` for roles, UUID/`lineageId` for organizations. Updating an existing record
  must NOT touch its `password_hash` and must NOT disable an already-active account.
- **Import location**: **both flows (pull-from-git AND upload-a-ZIP) live in the global
  Versioning tab.** The Organizations/Users/Roles checkboxes filter import as well as
  export (import only what's checked AND present in the ZIP). The Organizations/Users/Roles
  tabs stay pure CRUD (Users additionally gets the enable/disable toggle) — no Import button
  scattered across them.
- **Front-only (WASM)**: NOT supported for v1. The Versioning tab is server-mode only
  (hidden when `!isServerMode()`). Server BUILDS the ZIP; the file-upload import path is
  also server-mode only.
- `_active_admin_count`: confirmed to guard disabling as well (item 3 — OK per user).

## État actuel

DONE (2026-07-20). Shipped design differs from the first sketch in one way: rather
than export-time include checkboxes, `settings` is a first-class `GitScope` (id
`account`) that reuses the SAME versioning UI as every other scope —
`GitRepositoryTab` + `GitSyncPanel`. The server always builds the full 3-file tree
(organizations/users/roles); "what to version" is expressed as **quick actions**
(Sync all / organizations / users / roles) and per-file selection in the panel,
exactly like workspace versioning. Import (pull-from-remote + upload-ZIP) is a
small settings-specific block below the shared panel.

Sections below are the original design notes; the checkbox-selection parts are
superseded by the quick-actions approach.

Confirmed groundwork already in place:
- `User.is_active` column + `UserUpdate.is_active` (PATCH `/users/{id}` accepts it). ✅
- `User.password_hash` is nullable (LDAP/SSO readiness) — a hash-less user is valid. ✅
- `user_service.update` exists; `_active_admin_count` guards against disabling the last admin. ✅ (verify it also guards is_active flips, not just role/delete)
- Generic git repo layout `data_path/<kind>/<id>/versioning` via `entity_repo_getter(kind, id)`
  (git_service.py:141). A new scope needs no new plumbing beyond a getter + routes. ✅
- Per-(user, host) git token (`git_credentials`, `/git/host-token`). ✅
- `GitRepositoryTab` + `GitSyncPanel` are entity-agnostic (take a scope + id). ✅
- `stripInstanceFields` already drops createdAt/updatedAt/ownerId/etc. ✅

## Export ZIP layout

Scope id is fixed: **`account`** (single per-instance settings repo).
`data_path/settings/account/versioning/` on the server.

```
settings/
  organizations.json   # array; stripInstanceFields (keep id/lineageId/name/...); already the shipped format
  users.json           # array; NO password_hash, NO auth secrets
  roles.json           # array; name/label/scope/permissions/isSystem
```

- The three files are written **only if their checkbox is selected**. An unchecked
  entity is omitted from the tree so it neither pushes nor shows as a deletion diff
  — mirror how workspace export omits absent sections.
- Deterministic ordering (sort users by username, roles by name, orgs by id) so the
  git diff is stable across exports — same rule as other exports.

### users.json — exact field set

Export: `username, email, firstName, lastName, affiliation, profession, orcid, role`.
Omit: `passwordHash, id, authProvider, externalId, lastLogin, preferences, createdAt,
updatedAt, isActive`.

Rationale for omitting `isActive`: the disabled-on-import rule is derived from
"no password present", not carried in the file — so importing onto an instance where
the account is already active + has a password doesn't flip it off.

## Import semantics

For each selected file, upsert by stable identity:

- **organizations.json**: upsert by UUID / lineageId (reuse existing org upsert path —
  the same one workspace import uses; already re-stamps createdAt/updatedAt).
- **roles.json**: upsert by `name`. System roles (`isSystem`) match by name and only
  their `permissions`/`label` update — never create a duplicate, never flip `isSystem`.
- **users.json**: upsert by `username`.
  - **New user** (username not found): create with the imported fields, `password_hash = null`,
    `is_active = false`. Must appear in the Users tab as a disabled account awaiting a password.
  - **Existing user**: update profile fields (email/name/affiliation/profession/orcid/role).
    Do **not** touch `password_hash`. Do **not** change `is_active` (leave an active account active).

Edge cases:
- Importing a user whose `role` references a role name absent from both the ZIP and the
  instance → fall back to `"user"` and log a warning surfaced in the import report.
- Never import/replace the **currently acting admin**'s own account in a way that could
  lock them out (skip self, or skip if it would drop the last active admin — reuse
  `_active_admin_count`).

## "Disable account" function (standalone, also used by import)

- Backend: already doable via `PATCH /users/{id}` with `{isActive: false}`. Add a guard
  in `user_service.update` (if not already there) refusing to disable the last active admin.
- UI: in `UsersTab`, per-row ⋯ menu → **Activer / Désactiver** toggle. A disabled account
  shows a muted "Disabled" badge and cannot log in (auth already checks `is_active` in
  `deps.py` / `ws_auth.py` — verify the login path returns a clear error).
- i18n keys: `settings.user_enable`, `settings.user_disable`, `settings.user_disabled_badge`,
  and a confirm dialog for disabling.

## Server scope wiring

Add a **`settings` git scope** mirroring the mapping-project scope (server BUILDS the ZIP,
no browser upload needed):

- `git_service.settings_repo_getter()` → `entity_repo_getter("settings", "account")`.
- Routes under `/git/settings/...`: `status`, `diff`, `branches`, `commit-push`,
  `sync-state`, `pull-preview`, `pull-file`, `set-sync-state` — same shapes as
  mapping-projects. Guard with a **global** permission (settings:manage or admin),
  NOT a workspace membership check.
- `settings_export_assemble.py`: builds the ZIP from selected entities (query flags
  `include_orgs/users/roles` passed on the status/commit body).
- gitRemoteConfig for the settings repo: store where? Options —
  (a) a tiny `settings` singleton row, or (b) app-config table. Pick (a): one row keyed
  `account`, columns `git_remote_config` (JSON, token stripped) + reuse per-user host token.
- Sync-state: `git_sync_state` already keyed by (scope, entity_id, branch) → use
  `("settings", "account", branch)`. No schema change.

## Client wiring

- New `SettingsVersioningTab.tsx`: renders `GitRepositoryTab` (repo url/branch/token) +
  `GitSyncPanel` for scope `settings`/id `account`, plus a checkbox group
  (Organizations / Users / Roles) whose state is passed to status/commit calls.
- `entity-io.ts`: `buildSettingsZip({ orgs, users, roles }, selection, storage)` and
  `applySettingsImport(zip, storage)` (front-only/WASM path). Server path builds the ZIP
  itself; the client just triggers status/commit like mapping-projects.
- api-storage / idb-storage: expose `users.list()`, `roles.list()`, `organizations.list()`
  (org list already exists) for the front-only export path.
- Settings page: add `<TabsTrigger value="versioning">` gated on the same permission as
  the export op.

## i18n

Both `en.json` and `fr.json`:
- `settings.tab_versioning`, `settings.versioning_title`, `settings.versioning_intro`
- `settings.versioning_include_orgs/users/roles`
- `settings.versioning_no_passwords_notice` (explain hash-less → disabled)
- user enable/disable keys (above)
- import report strings (created disabled, updated, skipped-self, unknown-role-fallback)

## Tests

Pure/critical logic — add/update in the same change:
- `entity-io` (or a new `settings-io.test.ts`): export omits password_hash; omits unchecked
  entities; deterministic ordering.
- Import: new user → disabled + no hash; existing user → profile updated, hash & is_active
  untouched; unknown role → fallback; self/last-admin skip.
- Backend `test_settings_export_assemble.py`: selection flags produce the right file set.
- Backend `test_git_routes.py`: `/git/settings/*` mounted, gated on global perm, status on a
  bare repo reports the built tree as added.
- Do NOT unit-test the volatile tab UI.

## Rollout / migration

- Alembic: a `settings` singleton table (or reuse an existing app-config table if one exists —
  check before adding). No destructive change to users/roles/orgs.
- User has said they'll reset the DB when needed — no data-migration compat layer required
  (matches the "no complex backcompat" preference).

## Open questions to resolve during implementation

1. Where to store the settings repo's `git_remote_config` — confirm no app-config/singleton
   table already exists before adding one.
2. Confirm `_active_admin_count` already blocks disabling (not just deleting/demoting) the
   last admin; if not, extend it.
3. Front-only (WASM) mode: is settings versioning offered there at all, or server-mode only?
   (Git push in WASM uses the in-browser clone + CORS proxy — feasible, but the account/users
   store in WASM is IndexedDB. Decide: probably server-mode-only for v1, hide the tab in WASM.)
