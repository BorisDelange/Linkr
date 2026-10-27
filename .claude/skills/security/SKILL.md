---
name: security
description: Everything about Linkr's own security in one place — triage dependency advisories on the current branch (npm audit, pip-audit) and Dependabot alerts (TRIAGE-LOG.csv), run or follow up a full security audit (Cloudflare security-audit skill, results kept in the gitignored .security-audits/), fix audit findings, scan Linkr's own MCP server and skills with skillspector before a release, and apply the disclosure policy that keeps vulnerabilities and their fixes local until the release that ships them. Use when the user asks about security, Dependabot or dependency alerts, a security audit, fixing findings, or a vulnerability report.
argument-hint: "[dependencies | audit | fix | scan <path> | policy]"
---

# Linkr security

The user is not a security engineer: your classification is the decision gate.
Be concrete, never dismiss what you cannot justify, never publish anything this
page says stays local.

Threat model, always: `docs/deployment-context.md` and `docs/design/spe-security.md`.
Linkr runs inside a per-project SPE. Accepted by design, never "fixed": `ide:execute`
means trusted with the instance, user-authored SQL is allowed, tokens in
`localStorage`, no `script-src`, the client-only build has no authentication.

## Where things live

| What | Where | Public? |
|---|---|---|
| This workflow, the disclosure policy | `.claude/skills/security/` | yes |
| Dependency workflow and its decision log | `DEPENDENCIES.md`, `TRIAGE-LOG.csv` (next to this file) | yes: dependency advisories are public already |
| Human overview | `docs/security/README.md` | yes |
| Audit runs, `AUDIT-LOG.md`, branch backups | `.security-audits/` at the root of the **main checkout** (gitignored) | **no** |
| Fixes for Linkr's own vulnerabilities | a local branch `security/<topic>`, in its own worktree | **no**, until the release |

`.security-audits/` exists only in the main checkout (`linkr/`): a worktree does not
get gitignored folders. Always reach it by that absolute path.

## 1. Disclosure policy

A vulnerability in Linkr itself — from an audit, a code review, a report — stays
**local until the release that fixes it has its images on Docker Hub**.

Why: the repository is public (framagit, mirrored on GitHub) and instances only
change when they pull a new image. A fix pushed to `feature/fastapi-backend` names
the flaw, its file and its test, while every deployed instance still runs it — for
as long as the next release takes.

Until that release, nothing public:

- never push the fix branch, nor `git push --all` / `--mirror` (a plain `git push`
  of another branch does not carry it);
- no issue, merge request, comment, `REVIEW-LOG.md` entry, website page or memory
  file describing it;
- code comments and test names state the invariant (*"a non-member never reads a
  workspace's rows"*), never the attack recipe; commit messages stay neutral
  (`Permissions: database access always derives from a workspace`).

**When to release.** Critical and high: a patch release as soon as the fixes and
their tests are ready — do not hold them for the next feature release, the flaw is
exploitable on every instance meanwhile. Medium and low: with the next planned
release; if it is more than about six weeks away, propose a patch release instead.
Propose, the user decides: a release is theirs to call.

**While waiting.**
- Fixes are committed (after the user has reviewed them) on `security/<topic>` in a
  worktree (`npm run worktree:new -- <topic> --branch security/<topic>`).
- Merge the development branch into it regularly so it stays mergeable — pulling is
  fine, only pushing is forbidden.
- A local branch is one copy. After each session:
  `git bundle create "<main checkout>/.security-audits/security-<topic>.bundle" <dev branch>..security/<topic>`.

**At the release** (the `release` skill, before its step 4 so every tier tests the
fixes): merge `security/<topic>` into the release branch, then release as usual. The
fix becomes public in the same push as the tag that builds the images. Once the
images are on Docker Hub, the release notes say that the version carries security
fixes, their severity, and that upgrading is recommended — without a recipe. Mark the
findings `released in vX.Y.Z` in `AUDIT-LOG.md`.

Dependency advisories are public by nature: they follow `DEPENDENCIES.md`, with no
embargo.

## 2. Dependency alerts

Follow [DEPENDENCIES.md](DEPENDENCIES.md): a local scan of the current branch's
lockfiles (`npm audit`, `pip-audit`) first, Dependabot — which only sees the default
branch — second. The `release` skill runs it at every release.

## 3. Full security audit

`code-review` checks a diff against a short checklist (its §1). A whole-codebase audit
is the job of the user-level `security-audit` skill (Cloudflare,
<https://github.com/cloudflare/security-audit-skill>, installed in
`~/.claude/skills/security-audit/`; on a new machine, install it there per its README,
after scanning it as CLAUDE.md requires): multi-agent recon → hunting → adversarial validation →
schema-checked `findings.json`, each run building on the previous ones. It spawns many
agents and is expensive — offer it, never start it unprompted, never at every review.

Offer it when one of these holds:
- a release is coming;
- a review range touched a trust boundary — auth and permissions, the MCP server, code
  execution (plugins, IDE, terminal WebSocket, jobs), import of ZIPs / catalog entries
  / git clones, secrets, Docker and deployment;
- `AUDIT-LOG.md` records no audit for the last few months.

When the user accepts:
- **Scope** it (whole repo, or e.g. `apps/api` + `packages/linkr-mcp`) and give it the
  threat model above, so it does not rate what the SPE covers or what is accepted by
  design.
- **Output directory**: `<main checkout>/.security-audits/run-<N>`, `N` the next
  unused number. The audit skill accepts a directory inside the target only when the
  user chose it and version control ignores it: this is that choice — confirm with
  `git check-ignore -v .security-audits/run-<N>` before starting.
- **Sandbox**: target code runs in Docker (`docker/spe-sim` images) with no network.
  Mount a clean export of the commit (`git archive <sha> | tar -x -C <scratch>`), not
  the main checkout: target code must never see `.security-audits/`.
- **Record** it in `.security-audits/AUDIT-LOG.md`: date, commit, scope, profile,
  counts by severity, output folder. Never in `REVIEW-LOG.md`.

## 4. Fixing findings

Input: `REPORT.md` (read it whole first), `FINDINGS-DETAIL.md` (trace, reproduction,
invariant per medium/high finding), `findings.json`. The run folder is the record of
the audit: read it, never edit it.

- Work in a `security/<topic>` worktree (§1). Report its closing block verbatim, as
  CLAUDE.md requires. No commit before the user has reviewed the diff.
- Batches by severity, high first; stop after each batch with: findings fixed (file
  and line of each fix), tests added and their results, what stays open or needs the
  user's decision (any change of visible behaviour).
- Per finding:
  1. re-read the trace in the current code (the report's line numbers are those of
     the audited commit);
  2. fix where the trust decision is taken, enforcing the stated invariant — the
     report's code changes are sketches, and a first sketch has missed a second path
     before;
  3. add a regression test replaying the audit's scenario (same dummy principal, same
     input) that asserts the refusal, keep the legitimate case green, and check the
     test fails on the unfixed code;
  4. one root cause in several places is fixed once, at the right level — look for
     the siblings the report did not name.
- `NEEDS-VALIDATION.md` leads are not fixed without asking.
- Touching `packages/linkr-format` follows CLAUDE.md's "second home" rule; no version
  number changes.
- Update the finding's status in `AUDIT-LOG.md` (fixed on `security/<topic>`, then
  released in vX.Y.Z).

## 5. Skill and MCP scanning (skillspector)

Scanning a third-party skill or MCP server before installing it is a standing rule
in `CLAUDE.md`, applied by whichever agent installs it — not something this skill
waits to be run for. What belongs here is the release-time check: before a release,
run the same scan (`skillspector scan <path> --no-llm`) on `packages/linkr-mcp`, whose
tool descriptions reach every agent that connects, and on `.claude/skills/`. Cheap,
not a CI gate. skillspector does not look at Linkr's application code: it replaces
neither the audit (§3) nor the review checklist.
