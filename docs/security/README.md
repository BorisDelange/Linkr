# Dependency security

How Linkr handles security advisories on its dependencies. This page is the human-facing overview; the step-by-step workflow (scanning, classifying, dismissing) lives in the **`security` skill** at [`.claude/skills/security/DEPENDENCIES.md`](../../.claude/skills/security/DEPENDENCIES.md), together with `TRIAGE-LOG.csv`, the record of every decision taken. The same skill covers audits of Linkr's own code and the disclosure policy: a vulnerability in Linkr and its fix stay unpublished until the release that ships the fix.

## Scanning the branch you work on

Dependabot (below) only looks at `main`, so it lags the work by a release. The skill therefore scans the current branch's lockfiles locally first — `npm audit` for `package-lock.json`, `pip-audit` for `apps/api/uv.lock` — and uses Dependabot as a second net. Neither covers the R packages (dated CRAN snapshot in `docker/Dockerfile.api`) or the base images.

## Dependabot only scans `main`

**Dependabot alerts only scan the repository's default branch (`main`).** They ignore every feature branch. So a dependency you have *already fixed* in a feature branch's `package-lock.json` keeps showing as **open** on the Security page until that lockfile is merged into `main`.

This is why the triage log matters: on a long-lived feature branch you will keep seeing the same ~100 "open" alerts, and without a record you risk re-doing work that is in fact already fixed — just not yet merged. Check `TRIAGE-LOG.csv` before acting.

## The triage log

[`.claude/skills/security/TRIAGE-LOG.csv`](../../.claude/skills/security/TRIAGE-LOG.csv) — one row per `(package, ghsa_id)`, with our decision. Buckets:

- **resolved-in-lockfile** — fix already in this branch's lockfile; will auto-close once merged to `main`. No action.
- **false-positive** — the vulnerable code path is not reachable in Linkr (a framework mode we don't use, an OS-specific vector on an OS we don't ship). Dismissed as `not_used`.
- **blocked-upstream** — the only fix needs a version a direct dependency doesn't offer yet (e.g. transitive `dompurify` pinned by `monaco-editor`). Dismissed as `tolerable_risk`, revisit when upstream updates.
- **open** — genuinely still vulnerable and undecided (usually a residual transitive copy in build/lint tooling).

## Making the alerts actually close

Because of the default-branch rule, branch fixes don't move the counter. To drop it before the feature merges, open a small dedicated PR (e.g. `security/dependency-updates`) carrying only the `package.json` + `package-lock.json` changes into `main`. After it merges, Dependabot re-scans and closes every `resolved-in-lockfile` alert at once. You can also force a re-scan from **Insights → Dependency graph → Dependabot → Check for updates**.

## Access

GitHub is only a **clone mirror** (the real remote is framagit). The GitHub API needs a **token** — an SSH key authenticates `git` but returns 401 on `api.github.com`. Run `gh auth login` (browser flow) once; then the skill can read and dismiss alerts.
