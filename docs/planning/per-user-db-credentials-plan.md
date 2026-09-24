# Per-user database credentials — plan

**Status: to arbitrate (2026-09-24). Nothing built.**

Today one password per database, shared by everyone who can read it. The target: each
user connects to an external database (Postgres, MySQL…) **with their own account**, so
the database's own grants and audit apply to the person, not to Linkr. A shared service
account stays possible, but as an explicit, visible choice. File-based databases are a
different problem (§8): Linkr cannot be the one enforcing file permissions.

---

## 1. As built

| Piece | Where | Behaviour |
|---|---|---|
| Secret storage | `DataSource.connection_secret` ([data_source.py:33](../../apps/api/app/models/data_source.py#L33)) | Fernet-encrypted (`core/crypto.py`, key `LINKR_SECRET_KEY`), never returned by the API. `password`/`token` are stripped from `connection_config` on create/update (`_SECRET_KEYS`, `strip_secrets`, `_extract_secret` in [data_source_service.py](../../apps/api/app/services/data_source_service.py)). The **username stays in `connection_config`**, so it is shared too. |
| Scope | `DataSource.workspace_id` | A database belongs to a workspace; everyone with `databases:read` there queries it **with the one stored account**. |
| Single choke point | `connection_password(source)` ([data_source_service.py:183](../../apps/api/app/services/data_source_service.py#L183)) | Called by `query`, `introspect`, `refresh_concept_cache`, `role_attachments` (ETL, derive), `client_recipe` (R/Python client libs), `test_connection` and the derive target ([cohort_derive_service.py:54](../../apps/api/app/services/cohort_derive_service.py#L54)). None of them receives the acting user. |
| Warm connections | `connection_pool.run_pooled(pool_key, …)` ([connection_pool.py:77](../../apps/api/app/services/data/connection_pool.py#L77)) | Keyed by **`source.id`**: one ATTACHed connection per database, shared by all users. |
| Derived caches | `StatsCache` (scope `database`, key = source id), `ConceptStatsCache` (per `data_source_id`), the concept Parquet cache (`concept_cache_fs`, per source id) | Computed once, served to everyone who can read the database. |
| IDE connections | `IdeConnection.connection_secret` ([ide_connection.py](../../apps/api/app/models/ide_connection.py)) | Per **project**, same shared-secret pattern. |
| Precedent | `GitCredential` ([git_credential.py](../../apps/api/app/models/git_credential.py)) | Already **per (user, host)**: "one user can never push with another's token". The model to follow. |

Consequences: the database sees one login for every Linkr user (its audit log is
useless), its grants cannot differ per person, and a user who can read a database in
Linkr uses an account they were never given.

## 2. Target model

### 2a. Two authentication modes per database

`DataSource.credential_mode`:

- **`personal`** — default for new external databases. Each user stores their own
  username + password for this database. No stored account = no access, even with
  `databases:read`: Linkr asks for it on first use.
- **`shared`** — a service account, set by someone with `databases:manage`. Behaves as
  today, but is **shown** as such (badge "shared account" on the database, and in its
  settings who set it and when). Meant for read-only demo or aggregate-only databases.

`databases:read` still decides whether Linkr lets you *try*; the database decides what
you *get*. Both must say yes.

### 2b. `DatabaseCredential` (new table)

```
database_credentials
  id            pk
  user_id       fk users (cascade)
  data_source_id fk data_sources (cascade)
  username      text
  secret        text        -- Fernet, never returned
  created_at, updated_at, last_used_at
  unique (user_id, data_source_id)
```

Keyed by (user, database), not by host: two databases on one server often need two
accounts, and a per-host key would silently reuse the wrong one. (GitCredential is
per host because a PAT is host-scoped; a DB login is not.)

The `shared` mode keeps using `DataSource.connection_secret` + the username in
`connection_config`; in `personal` mode both are empty and `connection_config` holds
only host / port / database / schema / sslmode.

### 2c. One resolver replaces `connection_password`

```python
async def resolve_login(db, source, user) -> Login   # (username, password, principal)
```

- `shared` → the stored service account, `principal = "shared"`.
- `personal` → the user's `DatabaseCredential`, `principal = f"user:{user.id}"`;
  none → raise `CredentialRequired(source.id)`, surfaced as **HTTP 428** with a
  machine-readable code so the front opens the credential dialog (§6) instead of
  showing an error.

Every caller in §1 takes the acting user and goes through it. `connection_password`
disappears, so a forgotten call site fails to compile rather than silently using a
shared secret.

## 3. Connections and caches

- **Pool key** becomes `f"{source.id}:{principal}"` — two users never share an
  ATTACHed connection. Updating or deleting a credential closes that principal's warm
  connection (same hook as today's config change, [data_source_service.py:267](../../apps/api/app/services/data_source_service.py#L267)).
  Cap warm connections per user (the pool's idle sweep already bounds lifetime).
- **Caches.** Stats, concept counts and the concept list are computed *through an
  account*; with per-user grants, serving one user's result to another leaks what the
  second may not see (a count over a table they have no grant on). Rule: in `personal`
  mode every cache derived from the database is keyed by principal
  (`StatsCache.cache_key`, `ConceptStatsCache`, concept Parquet directory). Cost: one
  copy per user who opens the database — a handful in practice. Schema introspection
  follows the same rule (grants hide tables).
  `shared` mode keeps one cache, as today.

## 4. Jobs and long operations

A job stores its launcher (`Job.user_id` already exists). It resolves the launcher's
login **when it runs**, never copies the secret into the job row or its log. A
credential revoked mid-run makes the next connection fail; the job fails with that
reason. Concerned today: cohort derivation (source and external target), ETL runs
(`role_attachments`), concept-cache refresh.

## 5. Code, the IDE and agents — where a password can escape

- **`client_recipe`** hands the decrypted password to the R/Python process so the
  script can ATTACH itself ([data_source_service.py:803](../../apps/api/app/services/data_source_service.py#L803)).
  With personal credentials that is the *user's own* password, in a kernel the user
  owns (`ExecutionSession.user_id`) — acceptable for a human. It is **not** for an
  agent: the MCP's `run_code` executes in that kernel, and a script can print the
  recipe, which then goes to the model — to a third party with a remote model.
  Options, to decide:
  1. **Server-side proxy** — the kernel gets a short-lived, single-database token and
     queries through Linkr's API (Arrow stream); no password leaves the server. Most
     robust, costs the direct DBI handle (dbplyr on the remote DB).
  2. **Recipe refused under an API key** — sessions driven through the MCP cannot fetch
     a recipe with a password; humans in the IDE still can.
  3. Keep as is and document it.
  Recommendation: 2 now (small, closes the agent path), 1 when the proxy exists for
  other reasons.
- **`IdeConnection`** gets the same split: connection settings per project, login per
  user (reuse `DatabaseCredential` when the IDE connection points at a Linkr database —
  `IdeConnection.data_source_id` — and a per-user secret otherwise).

## 6. UI

- **Database settings** (`databases:manage`): "Authentication" — *Personal accounts
  (recommended)* / *Shared service account*, with the username + password fields only
  in the shared case, and a warning that everyone who can read the database will use
  that account.
- **First use in personal mode**: the 428 opens a dialog "Your account for
  «database»" — username, password, **Test connection**, save. Same dialog from the
  database's menu to change or forget it.
- **User settings → Database accounts** (new tab, beside API keys): the user's stored
  logins — database, username, last used — with *Change* and *Forget*.
- The MCP relays the 428 as a plain message ("ask the user to enter their account for
  this database in Linkr"); an agent never receives or sets a password.

## 7. Export, import, versioning

Unchanged principle: no secret is ever exported. A database export carries
`credential_mode` and the non-secret settings; after import, `personal` asks each user
on first use, `shared` asks the manager to enter the service account.

## 8. File-based databases (DuckDB, SQLite, Parquet folders)

These have no login. Linkr's server process opens them with **its own OS identity**,
so it cannot apply per-user file permissions: whatever the process can read, it can
serve to anyone Linkr lets through. Access to the *files* must therefore be decided by
whoever manages the storage, and Linkr's part is to not widen it:

- **Now**: browse roots per workspace (today one global `fs_browse_roots`,
  [fs_browser.py:23](../../apps/api/app/services/fs_browser.py#L23)) — a workspace can
  only register files under the folders its admin mounted for it; registering a
  `serverPath` database needs `databases:manage`. The storage admin mounts, per
  workspace, only what its members may read.
- **Later, if a site needs real per-user file ACLs**: run the user's queries and
  kernels in a worker spawned under the user's own OS account (JupyterHub-style
  spawner). A large change, out of scope here; recorded so the per-workspace roots do
  not pretend to be more than they are.

Uploaded files (blob store) stay Linkr-level: governed by workspace/project
permissions, as today.

## 9. Migration

- Existing external databases become `shared` — nothing breaks, nothing silently
  changes whose account is used. They show the "shared account" badge, and their
  settings offer *Switch to personal accounts*.
- Switching deletes the stored service password, closes the warm connection and drops
  the shared caches; each user is asked for their account on next use.
- `test_connection` for a draft config (before save) keeps taking the typed password.

## 10. Steps

| St | Item | Effort |
|----|------|--------|
| 🤔 | Arbitrate: default mode for new databases; per-principal caches (§3); recipe policy under API keys (§5) | S |
| 🔜 | 1. `DatabaseCredential` model + migration; `credential_mode` column (existing → `shared`) | S |
| 🔜 | 2. `resolve_login` + `CredentialRequired` (428); thread the acting user through every §1 caller; delete `connection_password` | M |
| 🔜 | 3. Pool key per principal + invalidation on credential change | S |
| 🔜 | 4. Caches keyed per principal in `personal` mode (stats, concept stats, concept Parquet, introspection) | M |
| 🔜 | 5. Routes: my credential for a database (put / test / delete), list mine; `databases:manage` sets the mode | S |
| 🔜 | 6. Front: credential dialog on 428, database settings mode, *Database accounts* tab | M |
| 🔜 | 7. Jobs resolve the launcher's login at run time (derive, ETL, concept refresh) | S |
| 🔜 | 8. `client_recipe` refused for API-key sessions; IDE connections split settings / login | S |
| 🔜 | 9. Per-workspace browse roots; `serverPath` registration behind `databases:manage` | M |
| 🔜 | 10. MCP: relay the 428 as a readable message; tests; `docs/architecture.md`; user docs (databases page, new settings tab) | S |
| 💤 | Per-user OS identity for file access (spawner) | L |

## 11. Open questions

- **Default for new databases**: `personal` (recommended — safe by default) or ask at
  creation?
- **Caches**: accept one copy per user (recommended), or allow a manager to mark a
  `personal` database's statistics as shareable (computed with a dedicated stats
  account)?
- **Recipe under an API key** (§5): refuse (recommended) or proxy first?
- **Kerberos / LDAP / OAuth logins** for hospital databases: not covered; the resolver
  (§2c) is where a future SSO pass-through would plug in.
