---
name: dependabot-triage
description: List, triage, and act on GitHub Dependabot alerts for Linkr. Fetches open alerts via the GitHub API, classifies each (resolved-once-merged / false-positive / blocked-upstream / actionable), proposes fixes or dismissals, then records every decision in docs/security/dependabot-triage.csv so already-triaged alerts are never re-processed. Use when the user asks to check, review, fix, or dismiss Dependabot / dependency security alerts.
argument-hint: [owner/repo (optional, e.g. BorisDelange/Linkr)]
---

# Linkr Dependabot Triage

You are triaging the project's Dependabot security alerts. The user is **not** a security engineer — your classification is the decision gate. Be concrete and honest; never dismiss an alert you cannot justify.

The single most important fact about this workflow (learned the hard way):

> **Dependabot *alerts* only ever scan the repository's default branch (usually `main`).**
> They completely ignore feature branches. So a dependency you have *already fixed* in a feature branch's `package-lock.json` will keep showing as **open** on the Security page until that lockfile reaches `main`. Do **not** re-fix or re-dismiss those — they are already handled, just not yet visible as closed. The triage CSV exists precisely to remember this across sessions.

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

## Step 1 — Fetch open alerts

```bash
gh api --paginate "repos/OWNER/REPO/dependabot/alerts?state=open&per_page=100"
```

Also read the default branch (from Step 0). Note that the alert count on the Security page is inflated: GitHub emits **one alert per advisory per dependency path**, so a single vulnerable package (e.g. `hono`) can appear 20+ times. Group by package for the human summary; keep per-alert `number` + `ghsa_id` for actions.

## Step 2 — Load prior decisions

Read `docs/security/dependabot-triage.csv` (create it from the header below if absent). It records, per `package,ghsa_id`, what was decided and why. Any alert already present with a terminal decision (`dismissed-*`, `fixed-in-branch`) is **not** re-triaged — only reported as "already handled, pending merge to <default branch>".

## Step 3 — Classify every open alert

For each alert not already terminal in the CSV, put it in exactly one bucket:

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

## Step 5 — Record every decision in the CSV

Append/update one row per `package,ghsa_id` touched this session. Header:

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
