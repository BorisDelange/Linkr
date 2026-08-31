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
- `apps/api/.env` — copied from the main worktree, with `LINKR_CORS_ORIGINS` set
  to this worktree's frontend port and `LINKR_DATA_DIR` pointed at a private
  `.linkr-data/` **cloned from the main one**, so the app opens on the real
  projects and databases while its writes stay local. On APFS this is a
  `cp -c` clone: instant, and costing no disk until the two diverge.

Ports are allocated **once, at creation**, and then belong to the worktree. A
stable port keeps the app's browser origin stable, and with it the IndexedDB
workspace — reallocating on every launch would silently empty it.

## Running

One VS Code terminal per worktree, front and back together:

```bash
cd ../linkr-agent-a && npm run dev:all
```

`dev:web` and `dev:api` still exist if you want them in separate terminals — for
instance to restart the backend without losing the frontend's HMR state. All
three read the worktree's own ports.

`npm run worktree:status` lists every worktree, its ports, and whether they
answer right now (probed, not read from a file — a crashed server never shows as
running).

## Seeing the files

The worktrees live next to the repo, as sibling directories:

```
Programming projects/
├── linkr/                ← main worktree
├── linkr-agent-a/        ← branch feature/agent-a
└── linkr-agent-b/        ← branch feature/agent-b
```

To review an agent's work without leaving your window, *File › Add Folder to
Workspace…* on its directory: it gets its own Source Control section, listing
only its changes. Beware that `Cmd+P` and `Cmd+Shift+F` then span every folder in
the workspace, so each hit shows up once per worktree — remove the folder again
once the branch is merged.

From a terminal, without adding anything to the workspace:

```bash
git -C ../linkr-agent-a status
git -C ../linkr-agent-a diff
git diff feature/fastapi-backend...feature/agent-a   # branches are shared
```

## Merging back

An agent commits on its own branch, inside its own worktree — `git add -A` is
safe there, since it cannot see anyone else's files. Commits live in the shared
`.git`, so they are visible from the main worktree the moment they are made:

```bash
git log --oneline feature/agent-a
git diff feature/fastapi-backend...feature/agent-a
```

**The merge happens from the main worktree**, not from the agent's: git refuses
to check out a branch that is already checked out elsewhere.

```bash
git merge feature/agent-a
npm run worktree:remove -- agent-a --branch
```

The other direction — pulling recent main-branch commits *into* a worktree — is
the agent's to run, from its own directory: `git merge feature/fastapi-backend`.
Worth doing when the branch has been open a while, since the worktree started
from whatever commit was current at creation.

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
- Never point two worktrees at one `LINKR_DATA_DIR`: two backends on a single
  SQLite file, and DuckDB handle conflicts on the same Parquet.
- The data dir is cloned as-is. Creating a worktree while the main backend is
  mid-write can capture a torn SQLite file — the original is never at risk, but
  the copy may need a re-clone. Prefer creating worktrees with the app stopped.
- Each worktree costs a full checkout plus the copied `node_modules` and venv —
  several GB. Remove it once its branch is merged.
