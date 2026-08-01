# Dependabot alert triage

This folder tracks how Linkr's GitHub **Dependabot security alerts** are handled, so the team never re-triages the same alert twice. The mechanical workflow lives in the `dependabot-triage` skill (`.claude/skills/dependabot-triage/`); this page explains the *why*.

## The one rule that explains everything

**Dependabot alerts only scan the repository's default branch (`main`).** They ignore every feature branch. So a dependency you have *already fixed* in a feature branch's `package-lock.json` keeps showing as **open** on the Security page until that lockfile is merged into `main`.

This is why the triage file below matters: without it, each time someone opens the Security page during a long-lived feature branch, they see the same ~100 "open" alerts and risk re-doing work that is in fact already fixed — just not yet merged.

## The triage file

[`dependabot-triage.csv`](./dependabot-triage.csv) — one row per `(package, ghsa_id)`. Columns:

| column | meaning |
|---|---|
| `bucket` | `resolved-in-lockfile` · `false-positive` · `blocked-upstream` · `open` |
| `action` | `pending-merge` · `dismissed` · `bumped` · `none` |
| `dismissed_reason` | GitHub reason used when dismissed (`not_used`, `tolerable_risk`, …) |
| `notes` | the justification, in one line |

The buckets:

- **resolved-in-lockfile** — the fix is already in this branch's `package-lock.json`. Will auto-close on GitHub **as soon as the lockfile reaches `main`**. No further action; do not re-dismiss.
- **false-positive** — the vulnerable code path is not reachable in Linkr (a framework mode we don't use, an OS-specific vector on an OS we don't ship). Dismissed with reason `not_used`.
- **blocked-upstream** — the only fix needs a version bump that no published release of our direct dependency offers yet (e.g. transitive `dompurify` pinned by `monaco-editor`). Dismissed with reason `tolerable_risk`, to revisit when upstream updates.
- **open** — genuinely still vulnerable and not yet decided (usually a residual transitive copy in build/lint tooling). Low priority but real.

## Getting the alerts to actually close

Because of the default-branch rule, fixes committed on a feature branch will **not** move the counter. To make the Security page drop before the feature merges, open a small dedicated PR (e.g. `security/dependency-updates`) that carries only the `package.json` + `package-lock.json` changes into `main`. After it merges, Dependabot re-scans and closes every `resolved-in-lockfile` row at once. You can also force a re-scan from **Insights → Dependency graph → Dependabot → Check for updates** (it re-scans the latest commit on the default branch).

## Access note

GitHub is only a **clone mirror** of Linkr (the real remote is framagit). The GitHub API needs a **token** — an SSH key authenticates `git` but returns 401 on `api.github.com`. Run `gh auth login` (browser flow) once, then the skill can read and dismiss alerts. Every `gh api` call must spell out `repos/OWNER/REPO/...` because `gh` can't auto-detect the repo from a non-GitHub remote.
