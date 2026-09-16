# Contributing to Linkr

Thanks for being here. Linkr is built for clinicians and researchers who work with health
data, and the most useful contributions often come from the people who actually use it —
not only from developers.

## You do not have to write code

These are genuinely valuable, and usually the fastest way to help:

- **Report a bug.** What you did, what you expected, what happened instead. A screenshot
  and your Linkr version (shown in the status bar, bottom of the window) are usually enough.
- **Tell us something is confusing.** If a screen made you hesitate, that is a bug in the
  interface, and we want to know.
- **Describe your use case.** A workflow Linkr does not support yet, or supports awkwardly,
  is worth an issue even without a proposed solution.
- **Improve the documentation.** It lives in its own repository and is published at
  [linkr.interhop.org](https://linkr.interhop.org/en/docs/).

## Where to open an issue

Either works, whichever you already have an account on:

- [FramaGit](https://framagit.org/interhop/linkr/linkr) — where development happens
- [GitHub mirror](https://github.com/BorisDelange/Linkr)

**Please do not report a security vulnerability in a public issue.** Open a *confidential*
issue on FramaGit instead (tick "This issue is confidential" when creating it), and we will
handle it privately.

⚠️ **Never paste real patient data** into an issue, a screenshot or a sample file — not even
partially de-identified. Reproduce the problem with the demo data if you can, or describe the
shape of your data rather than showing it.

## Contributing code

### Set up

You need Node.js 20+ and Python 3.12+. From the repository root:

```bash
npm install
python3 -m venv apps/api/.venv
source apps/api/.venv/bin/activate
pip install -e "apps/api[dev]"

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Put a real key in `apps/api/.env` — the backend refuses to start on the example one:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

### Run it

One command starts both sides, in the same terminal, each log line prefixed with its source:

```bash
npm run dev:all
```

Frontend on http://localhost:3000, API on http://localhost:8000 (interactive API docs at
`/docs`). Wait for `Uvicorn running` and `VITE ready`, then open the frontend. `Ctrl+C` stops
both. Hot reload is on for the frontend and the backend, so most changes appear without a
restart.

To follow one side on its own, or restart one without the other, use two terminals:

```bash
npm run dev:api     # terminal 1
npm run dev:web     # terminal 2
```

`npm run dev:client` forces client-only mode for a single run, without touching
`.env.local` — handy to check how a feature degrades with no backend.

`npm install` also installs the git hooks, which run the quality gates before every push.

### The three gates

All three must pass, and the pre-push hook enforces them locally:

```bash
npm run test                            # Vitest — the suite stays green
npm run lint                            # ESLint — 0 errors (warnings are tolerated)
cd apps/web && npm run typecheck        # tsc -b — 0 errors
```

`git push --no-verify` bypasses them. It exists for emergencies; a merge request that needs
it is a merge request that is not ready.

### Conventions

Linkr's conventions live in the repository, not in this file — a copy here would drift from
them, and the copy is what would end up wrong. Read them before you write code:

- **[`docs/conventions.md`](docs/conventions.md)** — naming, imports, comments, error
  handling, SQL safety, export twins, the quality gates. Start here.
- **[`docs/ui-patterns.md`](docs/ui-patterns.md)** — before writing any screen: which shared
  component to reuse rather than rebuild, and the type scale.
- **[`docs/architecture.md`](docs/architecture.md)** — how the pieces fit: stores, navigation,
  the export format, OMOP patterns, the dual client-only / full-stack deployment.
- **[`CLAUDE.md`](CLAUDE.md)** — the condensed version of all three, kept current. The
  fastest way to get the rules that matter most.

Two that catch almost everyone out: every user-facing string goes through `t('key')` with
the key added to **both** `en.json` and `fr.json`, and **nothing reaches SQL unescaped** —
`docs/conventions.md` § SQL safety explains which helper to use for a value, a name, or a
list of ids.

### Working with Claude Code

The repository is set up for [Claude Code](https://claude.com/claude-code), and you do not
have to use it — but if you do, most of the project's knowledge is already wired in:

- **`CLAUDE.md`** is loaded automatically, so the conventions above are applied without
  being asked for.
- **Skills** in `.claude/skills/` carry the real procedure for the recurring jobs. The ones
  that matter when contributing: **`/code-review`** (a structured quality + security pass
  over your changes, logged in the repo), **`/write-tests`** (what is worth a test here and
  what is not), and **`/update-website-docs`** when your change alters a documented
  workflow. The others author Linkr *content* rather than the app itself.
- **Parallel work** — `npm run worktree:new -- my-task` gives an agent its own worktree,
  branch and free port pair, so two sessions do not fight over ports 3000/8000 or over each
  other's uncommitted files. Details in [`docs/worktrees.md`](docs/worktrees.md).

Contributions written with an agent are welcome on the same terms as any other: you are
responsible for what you submit, the gates apply unchanged, and a merge request should say
what you verified rather than what a tool claimed.

### Merge requests

- One concern per merge request — easier to review, easier to revert.
- Commit messages in English, in the imperative: `Datasets: keep the edit journal beside its
  data file`. Say **why** in the body when the change is not obvious; that is what reviewers
  and future readers actually need.
- Say how you tested it. "Ran the suite" is fine for a pure refactor; a UI change deserves a
  sentence on what you clicked, and a screenshot if something moved.
- A draft MR asking "is this the right direction?" is welcome, and often saves everyone time.

## Licence

Linkr is free software under the **GPL-3.0**. By contributing, you agree that your
contribution is licensed under the same terms.
