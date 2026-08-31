# Parallel worktrees

Several agents often work on Linkr at once. Sharing a single checkout makes them
collide — one agent's half-finished edit is in the other's `git status`, staging
has to be done path by path, and only one of them can run the app. A git
worktree gives each one its own directory, its own branch, and its own port
pair, off one shared `.git`.

## Creating one

```bash
npm run worktree:new -- agent-a                      # branch feature/agent-a
npm run worktree:new -- agent-a --branch fix/thing   # explicit branch
```

Creates `../linkr-agent-a`, then fills in what a fresh checkout lacks because git
ignores it: `node_modules`, `apps/api/.venv`, the baked seed, `config.local.json`,
and two generated files —

- `apps/web/.env.local` — `WEB_PORT` / `API_PORT` / `VITE_API_URL`, a pair the
  script picked by probing the OS for free ports.
- `apps/api/.env` — copied from the main worktree, with `LINKR_DATA_DIR` pointed
  at a private `.linkr-data/` and `LINKR_CORS_ORIGINS` set to this worktree's
  frontend port.

Ports are allocated **once, at creation**, and then belong to the worktree. A
stable port keeps the app's browser origin stable, and with it the IndexedDB
workspace — reallocating on every launch would silently empty it.

## Running

The same commands as always; they read the worktree's own ports.

```bash
npm run dev:web     # front, on WEB_PORT
npm run dev:api     # uvicorn, on API_PORT, via apps/api/.venv
npm run dev:all     # both, one terminal
```

`npm run worktree:status` lists every worktree, its ports, and whether they
answer right now (probed, not read from a file — a crashed server never shows as
running).

## Removing

```bash
npm run worktree:remove -- agent-a            # keeps the branch
npm run worktree:remove -- agent-a --branch   # deletes it too
```

Refuses to run if the worktree has uncommitted changes. `git worktree remove`
alone will not work here — the copied `node_modules` makes the directory
non-empty, which git treats as an error.

## What is shared, and what is not

Isolated per worktree: the files, the index, `HEAD`, so `git status`, the VS Code
Source Control panel, search and `Cmd+P` only ever show that worktree.

Shared through the one `.git`: commits, branches, stash, remotes. A branch can be
checked out in **one** worktree at a time — this is why parallel agents each need
their own branch, and merge back at the end.

Not shared and not versioned, hence copied at creation: `node_modules`, the venv,
`.env*`, the seed, the SQLite database.

## Notes

- A new worktree checks out the branch **as committed**. Uncommitted work in the
  main worktree — including changes to these very scripts — is not carried over.
- `.vscode/settings.json` gets a per-worktree title-bar tint, so two similar
  VS Code windows are not confused for one another.
- Never point two worktrees at one `LINKR_DATA_DIR`: two backends on a single
  SQLite file, and DuckDB handle conflicts on the same Parquet.
