# Documentation map

For people and agents working on Linkr. End-user documentation lives in
`../linkr-website`, not here.

## Working on the code

| Document | Read it when |
|---|---|
| [conventions.md](conventions.md) | Before writing code |
| [ui-patterns.md](ui-patterns.md) | Before writing any UI: shared components, type scale |
| [testing.md](testing.md) | Choosing, running or adding tests |
| [worktrees.md](worktrees.md) | Running several agents at once |

## How Linkr works

| Document | Content |
|---|---|
| [architecture.md](architecture.md) | As-built reference: navigation, stores, export format, connectors, versioning, fuzzy search |
| [deployment-context.md](deployment-context.md) | Where Linkr sits in a clinical data warehouse. Read before any security or compliance work |

## Folders

| Folder | Holds | A file belongs here when |
|---|---|---|
| [planning/](planning/README.md) | The session planner, plans with open work, the long-term vision | Work is still open. Start at its README |
| [design/](design/) | Rationale of built features | The feature is built and the reasoning is worth keeping |
| [reference/](reference/) | Notes on outside standards and tools: Health-DCAT-AP, eCRF formats and licensing, the shadcn/ui catalogue | It describes something Linkr did not write |

When a plan is finished, move it to `design/` if the code still cites it or its
reasoning is useful; otherwise fold what matters into `architecture.md` and delete it.
