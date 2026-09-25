# Per-user database credentials — plan

**Status: steps 1–10 and 13a built (2026-09-25, branch `feature/per-user-db-credentials`); 11–12 open. As-built: `docs/architecture.md` § Database logins, § Access log.**

Today one password per database, shared by everyone who can read it. The target: each
user connects to an external database (Postgres, MySQL…) **with their own account,
and only that way** — no shared service account — so the database's own grants and
audit apply to the person, not to Linkr. Linkr adds its own access log on top, so
"who read what, when" is answerable from either side. File-based databases are a
different problem (§9): Linkr cannot be the one enforcing file permissions.

Decisions (2026-09-25):

- **Personal accounts only.** No `shared` mode, no badge, no per-database switch.
  Same model as Dataiku's *per-user credentials* connections, without its global
  fallback.
- **Caches per user** (one copy per user who opens a database).
- **`client_recipe` refused to API-key sessions** (agents); proxy later.
- **Secrets bound to their context** (AES-GCM, §2d) and **dropped when the target
  changes** (§2e).
- **Access log** in the app (§6) — log files (JSONL → Parquet), not a DB table — plus
  the Linkr user stamped on each session to the external database (§4).
- **No new dependency**: everything below uses `cryptography` (already installed) and
  the standard library (+ `structlog` and DuckDB, already there). Kerberos is dropped.

---

## 1. As built

| Piece | Where | Behaviour |
|---|---|---|
| Secret storage | `DataSource.connection_secret` ([data_source.py:33](../../apps/api/app/models/data_source.py#L33)) | Fernet-encrypted (`core/crypto.py`), never returned by the API. `password`/`token` are stripped from `connection_config` on create/update (`_SECRET_KEYS`, `strip_secrets`, `_extract_secret` in [data_source_service.py](../../apps/api/app/services/data_source_service.py)). The **username stays in `connection_config`**, so it is shared too. |
| Encryption key | [crypto.py](../../apps/api/app/core/crypto.py) | Derived from `settings.secret_key` — **the same secret that signs JWTs**. One leak = forged sessions *and* decrypted passwords; rotating the JWT secret silently makes every stored password undecryptable (`decrypt` returns `None`). |
| Scope | `DataSource.workspace_id` | A database belongs to a workspace; everyone with `databases:read` there queries it **with the one stored account**. |
| Single choke point | `connection_password(source)` ([data_source_service.py:183](../../apps/api/app/services/data_source_service.py#L183)) | Called by `query`, `introspect`, `refresh_concept_cache`, `role_attachments` (ETL, derive), `client_recipe` (R/Python client libs), `test_connection` and the derive target ([cohort_derive_service.py:54](../../apps/api/app/services/cohort_derive_service.py#L54)). None of them receives the acting user. |
| Warm connections | `connection_pool.run_pooled(pool_key, …)` ([connection_pool.py:77](../../apps/api/app/services/data/connection_pool.py#L77)) | Keyed by **`source.id`**: one ATTACHed connection per database, shared by all users. |
| Derived caches | `StatsCache` (scope `database`, key = source id), `ConceptStatsCache` (per `data_source_id`), the concept Parquet cache (`concept_cache_fs`, per source id) | Computed once, served to everyone who can read the database. |
| IDE connections | `IdeConnection.connection_secret` ([ide_connection.py](../../apps/api/app/models/ide_connection.py)) | Per **project**, same shared-secret pattern. |
| Access log | — | **None.** Nothing records who queried which database; the database itself sees one login. |
| Precedent | `GitCredential` ([git_credential.py](../../apps/api/app/models/git_credential.py)) | Already **per (user, host)**: "one user can never push with another's token". The model to follow. |

Consequences: the database sees one login for every Linkr user (its audit log is
useless), its grants cannot differ per person, a user who can read a database in
Linkr uses an account they were never given, and Linkr cannot say either who ran what.

## 2. Target model

### 2a. Personal accounts only

Each user stores their own username + password for each external database they use.
No stored account = no access, even with `databases:read`: Linkr asks for it on first
use. `databases:read` decides whether Linkr lets you *try*; the database decides what
you *get*. Both must say yes.

`DataSource.connection_config` holds only host / port / database / schema / sslmode —
never a username or a password. `DataSource.connection_secret` is dropped.

A site that wants several people to use one technical account can still do it — each
of them types that account in their own credential — but Linkr never distributes it
on their behalf, and the access log (§6) still names the person.

### 2b. `DatabaseCredential` (new table)

```
database_credentials
  id             pk
  user_id        fk users (cascade)
  data_source_id fk data_sources (cascade)
  username       text
  secret         text        -- AES-GCM (§2d), never returned
  created_at, updated_at, last_used_at
  unique (user_id, data_source_id)
```

Keyed by (user, database), not by host: two databases on one server often need two
accounts, and a per-host key would silently reuse the wrong one. (GitCredential is
per host because a PAT is host-scoped; a DB login is not.)

### 2c. One resolver replaces `connection_password`

```python
async def resolve_login(db, source, user) -> Login   # (username, password, principal)
```

Returns the user's credential, `principal = f"user:{user.id}"`; none → raise
`CredentialRequired(source.id)`, surfaced as **HTTP 428** with a machine-readable code
so the front opens the credential dialog (§7) instead of showing an error.

Every caller in §1 takes the acting user and goes through it. `connection_password`
disappears, so a forgotten call site fails to compile rather than silently using
someone else's secret.

### 2d. Encryption: separate key, secret bound to its context

- **Own key.** A dedicated 32-byte key, read from `LINKR_ENCRYPTION_KEY` if set, else
  generated on first boot into `data_dir/secret.key` (mode 0600). Never derived from
  the JWT secret, never stored in the Linkr database — a dump or backup of the DB alone
  decrypts nothing. Key id stored with each ciphertext so a rotation can re-encrypt
  lazily (old key kept read-only until every row is rewritten).
- **AES-GCM with associated data** (`cryptography.hazmat.primitives.ciphers.aead.AESGCM`,
  already installed) instead of Fernet. The associated data is
  `(user_id, data_source_id, host, port, database)`: it is not encrypted, but
  decryption fails if it differs. A ciphertext copied into another user's row, or
  replayed after the database's target changed, no longer decrypts.
- Same helper for `GitCredential` and IDE connection secrets; the existing Fernet
  values are re-encrypted by the migration.

### 2e. Changing the target drops the credentials

Editing host, port, database or sslmode of a database **deletes every
`DatabaseCredential` on it** (and closes their warm connections). Otherwise someone
with `databases:manage` could point a database at a server they control and collect
each user's password at their next query. §2d makes the old ciphertexts undecryptable
anyway; deleting them makes it explicit and lets the UI ask again. The settings dialog
warns before saving ("N users will have to re-enter their account").

`sslmode` defaults to `verify-full` for new Postgres databases.

### 2f. "Don't remember" — session-only secret

The credential dialog has a *Remember this password* checkbox (on by default). Off:
the password lives only in server memory, attached to the user's login session, and is
forgotten on logout, expiry or server restart — nothing to find in the database or its
backups. Costs: re-typing after a restart, and a scheduled/background job cannot run
with it (§5). Intended for databases whose login is the user's hospital (LDAP/AD)
password, where storing it would mean storing a domain password; a manager can make
it mandatory per database (`DataSource.require_session_only`).

## 3. Connections and caches

- **Pool key** becomes `f"{source.id}:{principal}"` — two users never share an
  ATTACHed connection. Updating or deleting a credential closes that principal's warm
  connection (same hook as today's config change, [data_source_service.py:267](../../apps/api/app/services/data_source_service.py#L267)).
  Cap warm connections per user (the pool's idle sweep already bounds lifetime).
- **Caches.** Stats, concept counts and the concept list are computed *through an
  account*; with per-user grants, serving one user's result to another leaks what the
  second may not see. Every cache derived from an external database is keyed by
  principal (`StatsCache.cache_key`, `ConceptStatsCache`, concept Parquet directory),
  schema introspection included (grants hide tables). Cost: one copy per user who
  opens the database — a handful in practice.

## 4. Stamping the Linkr user on the external database session

This is about the **external databases users query** (a hospital's OMOP Postgres…),
not Linkr's own database (SQLite by default). Each connection sets `application_name = 'linkr:<username>'` (Postgres; MySQL
`program_name` connection attribute). With personal accounts the database's own log
already names the person; this adds that the query came through Linkr, which makes
`pg_stat_activity` and `pgaudit` output directly readable by the site's DBA.

## 5. Jobs and long operations

A job stores its launcher (`Job.user_id` already exists). It resolves the launcher's
login **when it runs**, never copies the secret into the job row or its log. A
credential revoked mid-run makes the next connection fail; the job fails with that
reason. A session-only credential (§2f) is usable only while the launcher's session is
alive; a job started from it fails cleanly if the session ended. Concerned today:
cohort derivation (source and external target), ETL runs (`role_attachments`),
concept-cache refresh.

## 6. Access log

Who ran what, on which database, when, from where (browser, agent, job), with what
outcome — the traceability a DPO / CNIL review asks for first. It is **not a table in
the Linkr database**: an append-only log is write-heavy, grows without bound and is
read rarely, which is exactly what log files are for. No new dependency — `structlog`
(already configured in [logging.py](../../apps/api/app/core/logging.py)) writes it,
DuckDB (already there) reads it.

### 6a. Written automatically, enriched at the choke points

- **One middleware** opens an audit context for every HTTP request (and every
  WebSocket session, e.g. the terminal) through `structlog.contextvars`: user, `via`
  (`web` | `api_key:<id>` | `job:<id>`), route, client IP, start time. At the end of
  the request it emits **one** `audit` event with status and duration. Nothing to add
  per route.
- **The choke points only add fields** to that context — `resolve_login`, `query`,
  `introspect`, `client_recipe`, export, `run_code`: `data_source_id`, project, the SQL
  (truncated to 2 KB), row count. A route that touches no database produces a
  generic line; one that does gets the detail, without its author doing anything.
- **Jobs** (no HTTP request) open the same context in the job runner, with
  `via = job:<id>` and the launcher as user.
- Only requests that **read or change data** are kept (the middleware drops GETs on
  static metadata and health checks), so the log is not flooded by UI polling.
- Denied attempts (missing permission, 428 without credential, DB auth failure) are
  logged with `status = denied`.
- **Never result data**. The SQL can hold identifiers (`WHERE person_id = …`), so the
  log itself is sensitive (§6c).

### 6b. Storage

- A dedicated `linkr.audit` logger writes **JSON Lines** to
  `data_dir/audit/YYYY-MM-DD.jsonl` (one file per day), and also to stdout so a
  hospital's collector (ELK, Loki, Splunk…) picks it up with no Linkr-side
  integration — that is the state-of-the-art path when the site has one.
- A nightly step (existing idle sweep) **compacts the previous days into Parquet**
  (`audit/YYYY-MM.parquet`, via DuckDB `COPY … TO … (FORMAT parquet, COMPRESSION zstd)`)
  and deletes the JSONL. Parquet + zstd on this very repetitive data is ~10–20× smaller
  than the JSON.
- Retention `LINKR_AUDIT_RETENTION_DAYS` (default 365): older monthly files are
  deleted.
- **Order of magnitude**: ~400 bytes a line; 20 active users × 300 audited actions a
  day ≈ 6 000 lines ≈ 2.5 MB/day of JSONL, ≈ 150–250 KB/day once in Parquet —
  **under 100 MB for a year**.
- **Tamper evidence**: each line carries the hash of the previous one (hash chain,
  `hashlib`). It does not stop root from rewriting the files, but any edit or deletion
  in the middle is detectable by a check endpoint.

### 6c. Reading

- DuckDB queries `audit/*.parquet` + today's JSONL directly (`read_parquet`,
  `read_json`), filtered and paginated in SQL — no import, no index to maintain.
- *Administration → Access log* (`audit:read`): filterable table (`DataTable`),
  CSV export. *Profile → My activity*: each user's own entries.

## 7. Code, the IDE and agents — where a password can escape

- **`client_recipe`** hands the decrypted password to the R/Python process so the
  script can ATTACH itself ([data_source_service.py:803](../../apps/api/app/services/data_source_service.py#L803)).
  With personal credentials that is the *user's own* password, in a kernel the user
  owns (`ExecutionSession.user_id`) — acceptable for a human. It is **not** for an
  agent: the MCP's `run_code` executes in that kernel, and a script can print the
  recipe, which then goes to the model. So: **recipe refused to API-key sessions**;
  humans in the IDE still get it (and it is logged, §6). Later, a server-side proxy
  (short-lived single-database token, Arrow stream) would remove the password from the
  kernel entirely.
- **`IdeConnection`**: connection settings per project, login per user — reuse
  `DatabaseCredential` when the IDE connection points at a Linkr database
  (`IdeConnection.data_source_id`), and a per-user secret otherwise.

## 8. UI

- **Database settings** (`databases:manage`): host / port / database / schema /
  sslmode only, plus *Session-only passwords* (§2f). A line explains that each user
  connects with their own account.
- **First use**: the 428 opens a dialog "Your account for «database»" — username,
  password, *Remember this password*, **Test connection**, save. Same dialog from the
  database's menu to change or forget it.
- **User settings → Database accounts** (new tab, beside API keys): the user's stored
  logins — database, username, remembered or session-only, last used — with *Change*
  and *Forget*.
- The MCP relays the 428 as a plain message ("ask the user to enter their account for
  this database in Linkr"); an agent never receives or sets a password.

## 9. File-based databases (DuckDB, SQLite, Parquet folders)

These have no login. Linkr's server process opens them with **its own OS identity**,
so it cannot apply per-user file permissions: whatever the process can read, it can
serve to anyone Linkr lets through. Access to the *files* must therefore be decided by
whoever manages the storage, and Linkr's part is to not widen it:

- **Now**: browse roots per workspace (today one global `fs_browse_roots`,
  [fs_browser.py:23](../../apps/api/app/services/fs_browser.py#L23)) — a workspace can
  only register files under the folders its admin mounted for it; registering a
  `serverPath` database needs `databases:manage`. The storage admin mounts, per
  workspace, only what its members may read. The access log (§6) is the record.
- **Later, if a site needs real per-user file ACLs**: run the user's queries and
  kernels in a worker spawned under the user's own OS account (JupyterHub-style
  spawner). A large change, out of scope here.

Uploaded files (blob store) stay Linkr-level: governed by workspace/project
permissions, as today.

## 10. Export, import, migration

- No secret is ever exported (unchanged). A database export carries only the
  non-secret settings; after import each user is asked on first use.
- **Migration**: existing shared passwords (`DataSource.connection_secret`) and the
  usernames in `connection_config` are **deleted** — Linkr does not know whose they
  were, and turning a shared account into someone's personal one would be a guess.
  Every user is asked for their own account on next use; the release notes say so.
  Existing `GitCredential` / IDE secrets are re-encrypted with the new key (§2d).
- `test_connection` for a draft config (before save) keeps taking the typed login.

## 11. Threat model (to state in the user docs)

| Who | Can recover passwords? |
|---|---|
| Another Linkr user | No |
| A Linkr admin through the UI / API | No — secrets are never returned; changing a database's target drops them (§2e) |
| Someone with a copy of the Linkr database or its backups | No — the key is not in it (§2d) |
| Someone with write access to the Linkr database | Cannot reuse another user's ciphertext (§2d) |
| Whoever administers the server (key file + DB, or root) | **Yes**, for remembered passwords — inherent to any tool that connects on the user's behalf (Dataiku, Tableau Server, Power BI gateway alike). Session-only passwords (§2f) shrink this to live memory. |

## 12. Steps

| St | Item | Effort |
|----|------|--------|
| ✅ | 1. `core/crypto.py`: own key (env or `data_dir/secret.key`), AES-GCM with associated data, key id; re-encrypt Git/IDE secrets | S |
| ✅ | 2. `DatabaseCredential` model + migration; drop `connection_secret` and config usernames | S |
| ✅ | 3. `resolve_login` + `CredentialRequired` (428); thread the acting user through every §1 caller; delete `connection_password` | M |
| ✅ | 4. Pool key per principal + invalidation; target change drops credentials (§2e); `application_name` | S |
| ✅ | 5. Caches keyed per principal (stats, concept stats, concept Parquet, introspection) | M |
| ✅ | 6. Session-only credentials (in-memory store tied to the login session) + `require_session_only` | S |
| ✅ | 7. Audit: middleware + contextvars, enrichment at the choke points, jobs; JSONL → Parquet compaction, retention, hash chain | M |
| ✅ | 8. Routes: my credential (put / test / delete), list mine; access log (admin, mine) | S |
| ✅ | 9. Front: credential dialog on 428, database settings, *Database accounts* tab, *Access log* (*My activity* has its route, no page yet) | M |
| ✅ | 10. Jobs resolve the launcher's login at run time (derive, ETL, concept refresh) | S |
| 🔜 | 11. `client_recipe` refused for API-key sessions; IDE connections split settings / login | S |
| 🔜 | 12. Per-workspace browse roots; `serverPath` registration behind `databases:manage` | M |
| ✅ | 13a. MCP relays the 428; tests; `docs/architecture.md` | S |
| 🔜 | 13b. User docs on linkr-website (databases page, new settings tabs, threat model §11) | S |
| 💤 | Server-side query proxy for kernels (no password in the kernel) | M |
| 💤 | Per-user OS identity for file access (spawner) | L |
