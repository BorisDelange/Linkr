# Authoring Linkr content outside Linkr — format package, writers, MCP

Goal: **create and edit Linkr content without the app** — a project, a dashboard tab,
a script, a plugin — with a tool that guarantees the result is a valid Linkr entity.
An agent (Claude Code, OpenCode, Cursor…) writes an export tree on disk; a validator
tells it what is wrong; it corrects itself and converges on something the app imports
without a warning.

This is a **different product** from the in-app copilot (`docs/planning/ai-agents-plan.md`
Track B). Do not merge them — §1 says why, §2 says what they do share.

---

## 1. Why this is not the in-app copilot

The dashboard copilot already exists and works: `lib/agent/` (loop, tools, prompt) +
`features/projects/dashboard/agent/`. Its architecture is right *for what it does*, and
an MCP server could not replace it:

- its tools run **client-side against the Zustand store**, so a tool call re-renders the
  dashboard exactly like a mouse click — that is what makes changes live;
- an MCP server runs in the *agent's* process. It has no access to the store of an open
  browser tab. None. There is no version of this where MCP drives the live UI;
- in WASM/static mode there is no backend at all to host a server.

So the two coexist:

| | In-app copilot | MCP authoring |
|---|---|---|
| Target | live Zustand store | export tree on disk |
| Surface | dashboard sidebar | any MCP client |
| Deployment | works in WASM | needs Node |
| Failure mode | wrong widget, user sees it and undoes | invalid tree, must be *caught* |

That last row is the whole point of this plan. In-app, the UI constrains what can be
built. Outside, nothing does — hence a validator.

---

## 2. Three blocks, and the one that is shared

The right decomposition (arbitrated 2026-08-25):

| Block | What it owns | Shared? |
|---|---|---|
| **Format** | what a valid entity *is*: schemas, id derivation, pure constructors, validation | **✅ the whole point** |
| **Writer** | serialising an entity to files, and putting bytes somewhere | **partly** — see below |
| **Orchestration** | MCP protocol / agent loop / UI | ❌ never |

### The writer is not fully app-specific

The intuition "the writer differs between MCP and in-app" is right about the *sink* and
wrong about the *layout*. Splitting it in two:

- **Serialising** — "a dashboard is `dashboards/<slug>.json` with this shape, plus an
  entry in `_tree.json` keyed by path" — is format knowledge. **Shared.**
- **The sink** — `fs.writeFile` for the MCP, `JSZip` for the app export, the Zustand
  store + API for live edits — is not. **Pluggable backend.**

If the sink split is allowed to drag the layout with it, the format gets written twice
and the two copies drift. **This already happened**: `.claude/skills/create-project/assets/build_zip.py`
(Python) and `lib/entity-io.ts` (TypeScript) both know how to build a project ZIP, and
nothing keeps them in sync. That drift is the problem this plan exists to end — adding
an MCP without fixing it would make a third copy.

So: one `writeEntity(entity, sink)` where `sink` is `FsSink | ZipSink`.

### Consequence for `add_dashboard_tab`

There is an `add_tab` tool in `lib/agent/dashboard-tools.ts` and there will be an
`add_dashboard_tab` in the MCP. That is **not** a duplicate as long as both are thin
facades over the same `makeTab()` constructor:

```
makeTab({ name, order })  ──▶  Tab            (packages/linkr-format)
   │                                │
   ├── in-app:  ctx.addTab() → store │
   └── MCP:     writeTab(path, tab) → dashboards/<id>.json
```

Each facade is ~15 lines. A format change lands in one place. Today's in-app `add_tab`
calls `ctx.addTab(dashboardId)` then `updateTab()` — it never constructs the shape
itself, so it is already close to this; it is `entity-io.ts` and `build_zip.py` that
carry duplicated shape knowledge.

---

## 3. `packages/linkr-format` — the real deliverable

TypeScript package in the existing npm workspace (`packages/*` is already wired, and
`packages/default-plugins` is precedent). Consumed by `apps/web`, by the MCP server, and
later by the `linkr-public-content` CI.

**Why TypeScript and not Python**: the app is the reference implementation and it is TS.
A Python port would recreate the `build_zip.py` drift by construction. The MCP server is
Node, so it consumes the package natively. (The one existing Python twin — the
patient-dashboard export parity code in `apps/api` — stays as is; it is guarded by
byte-parity golden tests, which is a different, already-solved problem.)

### Contents

```
packages/linkr-format/
  src/
    schemas/        zod schemas, one per entity + shared fragments
      project.ts  dashboard.ts  dataset.ts  plugin.ts  cohort.ts
      sql-collection.ts  etl-pipeline.ts  schema-preset.ts  dq-rule-set.ts
      shared.ts     LocalizedString, EntityLicense, provenance, badges, _tree.json
    make/           pure constructors: input → valid entity, ids derived
      make-project.ts  make-tab.ts  make-widget.ts  make-dataset.ts  …
    validate/       validateProject(tree) → Issue[]  (+ per-entity)
    serialize/      entity → { path, content }[]  — layout only, no I/O
    ids.ts          re-export deterministicId / column-id (already exist and are tested)
```

Nothing here does I/O. That is what makes it usable from the app (browser), the MCP
(Node) and CI alike.

### The validator is the load-bearing piece

Today there is **no** validation: `entity-io.ts` (3484 lines) reads tolerantly by design
(matching the "no complex backcompat, simple tolerant reads" preference), has no
`validate*` function, and there is no declarative schema of the export format anywhere.
The golden tests pin what the app *writes*; nothing checks what arrives from outside.

An `Issue` must be actionable by a model with no access to the codebase:

```ts
interface Issue {
  severity: 'error' | 'warning'
  path: string            // 'dashboards/overview.json'
  pointer: string         // '/tabs/0/widgets/2/config/xColumn'
  code: string            // 'unknown-column'
  message: string         // "Column 'age' not found in dataset 'ds_patients'."
  hint?: string           // "Available: col_age_years, col_sex, …"
  }
```

The `hint` is what closes the self-correction loop — the same mechanism that already
works in-app, where a rejected tool call returns the list of valid ids to the model.

Three classes of check, in increasing value:

1. **Shape** — zod. Required fields, types, enums. Cheap, catches most agent errors.
2. **Referential** — a widget's `datasetFileId` exists, a tab's widgets exist, a
   `_tree.json` path matches a real file, a filter targets a real column. This is where
   hand-authored trees actually break.
3. **Semantic** — the widget config matches its plugin's declared fields; the column id
   is `col_<slug of name>` (deterministic ids are already implemented and tested in
   `lib/column-id.ts`); `appVersion` is readable.

Value beyond the MCP, and this is why it is worth doing regardless:

- **in-app import** — a clear error instead of a half-broken project (the
  `xlsx-content-csv` import bug is precisely this failure mode: an old export lands as an
  empty dataset and the dashboard silently shows "no dataset");
- **CI for `linkr-public-content`** — every default-data repo stays importable;
- **portal build** — fail loudly at build time, not in the user's browser.

---

## 4. `packages/linkr-mcp` — the thin part

A Node process speaking JSON-RPC over stdin/stdout. No HTTP server, no deployment: the
client spawns it.

```json
{ "mcpServers": { "linkr": { "command": "npx", "args": ["-y", "@linkr/mcp"] } } }
```

**SDK note (checked 2026-08-25).** The v2 SDK splits into `@modelcontextprotocol/server`
and `@modelcontextprotocol/client`; the current server API is `McpServer` +
`server.registerTool(name, { description, inputSchema }, handler)` over
`StdioServerTransport`, and a handler returns `{ content: [{ type: 'text', text }] }`
with `isError: true` to hand the model a correctable failure. Two consequences worth
recording now:

- **zod is NOT required in our code.** It ships as a transitive dependency of the SDK,
  but the SDK also exports `fromJsonSchema`, which takes plain JSON Schema and returns
  what `inputSchema` wants — verified against the installed package, not documentation.
  So `@linkr/mcp` declares one dependency and `@linkr/format` stays dependency-free,
  which is what keeps it out of the browser bundle.
- **stdio servers must never `console.log`** — stdout is the JSON-RPC channel. Logging
  goes to stderr.

Every tool is a facade: parse args → call `make*` → call `writeEntity(…, FsSink)` →
`validate` → return the issues as text. **It contains no format knowledge.** If a tool
in this package starts building a JSON shape by hand, the layering has been broken.

### Granularity: spec-first, granular second

Two designs, and the choice is not obvious:

- *one tool per action* (`add_tab`, `add_widget`, `set_layout`…) — natural, but a
  10-widget dashboard costs ~20 round trips, each re-sending the tool definitions. The
  in-app measurement is relevant: tool definitions are ~700 of ~900 prompt tokens.
- *one `write_project(spec)`* — one call, and it matches what `create-project` already
  does with its `spec.json`.

**Decision: spec-first.** `write_project` / `write_entity` take a full spec; granular
tools exist for *editing an existing* tree, where re-emitting the whole spec would be
worse. Both go through the same constructors.

### Tool inventory

**Author**
| Tool | Notes |
|---|---|
| `write_project(spec, outDir)` | the main entry; supersedes `build_zip.py` |
| `write_entity(kind, spec, outDir)` | plugin, cohort, sql-collection, etl-pipeline, schema-preset, dq-rule-set, dashboard |
| `add_dashboard_tab(path, dashboardId, name)` | incremental edit |
| `add_widget(path, tabId, spec)` | " |
| `add_ide_script(path, name, content)` | " |
| `add_dataset(path, csvPath, meta)` | derives columns + `col_<slug>` ids from the CSV |

**Inspect** — without these the agent invents ids and configs
| Tool | Notes |
|---|---|
| `describe_tree(path)` | what exists, with ids — the analogue of in-app `describe_dashboard` |
| `describe_entity_schema(kind)` | required/optional fields for `kind` |
| `describe_plugin(pluginId)` | config fields; reuse the in-app derivation |

**Validate**
| Tool | Notes |
|---|---|
| `validate(path)` | the whole tree or one entity; returns `Issue[]` |

**Not in scope**: talking to a running Linkr instance's API. The MCP writes **files** —
that is what makes "author outside Linkr" true offline, and it produces exactly the tree
shape `linkr-public-content` repos already use, so the normal import path reads it with
no special-casing.

---

## 5. Skills

Agreed: **one generic authoring skill** with one file per element, rather than a skill
per entity. Named `linkr-authoring`, not `create-element` — it covers editing and
validation too, and `create-*` would imply creation only.

```
.claude/skills/linkr-authoring/
  SKILL.md              when to use it; the write → validate → fix loop; MCP setup
  references/
    project.md  dashboard.md  dataset.md  plugin.md  cohort.md
    sql-collection.md  etl-pipeline.md  schema-preset.md  dq-rule-set.md
    ide-files.md
```

Each `references/*.md` covers: what the element is, its files in the export tree, its
required fields, a minimal example, the common mistakes. `SKILL.md` stays short and
routes to the right reference — the pattern `create-project/SKILL.md` already uses well.

**Skill vs schema — the boundary that keeps them from rotting.** The skill must NOT
restate field lists; `describe_entity_schema` returns those from the code, always
current. The skill carries what a schema cannot: *why*, *which element to choose*, and
the loop to follow. A field list copied into Markdown is stale the day the schema moves.

### The two existing skills

- **`create-project`** → becomes a thin wrapper on `write_project`, then `build_zip.py`
  is deleted. This is the moment the Python/TS duplication ends. Keep the skill: "make me
  a demo project" is a distinct, valuable entry point, and its clinical-coherence guidance
  (synthetic data that makes sense) is real knowledge the MCP has no opinion about.
- **`create-plugin`** → **folded into `linkr-authoring`** as `references/plugin.md`
  (arbitrated 2026-08-25). Writing a plugin is the same act as writing a project — an
  author produces files in an entity tree — so a separate skill would force an arbitrary
  choice of entry point. What is specific to plugins is *depth*, not a different
  workflow: `plugin.md` carries the render contract, how the plugin is loaded by the app,
  and the R/Python sides, where `dataset.md` needs a few lines. Field lists still come
  from `describe_entity_schema`, not from the Markdown.

---

## 5b. Security — why the MCP is not a way around Linkr's permissions

Raised 2026-08-25, in the context of hospital deployments holding patient data behind
per-account authorisations. The short answer: **the MCP server cannot reach a Linkr
instance at all**, so it cannot bypass anything. What follows is the reasoning, and the
one real hole that had to be closed.

### It is not connected to Linkr

| | |
|---|---|
| Network access | **none** — no `fetch`, no HTTP client, no socket, in either package |
| Process execution | **none** — no `child_process`, no `exec`, no `spawn` |
| Node builtins used | `fs`, `path`, `os`, `url` — nothing else |
| Talks to a Linkr API? | **no**, by design (§4): it writes files |
| Reads a database? | no |
| Holds credentials? | no |

It is a **file generator**. It turns a spec into JSON and CSV on the author's own
machine. The output then enters an instance through the *normal* import path — which is
authenticated, permission-checked, and unchanged by any of this. Someone who can import a
project could already do so with a hand-written ZIP; the MCP only makes the ZIP easier to
write correctly. It grants no capability its operator did not already have.

Compare with what *would* be a bypass, and is explicitly out of scope: a tool that calls
`/api/v1/...` with a service token, or reads the server's database directly. §4 rules
that out — "**Not in scope**: talking to a running Linkr instance's API" — and that line
is now a security boundary, not only a design preference. If a future tool needs to reach
an instance, it must authenticate **as the user**, carry their permissions, and be
designed as its own decision.

### The trust boundary that does exist

The caller is a language model acting on text it was given — which may include text the
operator did not write (a README, an issue, a CSV). So caller-supplied **paths** are
untrusted input, exactly like tool names are in the in-app copilot.

Probing the server over real JSON-RPC found a genuine directory-traversal hole:
`add_script(file: "../../../ESCAPED.txt")` wrote outside the project. Now closed —
every write resolves through `resolveInside()`, which rejects anything landing outside
the project root, and six tests hold the line (including the `<root>-evil` sibling case
that a naive `startsWith` prefix check would let through). A dashboard *name* carrying a
directory is refused outright rather than merely contained, because a name is never meant
to be a path.

Worth noting the defence in depth worked: the traversal attempt also showed up as a
`missing-file` error from the validator, because the tree referenced a script that was
not there.

### For a hospital deployment

- The MCP runs on the **author's** workstation, not the hospital server. It is a
  development tool, like the `create-project` skill it replaces.
- It never sees patient data: it writes the CSVs an author gives it (synthetic or
  extracted under their own rights) and reads only the tree it wrote.
- Nothing about it needs to be installed on a server. If an institution wants to forbid
  it entirely, not installing it is sufficient — there is no server-side component to
  disable.
- The `LINKR_ALLOW_REMOTE_LLM` guardrail from `ai-agents-plan.md` §2 is unaffected and
  unrelated: that governs an LLM *inside* Linkr seeing clinical data. Here the model runs
  in the author's own agent, on files the author already has.

Residual risk worth naming: a model can be prompted into writing **wrong** content — a
misleading dashboard, a bad script. That is a content-review problem, the same as with
any authored artefact, and is why the output is a git tree that a human reviews and
merges rather than something written straight into a live instance.

## 6. Risks

- **The refactor is the cost, not the MCP.** `entity-io.ts` is 3484 lines and is not
  layered as format/serialise/sink today. Extracting it wholesale would be a large,
  risky change touching every import/export path. → §7 extracts entity by entity, behind
  the golden tests, and starts with pure additions.
- **Ordering trap.** Building the MCP first and the format package "after" guarantees the
  format knowledge lands in the MCP and is never extracted. → validator first, always.
- **This effort is adjacent to an existing debt item**: "Split entity-io.ts
  (~2.5k lines → export/import/clone)" already sits in the planning README. It should be
  *served by* this extraction rather than done twice — align them when scheduling.
- **Zod is a new frontend dependency** (~13 kB gzipped, tree-shakeable). Acceptable for
  what it buys; worth confirming it does not land in the WASM bundle for users who never
  import anything (lazy-load the validator).
- **`describe_plugin` derivation** is currently validated against one manifest only
  (`ai-agents-plan.md` §8 flags it). Widening it is a prerequisite for the MCP's
  plugin tools, not a side quest.

---

## 7. Order

Each step is useful on its own — no step is only a means to the next.

| # | Step | Effort | Standalone value |
|---|---|---|---|
| ✅ 1 | `packages/linkr-format` + schemas for **project + dashboard + dataset + scripts** (hand-written, no dependency — see §3) | M | — |
| ✅ 2 | `validate/` levels 1–3 + 40 unit tests + parity against the app's `column-id.fixture.json` + a CLI | M | catches real import bugs |
| ✅ 3 | Validator wired into `parseProjectZip`, reported after a successful import (warn, never blocks) | S | clear errors instead of silent half-imports |
| ◐ 4 | `serialize/` for project + dataset + dashboard + scripts **done**; wiring `entity-io.ts` to call it is the remaining half | M | starts the split already on the backlog |
| ✅ 5 | `packages/linkr-mcp`: 7 tools over stdio, 15 tests | S/M | **authoring outside Linkr works** |
| ✅ 6 | `linkr-authoring` skill + 6 references | S | usable by any MCP client |
| ✅ 7 | `create-project` → thin wrapper; `build_zip.py` deleted | S | kills the TS/Python duplication |
| 8 | Remaining entities (plugin, cohort, sql-collection, etl, schema-preset, dq) — schema + make + serialize + reference, one at a time | L | each one lands independently |
| 9 | `validate` in the `linkr-public-content` CI | S | default-data repos stay importable |
| 10 | Granular edit tools (`add_dashboard_tab`, `add_widget`, `add_ide_script`) | S | incremental editing of an existing tree |

Steps 1–3 are worth doing **even if the MCP is never built**. That is the test that the
ordering is right.

### Steps 1–2 as built (2026-08-25)

`packages/linkr-format` — no dependencies, no I/O, validation over an `EntityTree`
interface (`FsTree` for Node, `MemoryTree` for tests, a ZIP/store adapter later for the
app). **Zod was not used**: the app has no validation dependency today and ships to the
browser, every check must emit a Linkr-shaped `Issue` with a `hint` anyway, and the
mapping layer that would need is no smaller than the checks themselves.

Verified against the real trees rather than fixtures alone:

| Tree | Result |
|---|---|
| `@Linkr public content/projects/icu-activity-dashboard` | clean — 0/0, as expected from an exporter-written tree |
| `@Linkr public content/projects/icu-mortality-prediction` | **found a real defect**: no `appVersion` (hand-authored, so nothing stamped it) |
| `@Linkr private portal RiCDC/projects/clip-icu` | 0 errors, 140 warnings — wholly legacy (uuids, bare-string names, `col-N`) but structurally sound, which is the correct verdict |
| the same, with 5 defects injected | all 5 caught, each with its JSON Pointer and a `hint` enumerating the valid values |

Two findings that shaped the code:

- **`DatasetFile.name` is a plain string, not a LocalizedString** — it names a file, not
  a label. An early version flagged it and was wrong.
- **Column ids must be validated over the whole ordered list**, not one at a time:
  collision suffixes (`_2`, `_3`) are handed out in header order, so two names
  normalising to one slug are correct in exactly one arrangement. Per-id validation
  accepted them swapped — after which the app re-derives the other id and orphans
  everything pointing at the column.

Repeated issues are folded in the report (`formatIssues`), grouped by code + file +
pointer *shape*: a wholly legacy project emits 140 warnings, which is unreadable
unfolded and hides the few that need a decision.

### Step 3 as built (2026-08-25)

Wired into `parseProjectZip`, so **both** entry points that parse a project ZIP get it —
the import dialog and the git pull. Issues ride on `ParsedProjectZip.validation` and are
reported *after* a successful import: the project is in, the dialog only says what is off
about it. Never blocking, per §4 of the open questions — the reads stay tolerant and a
legacy-but-working export must keep importing.

- `lib/import-validation.ts` adapts a parsed JSZip to `EntityTree`. Only JSON and CSV are
  decoded, and a CSV is **truncated to its header** — the only part the validator reads —
  so a 50 MB dataset is not pulled into memory to check a column list.
- The report reuses `ImportErrorDialog` with a new `variant="warning"` rather than a
  near-identical second dialog (ui-patterns §6: extend, don't fork). Amber with an
  explicit dark variant, matching `no-access-notice.tsx` — the theme has no `warning`
  token, only `destructive`.
- The detail pane shows the same `formatIssues` text the CLI prints, so a report pasted
  from the app and one from CI are comparable.
- A **duplicate** is exempt: its source was just exported by this app, so any issue is one
  the user already saw on the original.

The pull path computes the validation and currently ignores it; surfacing it there is a
small follow-up, not a blocker.

### Steps 4 (half) and 5 as built (2026-08-25)

`serialize/project.ts` in the format package turns a spec into `{ path, content }` pairs
and performs **no I/O** — the sink is the caller's business, which is what lets the MCP
(disk) and a future in-app export (JSZip) share one definition of the layout. The test
that matters is the loop: *what the serializer writes passes the validator*, so the MCP
cannot emit a tree the app would choke on.

`packages/linkr-mcp` is the thin part — 7 tools, one dependency, no format knowledge.
Verified end to end over real stdio JSON-RPC (initialize → tools/list → tools/call), not
just unit tests: a project written from a spec validates clean, and its tree is
structurally identical to `icu-activity-dashboard`, which the app itself produced.

What makes the loop work, and is worth keeping if this is ever rewritten:

- **Column NAMES are accepted wherever an id belongs** and resolved on write (`age` →
  `col_age`). A spec author writes what the data shows; unresolved, the widget renders
  blank with an empty column picker and no error — the same failure the in-app copilot
  hits, handled the same way.
- **Every rejection enumerates the valid alternatives** (`Unknown tab "overview/ghost".
  Known: overview/demographics, overview/outcomes.`), returned as `isError` — a
  correctable failure the model reads, not a server fault.
- **Every mutating tool re-validates** and says whether the tree still holds, so a widget
  placed off-grid is reported the moment it lands rather than at import time.

Remaining half of step 4: `entity-io.ts` still has its own copy of the layout. Wiring its
export path through `serialize/` is what actually removes the duplication — the
serializer existing does not, on its own.

---

## 8. Open questions

1. **Does the MCP ever write a ZIP**, or only a folder? A folder is git-friendly and is
   what the portal and `linkr-public-content` consume; a ZIP is what the import dialog
   takes. Probably folder by default + an `outFormat: 'zip'` option, but confirm.
2. **Where does `packages/linkr-format` get published?** Internal workspace package is
   enough for the app; the MCP distributed via `npx` needs it on a registry (or bundled
   into `@linkr/mcp` at build time — likely simpler).
3. **Does the in-app copilot eventually call the shared constructors?** It should, but it
   is not blocking: its tools already delegate to store actions rather than building
   shapes. Revisit after step 4.
4. **Validation severity on import** — warn or block? Start with warn (tolerant reads are
   a deliberate preference); revisit once the false-positive rate is known.
