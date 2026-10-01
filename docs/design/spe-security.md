# Security inside a secure processing environment

Linkr runs inside a project's secure processing environment (SPE), one instance per
SPE, next to a global instance that holds no patient data — the frame is
[../deployment-context.md](../deployment-context.md). This document says what Linkr
guarantees in that frame, how, and why some protections were deliberately left out.
It came out of an audit of 2026-09-30, which used the CNIL framework for health data
warehouses (délibération n° 2021-118) as its checklist; the guarantees themselves are not
specific to one country.

The user-facing side lives on the website: *Deploying in an SPE*
(`administration/spe-checklist`), *Database passwords*
(`administration/database-passwords`), *Configuration*, *Authentication and permissions*.

Paths are relative to `apps/api/app/` unless stated.

## The split with the SPE

The SPE provides, and Linkr does not: two-factor authentication and control of who
enters, network isolation, disk encryption, pseudonymisation and datamart extraction,
approval of every file that leaves, log collection (SIEM), TLS and HSTS, package mirrors.

Linkr guarantees three things the SPE cannot see from outside:

1. **No escalation inside an instance** — a user gets the rights their roles give, and
   no way around them through the server.
2. **Traceability** of what happens in Linkr: who read which data, ran which code,
   downloaded or exported which file.
3. **Nothing patient-level towards the global instance** in what is meant to travel
   there.

## 1. No escalation inside an instance

**Every project belongs to a workspace.** `projects.workspace_id` is NOT NULL and
`ProjectCreate.workspace_id` required; a project's rights come from its workspace and
project roles (`core/permissions.py`), with no fallback. Moving a project checks the
right to create in the destination (`routes/projects.py`, `_check_target_workspace`).
Migration `d3e4f5a6b7c8` gave every former unassigned project a personal workspace of
its owner. Why: an unassigned project used to make *any* user its owner, and owner
carries `ide:execute` — the entry point to everything below.

**Code runs with an allowlisted environment.** Kernels, the PTY terminal and the package
provisioners start from `services/execution/child_env.py`: a fixed list of names and
prefixes (locale, paths, runtime variables), plus proxy and `UV_`/`PIP_` settings for
installers only. `LINKR_SECRET_KEY`, `LINKR_ENCRYPTION_KEY`, `LINKR_ENCRYPTION_OLD_KEYS`
and `LINKR_DATABASE_URL` are named in `SECRET_NAMES` so that no later widening of the
list lets them through. Why an allowlist rather than a denylist: the API's environment
holds whatever the deployer put there, and code a user wrote must see none of it.

**The server never runs as root.** The image creates a `linkr` user; the entrypoint
(`docker/api-entrypoint.sh`) hands the data directory to it and re-executes itself with
`setpriv` before migrations and uvicorn. Data lives in `/var/lib/linkr`. The API port is
published on `127.0.0.1` only, so the way in is the front proxy.

**What code can still reach.** At startup the API makes itself non-dumpable
(`core/hardening.py`, `prctl(PR_SET_DUMPABLE, 0)` on Linux, a logged no-op elsewhere), so
a same-user kernel can neither read `/proc/<api pid>/environ` — where `LINKR_SECRET_KEY`,
`LINKR_ENCRYPTION_KEY` and the trusted-proxy secret live — nor attach a debugger to it;
kernels reset the flag on exec and are unaffected. The files are another matter: a
kernel runs as the same system user as the server, so it can read `data_dir` —
`secret.key`, `linkr.db`, the access log files. This is accepted:
inside a per-project SPE, everyone with `ide:execute` is a project member already
authorised on the same data, and the remaining risk is traceability within the team
(using a colleague's saved database password, rewriting Linkr's local log copy — the
stdout copy the SIEM collects is out of reach). The docs state it as
"`ide:execute` means: trusted with the instance". Running kernels under their own system
identity is parked (see *Not built*).

## 2. Outbound connections

**External databases: an allowlist of hosts.** Every external DSN is built by
`db_connect._dsn`, which checks `LINKR_DB_ALLOWED_HOSTS`
(`services/data/db_host_guard.py`: names, IPs, CIDRs, libpq host lists and socket paths).
`POST /data-sources/test-connection` needs `databases:write` in the workspace it names
and answers "Connection failed", the driver's text going to the server log only; so do
`/retest` and `/schema` of a stored external source (a managed or uploaded file keeps
its message, which names only its own file). Why an
allowlist and not a block of private addresses: in an SPE the datamart *is* on a
private address; what must be prevented is reaching the rest of the warehouse's
network. Empty means unrestricted, so the SPE checklist sets it.

**Git: network remotes only.** `git_service._require_network_remote` accepts https,
`ssh://` and `user@host:path`, never a local path, `file://` or a host starting with
`-`; `_git_env` sets `GIT_ALLOW_PROTOCOL=https:ssh` and `http.followRedirects=false` (the
http(s) host check runs at DNS time, a redirect would bypass it). Clone and
verify-remote need a write permission in the workspace they name, or global
`workspaces:write`. Why: a server-side clone came back as a ZIP, so a local path read the
server's own disk. ssh remotes are not checked against internal addresses, because an
institution's internal GitLab over ssh is a normal setup.

**Package indexes: chosen by the instance or the workspace.** A plain-http index or a
`trustedHost` (TLS checks off) may be set in the server and workspace layers; a
project's `options.json` may use them only for a host one of those layers already chose
(`services/execution/env_options.py`, `_confine_override`). Why: the project file travels
with git, so it must not be able to point installs at a host of its author's choosing.

## 3. Database passwords and agents

Each user reaches an external database with their own account, remembered (AES-GCM,
sealed to the user and to the database's address) or session-only; changing a
database's address drops every account on it. The threat model is the website page
*Database passwords*.

The IDE's client libraries (`linkr_connect()`) obtain the user's password through a
**kernel token** minted when the kernel starts. Two rules keep it away from agents:

- **The token says how its kernel was started.** `create_kernel_token(..., via=…)`
  records the auth path of the spawning request (`web`, `api_key`), and
  `get_kernel_user` (`core/deps.py`) accepts only `via == "web"`. A kernel an API key
  started gets no password.
- **An agent cannot run code in a kernel the IDE started.** A kernel remembers its
  `spawned_via`, and `KernelManager.get` raises `KernelSessionForeign` (409) when a
  non-web request reaches a web-started kernel — so do `restart`, `interrupt` and
  `shutdown_session`, or an agent could kill the IDE's kernel and respawn it under its
  own token for the IDE to keep using (`web` and `kernel` count as web: a
  non-web kernel token is refused at auth anyway). The MCP's `run_code` / `run_script`
  default to a session of their own, `agent` (`packages/linkr-mcp/src/live/shared.ts`,
  `AGENT_SESSION`). The other direction stays open: the IDE may open what an agent
  started, whose token holds no password.

What these two rules hold against: an agent fetching a decrypted password **through the
API**. They do not hold against agent code that sets out to find one: its kernel runs as
the API's system user, reads `data_dir/secret.key` and `linkr.db` like any kernel (§1),
and can unseal every saved database password from them. Only kernels under a separate
system identity would close that (*Not built*); until then, an agent given
`ide:execute` is trusted with the instance like any other holder of it.

An agent queries databases with `run_sql`, which the server runs without exposing a
password. A server-side query proxy for code was not built: it would remove the native
DBI / dbplyr handles from user code, for a need nobody has yet.

## 4. Access log

`core/audit.py` writes one line per meaningful request (`_worth_logging`: a bound
action, a refusal, or a mutation with a known actor), to standard output for the SIEM
and to daily files in `data_dir/audit/`, compacted per month and chained by hash.
Actions bound at the choke points: `login` and `login_failed` (attempted username in
`detail`), `password_change` / `password_change_failed`, `download` (dataset raw file,
database file blob, mapping-project source file, with size), `export` (project,
workspace, mapping-project ZIPs, settings, with size), `preview` (dataset rows with
`row_count`, distinct values), plus queries and code runs. Downloads and exports carry
author and size because that is what the SPE's export checkpoint matches against the
files submitted to it.

Retention is `LINKR_AUDIT_RETENTION_DAYS`, 365 by default, at least 1 (0 would empty the
log at the next compaction). No other bound and no warning: the right duration is each
institution's rule.

Queries a browser runs on data it already holds (a blob pulled to DuckDB-WASM) cannot be
logged server-side; the blob download itself is.

## 5. What travels to the global instance

A mapping project is what goes up from an SPE. Every exit — ZIP, workspace export, git
push, the Export tab's CSV, the Usagi CSV, `mappings.json` — goes through one masking
pass, `services/export_masking.py` and its byte-identical twin
`apps/web/src/lib/concept-mapping/export-masking.ts`, held together by a shared fixture
(`__fixtures__/export-masking/`). With k the threshold:

- a count cell in 1..k-1 becomes `<k`;
- a concept's profile under k patients or records is withheld;
- other profiles lose their extremes (`min`, `max`, `range`, per-patient min/max) and
  every histogram bin, category, ward or year under k records, directly or implied by
  its percentage of the total;
- a mapping's `sourceFrequency` under k becomes null (the field is a number).

Percentiles, mean, median and the shape of the distribution stay: enough to compare two
sites, not enough to find a patient. The source file inside the instance is untouched.
k is `LINKR_EXPORT_MIN_COUNT` (default 11); the front reads it from `/setup/status`, so
exports built in the browser mask like the server's, and client-only mode uses 11. Both
sides write the same bytes because a client-only and a server user pushing the same repo
must not fight over the file — hence `_js_json` on the Python side, which formats numbers
as `JSON.stringify` does.

Quality rule sets and SQL collections export definitions only. The wiki is free text
that Linkr cannot check; the checklist says to read it before it leaves. Projects and
workspaces with their data files hold patient data and do not go to the global instance.

## 6. Accounts and sign-in

**Behind the SPE's front door.** Linkr has no MFA, no lockout on `/auth/login`, stateless
JWTs (access 24 h, refresh 30 d, revoked only by a password change), tokens in `localStorage`, no idle
timeout in the UI. Each of these is covered by the SPE's two-factor entry, and the
checklist says so; building them inside Linkr would duplicate what the SPE already does.

**Password change.** `POST /auth/change-password` (session only, local provider only)
requires the current password; the new one must pass `password_policy_error` (≥ 12
characters, not the username) and differ from the current one. The same policy applies
to the first admin (`/setup/initialize`) and to passwords an admin sets
(`user_service.create` / `update`). Setting a password stamps `users.password_changed_at`,
and every session token (access, refresh, WebSocket) issued before it is refused
(`security.predates_password_change`): refresh rotation would otherwise keep a stolen
session alive for ever. The caller of `change-password` gets fresh tokens back. `iat` has
whole-second resolution, so a token issued in the very second of the change survives.
Kernel tokens are not checked — they live in a running kernel's environment and expire
within `kernel_token_expire_minutes` (12 h).

**Sign-in through the SPE's proxy.** With `LINKR_TRUSTED_HEADER`,
`LINKR_TRUSTED_PROXIES` and `LINKR_TRUSTED_PROXY_SECRET` set, the app calls
`POST /auth/trusted-login` before showing the form (`/setup/status` says when): the
header names an existing active user, and is believed only from a listed peer address
that also sends the shared secret in `X-Linkr-Proxy-Secret` (`core/trusted_header.py`,
compared in constant time). The log records `login` via `trusted_header`. One login for
the user, and the access log carries the identity the two-factor step validated. Off by
default; the gateway must overwrite both headers on every request.

Why a secret on top of the peer address: in the Docker deployment every request reaches
the API from the image's nginx, which passes client headers through, and a kernel can
call that nginx too (`http://web/api/v1/auth/trusted-login`) — the peer check alone would
let any `ide:execute` holder name the admin. The secret is at least 32 characters (the
API refuses to boot with the header set and no usable secret or proxy list), never set
in this nginx (it would vouch for kernels), and kept from kernels like the other secrets
(`child_env.SECRET_NAMES`, §1). uvicorn's `FORWARDED_ALLOW_IPS` stays at its default:
widened to the proxy, the peer address would be read from `X-Forwarded-For`, which the
client writes.

## 7. HTTP surface

API responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and `Content-Security-Policy: default-src 'none';
frame-ancestors 'none'; sandbox` (`core/security_headers.py`, `/api/` only): nothing the
API returns is meant to render. nginx gives the app's pages `frame-ancestors 'self';
base-uri 'self'; object-src 'none'; form-action 'self'` and the usual companion headers.
HSTS belongs to the TLS proxy.

Upload sessions are bound to their uploader (`routes/uploads.py`, `_own_session`): anyone
else gets 404.

## Not built, by decision

- **Aggregate-only access** (members or dashboard viewers who may see counts but not
  rows). It would need a `rows` action separate from `read` on databases, datasets,
  patient data and cohorts; every row route classified; no blob or Parquet sent to such
  a caller; dashboards rendered from a server aggregation endpoint with primary and
  secondary suppression, cell-key noise against differencing, and a minimum filtered
  population. Dropped 2026-10-01: whoever may read a project's data in Linkr may read its
  rows. *deployment-context.md* lists it under what Linkr does not provide.
- **A script policy (`script-src`) for the app's pages.** The R/Python widgets run inline
  scripts in srcdoc iframes, which inherit the page's policy, so it would need a full
  browser pass over widgets, Monaco, DuckDB-WASM workers and maps. Dropped 2026-10-01: a
  second line of defence against injected script, of little value in an SPE where only
  the project's members reach the instance.
- **Kernels under their own system identity**, without read access to `data_dir`
  (§1). Parked (💤 in the planning README): it needs privilege separation for process
  launch, per-project file rights and a different image, for a risk judged minor inside
  a per-project SPE. It is also the only real barrier between a hostile agent's code and
  the saved database passwords (§3).
- **A recommended range for log retention.** Dropped: the duration is each institution's
  rule (§4).
