# Security & compliance — plan

**Status: audit done 2026-09-30; section A fixed on `feature/security-a`.** Frame: [../deployment-context.md](../deployment-context.md)
(Linkr inside a per-project SPE; one instance per SPE; a global instance with no patient
data). Reference text: CNIL *référentiel entrepôts de données de santé*, délibération
n° 2021-118 ([PDF](https://www.cnil.fr/sites/cnil/files/atoms/files/referentiel_entrepot.pdf)) —
the requirement ids below (SEC-JOU-1…) are its numbering. The same concerns apply outside
France; the CNIL text is only the most precise checklist we have.

Paths are relative to `apps/api/app/` unless stated. Line numbers are from 2026-09-30 —
re-locate before editing. Items marked *(verified)* were read in the code by hand; the
rest come from an automated read of the code and should be confirmed before fixing.

## What the SPE covers, and what it does not

Out of Linkr's scope in the SPE frame (document it, don't build it): two-factor
authentication, network isolation, disk encryption, pseudonymisation, datamart
extraction, export approval (SEC-AUT, SEC-RES, SEC-LOG-2/3, SEC-PSE, SEC-ESP-2, SEC-EXP-2/3).

Still Linkr's job: no privilege escalation inside an instance, traceability of what
happens in Linkr (SEC-JOU-1/4), nothing patient-level towards the global instance
(SEC-EXP-1), aggregate-only restitution when needed (SEC-HAB-2, SEC-EXP-4).

## A. Blocking — whatever the deployment

### A1. Any account can take over the server *(verified)*

**Fixed:** `projects.workspace_id` NOT NULL (migration `d3e4f5a6b7c8` moves orphans to a
personal workspace of their owner), the `"owner"` fallback removed, moves checked on the
destination; kernels / PTY / provisioners start from `execution/child_env.py`; the image
serves as `linkr` with data in `/var/lib/linkr`; API port on loopback. The separate kernel
identity stays 💤 — documented as "`ide:execute` = trusted with the instance".

The chain:

1. `POST /projects` with no `workspace_id` checks no permission
   (`api/v1/routes/projects.py:23-39`).
2. `effective_project_role` returns `"owner"` for **any** user on an unassigned project
   (`core/permissions.py:276-278`, "open to any user").
3. `owner` holds `ide:execute`, and `POST /execute` checks nothing else
   (`api/v1/routes/execution.py:91-116`).
4. The kernel inherits the API's whole environment (`services/execution/kernel.py:723`
   `{**os.environ, **self._env}`; `pty_kernel.py:54`; also `renv_provisioner.py:68`), as
   the same OS user. `docker/Dockerfile.api` has no `USER`, so that user is root.
5. From there: read `LINKR_SECRET_KEY` → forge an admin JWT (`core/security.py`). Or read
   `data_dir/secret.key` + `linkr.db` → decrypt every stored DB password. Or rewrite
   `audit/` (the hash chain is unkeyed, `core/audit.py:182`). `project-settings:write` also
   opens `/list-dir` on the whole filesystem while `fs_browse_roots` is empty.

Fix, in this order:

- **Forbid projects without a workspace.**
  - Make `ProjectCreate.workspace_id` required, and `projects.workspace_id` NOT NULL.
  - Migration: move existing unassigned projects into a workspace, e.g. a per-owner
    personal workspace, or the first workspace the owner belongs to.
  - Delete the `workspace_id is None → "owner"` branch.
  - Add the destination-workspace check to `update_project`, which the old 💤 item
    already mentioned.
  - Check every path that can create a project without one: import ZIP, seed, catalog
    install, MCP `create_project`, client-only mode.
- **Scrub the kernel / PTY / provisioner environment.**
  - Build it from an allowlist: `PATH`, `HOME`, `LANG`/`LC_*`, `TZ`, `TMPDIR`, the
    runtime's own variables, and the `LINKR_*` bridge (`project_fs.runtime_env`).
  - Never pass `LINKR_SECRET_KEY`, `LINKR_ENCRYPTION_KEY`, `LINKR_ENCRYPTION_OLD_KEYS`,
    DB URLs or git tokens.
  - Add a test asserting that none of the secret names reach a spawned kernel's
    environment.
- **Run the API as a non-root user** in `Dockerfile.api`. Data then moves out of
  `/root/.linkr`: plan the volume path.
- **Separate identity for kernels (L, may stay 💤).** A kernel running as its own OS user
  without read access to `data_dir` is the real fix. Without it, a kernel can still read
  `secret.key` and `linkr.db` from disk even with a clean environment. At minimum,
  document it: "`ide:execute` = trusted with the instance".

### A2. `POST /data-sources/test-connection` — SSRF

- The route needs no permission (`api/v1/routes/data_sources.py:144-153`).
- It connects to any host and port and returns the driver's error text
  (`services/data_source_service.py:1093-1106`). That is a port and host scanner.
- Inside an SPE, the internal network *is* the CDW's.
- Fix:
  - require `databases:write` on a workspace;
  - reuse `git_service._reject_internal_host`, extended to every engine;
  - return a generic error.
- Beware that the SSRF guard blocks private IPs, which is exactly where an SPE's datamart
  lives. So the guard must be an **allowlist from config** (`LINKR_DB_ALLOWED_HOSTS`), not
  a hard block.

### A3. Git routes — no entity check, local paths not refused

- `POST /git/clone`, `/git/verify-remote` and `PUT /git/host-token` are open to any
  authenticated user (`api/v1/routes/git.py:1213-1300`).
- `_reject_internal_host` returns early for any non-http(s) scheme
  (`services/git_service.py:243-244`, *verified*). `_clean_url` leaves local paths and
  `file://` untouched (l.209-217, *verified*).
- No `GIT_ALLOW_PROTOCOL` is set in `_git_env`. So cloning a repository that sits on the
  server's disk, and getting it back as a ZIP, looks possible. **To confirm with a test.**
- Fix:
  - refuse anything that is not `https://` or `ssh://` / `git@`;
  - set `GIT_ALLOW_PROTOCOL=https:ssh`;
  - tie clone and verify to a permission;
  - the http(s) check runs at DNS time only, so pin the resolved IP or disable
    redirects (`http.followRedirects=false`).
- Related: the commit-push routes still accept `paths=None`, which runs `git add -A`
  (already 🔜 in *Versioning*).

### A4. Agents can obtain the decrypted DB password

- `get_kernel_user` now refuses API tokens (`core/deps.py:120-125`).
- But an API-key session can still call `POST /execute` (`api/v1/routes/execution.py:170-173`).
- The spawned kernel gets a **kernel** token for that user (l.262-265). A script can then
  call `api/v1/routes/client_lib.py:30-65` and print the password to the model.
- This is the open 🤔 in *Per-user database credentials*: server-side query proxy, or no
  DB recipe for kernels started by an API-key session. The latter is S and closes it now:
  mark the kernel token with the caller's auth kind and refuse the recipe for it.

## B. Compliance in the SPE frame

### B1. Access log gaps — SEC-JOU-1

- `_worth_logging` (`core/audit.py:166-171`) keeps a line only when an action was bound,
  the request was refused, or the request is a mutating one with a known actor.
- Missing:
  - **successful login**, by username: `/auth/login` never sets the actor
    (`api/v1/routes/auth.py:43-62`). A failed login is logged with no username;
  - **downloads**: dataset `/raw` (`dataset_files.py:172`), DB file blob
    (`data_sources.py:177`), project `export-zip` (`projects.py:47`);
  - workspace export: logged only as a generic POST, with no action;
  - **row previews**: `POST /dataset-files/rows/query` (`dataset_files.py:110`), dataset
    `distinct`.
- These downloads are what feeds the SPE's export checkpoint: we need "who produced which
  file".
- Fix: bind actions (`download`, `export`, `preview`, `login`) with the file / entity id and
  size. Unit-test `_worth_logging` on each.
- Browser-side queries (WASM, blob pulled to the browser) cannot be logged server-side.
  Document it; the fix is to not ship blobs (see C1).

### B2. Log retention bounds — SEC-JOU-4

- `audit_retention_days` (`config.py:118`) has no bounds.
- SEC-JOU-4 asks for 6 to 12 months. Either clamp it (warn at boot outside 180–365), or
  document it for the SPE.

### B3. Exports towards the global instance carry small counts — SEC-EXP-1

- Under `minPatients` (default 11), `buildConceptProfile` withholds the profile JSON but
  still returns `rowsCount` / `patientsCount`
  (`apps/web/src/lib/concept-mapping/concept-profile.ts:831-832`).
- `source-extraction.ts:427-428` writes them as `record_count` / `patient_count`.
- `source-concepts.csv` goes out verbatim:
  - `lib/concept-mapping/export.ts:573-575, 819-872`;
  - server side, `services/mapping_project_export.py:306` and
    `workspace_export_assemble.py:420`;
  - git sync, `services/git_service.py:901,1238`.
- Above the threshold, profiles still carry min/max, histograms and per-patient min/max,
  with no masking of small bins or extremes.
- Fix:
  - one export-time pass, same rule client and server: counts under the threshold become
    `<k`, histogram bins under k are merged or masked, extremes are dropped or replaced by
    a quantile (P1/P99);
  - the threshold is read from the instance's config;
  - golden test on an export with small counts.
- Same review for DQ rule-set results and SQL collections if they can embed result
  samples.
- The site page promises that the global instance holds "no patient data". This item is
  what makes it true.

### B4. Password change is broken

- `apps/web/src/features/settings/ChangePasswordDialog.tsx:41` calls
  `/auth/change-password`, which does not exist. `PATCH /me` refuses the password field
  (`auth.py:138`).
- Fix:
  - add the route: current password + new one, with a server-side policy (length ≥ 12,
    not equal to the username);
  - log it (`password_change`).

## C. Aggregate-only access — SEC-HAB-2, SEC-EXP-4

Needed when some members of an SPE, or the audience of a steering dashboard, may see
aggregates but not rows. Today `databases:read` / `datasets:read` return raw rows
(`POST /data-sources/{id}/query`, `/raw`, `/blob`, `rows/query`), and suppression exists
only in the cohort report, the data catalog and concept profiles.

### C1. Split "read rows" from "read aggregates" in the permission model

- **Add an action `rows`** to the resources that expose patient-level data: `databases`,
  `datasets`, `patient-data`, `cohorts`. `read` keeps its meaning for metadata and
  aggregates.
  - Existing roles get `rows` wherever they have `read`, so behaviour is unchanged on
    upgrade.
  - Add a new default role **`aggregates`**: read without rows, no `ide:*`.
- **Classify every route** (server-side; UI gating stays cosmetic):
  - **needs `rows`**:
    - free SQL `/query` — free SQL can never be made aggregate-safe (`GROUP BY person_id`);
    - DB file blob;
    - dataset `/raw`, `rows/query`, `distinct`;
    - patient-data views;
    - cohort sample rows and materialised person ids;
    - derive;
    - project / workspace export with data files;
  - **needs `ide:execute`**, which implies rows because code can read anything: IDE, SQL
    tab, ETL runs, MCP `run_sql` / `run_code`;
  - **aggregate routes**: concept counts, DB stats, cohort count and attrition, cohort
    report, catalog results, dashboard aggregates (C2). These always go through
    suppression for a caller without `rows`.
- **Close the browser path.** In server mode a caller without `rows` must never receive a
  blob or a Parquet file. Everything is computed server-side. The WASM mode cannot
  enforce this and is out of scope (see deployment-context.md).
- Also: the catalog `GET /data-catalogs/{id}/results-cache` returns raw unmasked counts to
  any `catalog:read` user (`api/v1/routes/data_catalogs.py:90-107`). Masking runs
  client-side (`apps/web/src/lib/data-catalog/suppression.ts`). For a caller without
  `rows`, serve the masked results.

### C2. Aggregate mode for dashboards

- **What it is:**
  - a dashboard, or a viewer who has only `aggregates`, renders from a
    **server aggregation endpoint**: the widget sends a spec (group-by columns + measures
    + filters), the server runs the `GROUP BY` on the dataset and returns a suppressed
    table;
  - widgets that need rows are hidden or shown as "not available in aggregate mode":
    row tables, scatter plots, individual timelines, R/Python code widgets;
  - the check comes before the build: read how widgets get their data today (client-side
    over dataset rows vs `renderOnServer` analyses) and list which widgets can be
    expressed as a group-by spec.
- **Suppression, one server-side implementation:**
  - primary suppression: cells < k, k from config, default 11;
  - secondary suppression, so a masked cell cannot be recomputed from totals;
  - port the mass rule already in `lib/data-catalog/suppression.ts` rather than inventing
    a second one.
- **Filters are the hard part.** SEC-EXP-4 says "including when filtering".
  - Two overlapping filters subtracted from each other can re-identify a masked cell
    (differencing).
  - Answer: **cell-key noise** (the catalog already has `perturbation.ts`, the ABS
    TableBuilder method). The same record set always gets the same noise, so repeating
    or subtracting queries does not average it out.
  - Plus a **minimum filtered population**: below k patients after filters, show
    nothing.
  - Document the residual risk. There is no perfect protection with free filters; noise
    is the accepted standard.
- **Cheaper first step.** A **frozen published snapshot**: the dashboard or report is
  rendered once with suppression and noise, then shared as static aggregates, the same
  as the catalog's *Publish*. That covers steering reports without the live endpoint.

### C3. MCP

- There is no switch to keep row-level output away from agents. `LINKR_MCP_TOOLSETS` is
  about context size, not access (`packages/linkr-mcp/src/live/build.ts:46-58`).
- With C1 in place, an API key carries its owner's role. Giving an agent an
  `aggregates`-role account then yields aggregate-only tools, with no MCP-specific code.
  That is the preferred route over a new MCP flag.

## D. Deployment defaults

- **The API publishes `8000:8000` on every interface** (`docker/docker-compose.yml`,
  `docker-compose.hub.yml` l.32-33), which bypasses nginx. Bind it to `127.0.0.1` or drop
  it, as was done for MCP.
- **nginx** (`docker/nginx.conf`) serves plain HTTP on port 80, with no CSP, HSTS,
  `X-Frame-Options` or `Referrer-Policy`, and `main.py` sets no security headers.
  - TLS can be terminated by the SPE's proxy.
  - The headers are ours to set: a CSP compatible with Monaco, the WASM workers and the
    `sandbox="allow-scripts"` iframes.
  - The web-apps plan notes "no CSP anywhere in the codebase".
- **Offline SPE:**
  - `pip_index_url` / `r_repos` default to PyPI and Posit (`config.py:81,87`) and must
    point at institution mirrors;
  - the per-project `indexUrl` override accepts plain `http` (`env_options.py:40`), and
    `trusted-host` disables TLS checks (`uv_provisioner.py:111-123`). Restrict both, or
    document them.
- **`fs_browse_roots` empty = the whole filesystem** (`config.py:104-111`). This is still
  🤔 in *Server file picker*. With A1 fixed, it is no longer reachable by any user, but a
  multi-user SPE must set it. Put it in the deployment checklist.
- **Uploads** (`api/v1/routes/uploads.py`): any authenticated user can write blobs up to
  `max_upload_mb`, and the sessions are not bound to the uploader. Bind them to the user.

## E. Authentication — acceptable behind the SPE, document it

These gaps are covered by the SPE's two-factor front door, provided the deployment
checklist says so:

- no MFA;
- no rate limit or lockout on `/auth/login`;
- username enumeration by timing (`core/auth_providers/local.py:17`);
- access JWT 24 h and refresh 30 d, stateless, re-issued at each refresh, not revocable;
- tokens in `localStorage`;
- no idle timeout in the UI.

Worth building (M): a **trusted-header auth provider**. The SPE's proxy passes the
authenticated identity in a header, only accepted from a configured proxy address, and
Linkr maps it to a user. One login, and the access log then carries the identity the
two-factor step validated. The provider interface is already there
(`core/auth_providers/base.py`).

## F. Documentation

- **Deployment checklist for an SPE** (`linkr-website`, `administration/`, FR + EN), for
  the DPO and the DPIA. It covers:
  - one instance per SPE;
  - the settings to fix: `fs_browse_roots`, `audit_retention_days`,
    `enable_code_execution`, mirrors, secret keys;
  - log to stdout → SIEM;
  - what the SPE must provide;
  - WASM mode is not for patient data;
  - "`ide:execute` = trusted with the instance" (until A1's separate identity exists).
- The DB-credential threat-model page (already the *Priority* item) depends on A4.
- Stale texts:
  - `docs/design/ai-agents-plan.md:343` still says "Fernet" (it is AES-GCM, and the recipe
    path does return the password: A4);
  - the per-user plan says `application_name='linkr:<username>'`, but the code stamps
    `linkr` only (`docs/architecture.md:621`). Align one or the other.

## Order

1. A1 (forbid unassigned projects, scrub the kernel environment, non-root, API port on
   loopback): closes the escalation.
2. A2, A3, A4: SSRF, git local paths, agent password.
3. B3: exports to the global instance.
4. B1, B2, B4: log gaps, retention, password change.
5. D (headers, uploads) and the F checklist.
6. C1, then C2 (snapshot first, live aggregate mode next), C3 for free.

Every fix in A–B touches pure, critical logic (permissions, env building, URL
validation, export masking, `_worth_logging`), so each gets its test in the same change.
