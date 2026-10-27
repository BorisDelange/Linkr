# Dependency alerts

You are triaging the advisories that affect Linkr's dependencies. The user is **not** a security engineer — your classification is the decision gate. Be concrete and honest; never dismiss an alert you cannot justify.

## Two sources, and which one to trust on a branch

**Dependabot alerts only scan the repository's default branch (`main`).** They ignore every feature branch, so they lag the work by a whole release: a dependency already fixed on `feature/fastapi-backend` keeps showing as open, and a vulnerable one added there does not show at all. GitHub has no setting to point alerts at another branch; the only lever is the mirror's default branch (below).

So the **primary source is a local scan of the branch you are on**, which reads its lockfiles directly (Step 0). Dependabot is the second net, and the place where alerts are dismissed for the record.

If the user wants the GitHub Security page itself to follow the development branch: on the GitHub mirror, *Settings → General → Default branch* → `feature/fastapi-backend` (GitHub is only a clone mirror, nothing else depends on its default branch). Dependabot then re-scans that branch. Switch it back to `main` at the end of the cycle if the user prefers; say so, do not do it yourself.

## Step 0 — Scan the current branch locally

```bash
npm audit --json > "$TMPDIR/npm-audit.json"           # root workspace: apps/web, packages/*
(cd apps/api && uv export --frozen --no-hashes --all-extras --no-emit-project) > "$TMPDIR/api-reqs.txt"
uvx pip-audit -r "$TMPDIR/api-reqs.txt" --no-deps --disable-pip --progress-spinner off -f json > "$TMPDIR/pip-audit.json"
```

- `npm audit` reads `package-lock.json` against the GitHub Advisory Database: its findings carry GHSA ids (in `via[].url`), the same ids as Dependabot.
- `pip-audit` reads `apps/api/uv.lock` (through `uv export --frozen`, so exactly what the image installs) against PyPI/OSV. Use a vulnerability's GHSA alias (`aliases`) as its id when it has one, else its PYSEC/CVE id.
- Both send package names and versions to public advisory services, nothing else. Offline (inside an SPE) they fail: say so and fall back to Dependabot.
- Not covered by either: the R packages, pinned by the dated p3m snapshot `CRAN_SNAPSHOT` in `docker/Dockerfile.api`, and the base images. Mention it; moving the snapshot is a deliberate decision of the user.

Classify these findings as in Step 3. Then, if GitHub access works, fetch Dependabot (Steps 1–2) to reconcile: an alert open on GitHub but absent from the local scan is fixed on this branch (`resolved-in-lockfile`); a local finding with no GitHub alert is new on this branch.

## Prerequisites — access

Linkr's git remote is **framagit**, and GitHub is only a clone mirror. Two consequences:

1. The GitHub API needs a **token**, not an SSH key. An SSH key authenticates `git push`/`pull` but returns **401** on `api.github.com`. So `gh auth login` (or a `GH_TOKEN`) is required even if SSH already works.
2. `gh` cannot auto-detect the repo (no GitHub remote), so **every `gh api` call must spell out `repos/OWNER/REPO/...` in the URL** — the `-R` flag does not exist for `gh api`.

Check access first:

```bash
gh auth status                       # must say "Logged in"
gh api "repos/OWNER/REPO" --jq '.default_branch'   # must return the branch, not 401
```

If not logged in, tell the user to run `gh auth login` **in their own terminal** (it is an interactive browser flow this session cannot drive). Do not ask for tokens or codes. `gh` itself: install with the platform's package manager if missing (`brew install gh` on macOS).

**Resolve `OWNER/REPO`** in this order: the skill argument if given → an existing GitHub remote (`git remote -v | grep github`) → otherwise ask the user. Never hard-code it and never assume a local filesystem path.

## Step 1 — Fetch open Dependabot alerts

```bash
gh api --paginate "repos/OWNER/REPO/dependabot/alerts?state=open&per_page=100"
```

Also read the default branch (from Step 0). Note that the alert count on the Security page is inflated: GitHub emits **one alert per advisory per dependency path**, so a single vulnerable package (e.g. `hono`) can appear 20+ times. Group by package for the human summary; keep per-alert `number` + `ghsa_id` for actions.

## Step 2 — Load prior decisions

Read `TRIAGE-LOG.csv` (in this skill's own directory; create it from the header below if absent). It records, per `package,ghsa_id` (the column holds a PYSEC or CVE id for a Python advisory with no GHSA alias), what was decided and why. Any alert already present with a terminal decision (`dismissed`, `pending-merge`) is **not** re-triaged — only reported as "already handled, pending merge to <default branch>".

## Step 3 — Classify every open alert

For each finding (local scan) or alert (Dependabot) not already terminal in the CSV, put it in exactly one bucket:

- **resolved-in-lockfile** — the version now in the repo's `package-lock.json` already satisfies the advisory's `first_patched_version` (compare numerically; a CDN/tarball version like SheetJS `0.20.3` counts if it is ≥ the patched version or above the vulnerable range). These will auto-close when the lockfile reaches the default branch. **No action** — just record.
- **actionable** — a non-breaking fix exists and is not yet applied. Propose a bump (`npm audit fix`, or a targeted install). Prefer non-breaking; flag breaking ones separately.
- **false-positive** — the vulnerable code path is genuinely not reachable in Linkr (e.g. a framework mode we don't use, an OS-specific vector on an OS we don't ship). Candidate for dismissal, reason `not_used`.
- **blocked-upstream** — the only fix requires a bump that no published version of our direct dependency provides yet (e.g. a transitive `dompurify` pinned by `monaco-editor`). Candidate for dismissal, reason `tolerable_risk`, to revisit when upstream updates.

Base the "is it reachable?" judgement on the actual code — grep for the API/mode the advisory describes before calling something a false-positive. When unsure, keep it open, do not dismiss.

## Step 4 — Propose, then act (only after the user approves)

Present a grouped summary: counts per bucket, then the packages in each. Recommend an action per bucket. **Do not dismiss or bump anything until the user says go.**

To **apply non-breaking fixes**: change `package.json`/run the install, then `npm run test` and (if it builds cleanly) `npm run build`. Commit only `package.json` + `package-lock.json` (this is a shared branch — stage by path, never `git add -A`). Note in the message that alerts close only once the lockfile is on the default branch.

To **dismiss** an alert:

```bash
gh api -X PATCH "repos/OWNER/REPO/dependabot/alerts/NUMBER" \
  --raw-field state=dismissed \
  --raw-field dismissed_reason=REASON \
  --raw-field dismissed_comment="…"
```

- Valid `dismissed_reason`: `fix_started`, `inaccurate`, `no_bandwidth`, `not_used`, `tolerable_risk`.
- **The comment is hard-capped at 280 characters** — the API returns 422 above it (and the error confusingly blames `alert_number`). Keep comments tight.
- Loop over alert numbers with an explicit list (`for n in 118 103 95; do …; done`), not a shell-expanded variable — a single variable holding all numbers gets passed as one bad argument.

## Step 5 — Record every decision in TRIAGE-LOG.csv

Append/update one row per `package,ghsa_id` touched this session in `TRIAGE-LOG.csv` (this skill's directory). Header:

```
date,package,ghsa_id,severity,alert_number,bucket,action,dismissed_reason,notes
```

- `date`: today (ISO). `bucket`: one of the Step 3 buckets. `action`: `none` | `dismissed` | `bumped` | `pending-merge`.
- One row per (package, ghsa_id) — the same advisory across many paths shares a row; list representative alert numbers in `alert_number` or use `multiple`.
- Keep the CSV sorted by package then ghsa_id for clean diffs.

Then write a one-paragraph human summary and remind the user of the branch rule: fixes committed on a feature branch **will not close alerts until merged to the default branch** — schedule a small dedicated PR (`security/dependency-updates`) to the default branch if they want the counter to drop before the feature merges.

## Guardrails

- Never dismiss an alert whose reachability you have not checked in the code.
- Never bump a breaking major without explicitly calling it out and getting approval.
- Never stage unrelated files on a shared branch.
- If the CSV and GitHub disagree (an alert marked dismissed is open again, or vice-versa), surface it rather than silently re-acting.
