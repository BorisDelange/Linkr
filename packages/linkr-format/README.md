# `@linkr/format`

What a valid Linkr entity **is**: schemas, id derivation and validation, with no
I/O and no dependencies — so the same rules serve the app (browser, including the
WASM build), the MCP authoring server (Node) and CI.

Design and roadmap: [`docs/planning/mcp-authoring-plan.md`](../../docs/planning/mcp-authoring-plan.md).

## Validate a project tree

```bash
npx tsx src/node/cli.ts <project-dir> [<project-dir>…]
```

Exits `1` when any tree has an **error**; warnings alone exit `0`, so it drops
straight into CI for the `linkr-public-content` repos.

```
ERROR dashboards/clip-mir.json/widgets/1/source/config/column
    [unknown-column] Column "col-999" does not exist.
    hint: columns in this dataset: col-0, col-1, col-2, … (+55)
```

Every issue carries the file, a JSON Pointer, a stable `code`, and — where the
alternatives can be enumerated — a `hint` listing them. The hint is what lets an
agent authoring a tree correct itself without reading this repo.

## From code

```ts
import { validateProject, formatIssues, hasErrors } from '@linkr/format'
import { FsTree } from '@linkr/format/node/fs-tree'

const issues = validateProject(new FsTree('/path/to/project'))
if (hasErrors(issues)) console.error(formatIssues(issues))
```

In the browser (or a test), implement `EntityTree` over whatever holds the files —
`MemoryTree` is provided:

```ts
import { MemoryTree, validateProject } from '@linkr/format'

validateProject(new MemoryTree({ 'project.json': '…' }))
```

## What is checked

| Level | Examples |
|---|---|
| **Shape** | required fields, types, enums, localized names |
| **Referential** | a widget's tab, dataset and columns exist; filters point at real columns and tabs; scripts listed in `_tree.json` are present |
| **Semantic** | column ids derive from column NAMES in order (including `_2` collision suffixes); layouts fit the grid; the CSV header matches the declared columns |

Two link styles are accepted, because both are in the wild and the app reads
both: content **keys** (`key`/`parentKey`/`tabKey`, current and git-stable) and
legacy **uuids** (`id`/`parentTabId`/`tabId`). A file **mixing** the two is an
error — the import resolves links per record, so a keyed widget cannot find an
id-only tab and lands in no tab at all.

Legacy-but-consistent trees report `legacy-format` **warnings**, never errors:
they import correctly today, and the reads are deliberately tolerant.

## Testing

```bash
npx vitest run
npx tsc --noEmit
```

`ids.parity.test.ts` runs the app's **own** `column-id.fixture.json` — the same
fixture that already guards the TypeScript ↔ Python pair. `columnId` is currently
duplicated here (see `src/ids.ts`); that test is what keeps the copy honest until
step 4 of the plan makes the app import from this package and deletes its copy.
