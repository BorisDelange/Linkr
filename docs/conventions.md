# Code Conventions

Single source of truth for how code is written in this repo. These describe the **existing** style — when in doubt, match the surrounding code. Referenced from `CLAUDE.md`.

> Goal: the codebase stays readable and modifiable by an AI agent (and a future developer) who has not seen it before. Consistency matters more than any individual rule.

## Universal rules

- **i18n** — every user-facing string goes through `t('key')`. Add the key to **both** `apps/web/src/locales/en.json` and `fr.json`. Keys are dotted and hierarchical (`settings.general`, `patient_data.male`).
- **Path alias** — always `@/` for imports from `apps/web/src/` (`@/lib/utils`, `@/stores/app-store`). Never `../../../`. `@default-plugins/*` maps to `packages/default-plugins/`.
- **No narrating comments** — the default is no comment: name things well and let the code speak. Write one when it earns its place (see [Comments](#comments)), never to restate the line below it.
- **No new `any`** — type it properly. The few existing `any` (e.g. `idb-storage.ts` promise casts, `rehypePlugins: any[]`) are tolerated legacy, not a precedent.
- **No `console.log`** in committed code. `console.error`/`console.warn` are allowed for genuine error logging (see Error handling).
- **No secrets in code** — no API keys, tokens, passwords, connection strings. Config comes from env (backend `LINKR_*`) or `config.local.json` (gitignored).

## File naming

| Kind | Convention | Example |
|---|---|---|
| TS/React files | kebab-case | `format-helpers.ts`, `use-attachments.ts` |
| React components (file) | PascalCase allowed for component files | `PluginEditor.tsx`, `DashboardFilterSidebar.tsx` |
| React exports | PascalCase | `export function PluginEditor()` |
| Hooks | `use-*.ts` file, `useX` export | `use-debounced-value.ts` → `useDebouncedValue` |
| Python | snake_case | `database.py`, `init_db()` |
| API routes (URL) | kebab-case | `/concept-mapping` |

## File size

- **Target < 600 lines per file.** Above ~800, treat it as a refactor signal: extract sub-components, hooks, or helpers.
- Several legacy files exceed this (`MappingsTab.tsx` ~3200, `TargetConceptPanel.tsx` ~2400). Do **not** add to them blindly — when you touch one substantially, prefer extracting the part you change rather than growing the file.

## Comments

**Default: no comment.** A comment is a claim you have to keep true — it can go
stale in a way code cannot, so it must buy more than it costs. Rename the
variable, extract the function, or simplify the branch first; reach for a comment
only when the code genuinely cannot carry the meaning.

**Never narrate.** A comment that restates the line below it is the one kind that
is always wrong: it adds nothing on the day it is written and lies the day the
line changes.

```ts
// Build a colType lookup                          ← delete
const colTypeMap = {}
for (const col of columns) colTypeMap[col.id] = col.type

// Save analysis config                            ← delete, the name says it
const handleSave = useCallback(() => saveAnalysis(analysis.id), [analysis.id])
```

**Write one when it carries what the code cannot.** Six cases:

| Case | Example |
|---|---|
| **Why, not what** — a constraint, workaround, or decision that looks arbitrary until explained | `// Start at 2: the untouched base name is conceptually the first one.` (`lib/unique-name.ts`) |
| **A surprising invariant** a future edit would silently break | `// Collected, not swallowed: a failed row must not read as a successful pull.` (`lib/etl-pull.ts`) |
| **Domain or spec fact** not derivable from the code — OMOP/CDM rules, locale conventions, an external API's behaviour | `// CDM 5.4 has no value_as_string on measurement — that column exists on observation only.` (`lib/schema-presets.ts`) |
| **Opaque by nature** — a regex, dynamically-built SQL, encoding maths. A one-line summary of what it *produces* is a legitimate reading aid, even though it describes the what | `// Matches a CSI SGR sequence: ESC [ <params> m` (`lib/ansi.ts`) |
| **Contract on exported API** — defaults, units, what a caller must not pass. JSDoc on a shared component's props shows at every call site, so it reaches readers who never open the file | the prop docs in `components/ui/concept-data-table.tsx` |
| **Section banner** in a long file — navigation, not description. Earns its place over a region of a hundred-plus lines, not over six | a `// ----` rule with a title, as in `lib/format-helpers.ts` |

**Deferred work gets a tag**, so it is greppable: `// TODO(scope): what and why`.
Prose like "for now we skip this" is invisible to `grep TODO` and rots in place.
Do not leave commented-out code — git remembers it.

**On review**, the question is not "is this commented enough?" but "would deleting
this comment lose anything?" If not, delete it.

## Imports — order

1. React + third-party (`react`, `react-router`, `react-i18next`)
2. Icons (`lucide-react`)
3. UI components (`@/components/ui/*`)
4. Lib utilities (`@/lib/...`)
5. Stores (`@/stores/...`)
6. Local/relative (`./Foo`)
7. Type-only imports (`import type { X } from '@/types'`)

## React components

Structure, top to bottom:

```tsx
// imports (see order above)

interface FooProps {        // PascalCase + `Props` suffix, named interface
  value: string
  onChange: (v: string) => void
}

const SOME_CONST = ...      // module consts before the component

export function Foo({ value, onChange }: FooProps) {
  const { t } = useTranslation()          // hooks first
  const items = useStore((s) => s.items)  // store selectors
  const [open, setOpen] = useState(false) // local state
  const debounced = useDebouncedValue(value, 300) // custom hooks

  useEffect(() => { /* ... */ }, [/* deps */])

  const handleClick = () => { /* handlers after hooks */ }

  return ( /* JSX */ )
}
```

- Props: named `interface` ending in `Props`. Destructure in the signature.
- Hooks block first, then effects, then handlers, then `return`. Don't interleave.
- Never build UI before checking what exists: **`docs/ui-patterns.md`** for our composed components (tables, dialogs, page shells, fields) and the working rules, then `docs/shadcn-components.md` for the upstream primitive catalogue.

## Dialogs (modals)

**Use `DialogShell`, not raw `Dialog` parts.** It supplies the width, header,
footer and busy state for the three dialog kinds (`form` / `settings` /
`workbench`), so a new modal cannot drift from the others. Full guidance —
kinds, widths, reference implementations, shared-dialog call sites →
**`docs/ui-patterns.md` §3**, which is the single source of truth for dialogs.

Only the two rules with consequences beyond styling live here:

- **Editing a shared dialog changes it everywhere.** Before restyling one, check
  its other call sites; if only the wording should differ, take a mode prop and
  switch the i18n keys (`ImportConceptSetDialog`'s `dictionaryMode`) instead of
  touching its styling.
- **A destructive action always goes through a confirm `AlertDialog`** — never
  fires straight from the click.

## Zustand stores

- `create<State>((set, get) => ({ ...state, ...actions }))`.
- State and actions live in the same object; state props are declarative, actions are camelCase.
- Persistence is **fire-and-forget**: mutate optimistically with `set(...)`, then call `storage.X.update(...)` async, `.catch((e) => console.warn(...))` on failure. The UI does not wait on persistence.
- Boolean load flags (`loaded`, `pipelinesLoaded`) gate first render; set them `true` even if the initial IDB load fails (degrade, don't block).
- See `stores/pipeline-store.ts` (simple CRUD), `stores/dashboard-store.ts` (cascade deletes), `stores/catalog-store.ts` (state recovery/migration) as references.

## Custom hooks

- `use-*.ts` file, `useX` export. Generic and reusable where possible.
- Return a **destructurable object** (`{ data, loading, reload, ... }`), not a positional tuple, unless mirroring a built-in hook shape.
- Own your side effects: revoke blob URLs, clear timers, remove listeners in the effect cleanup (`use-attachments.ts`, `use-mobile.ts`).
- **Re-check your guard after every `await`.** A condition read before an async
  call — a render-time closure value, or a caller's check one frame earlier — is
  stale by the time the result lands, and the write that follows clobbers
  whatever changed meanwhile. Read the live value (`useStore.getState()`, not the
  closure), re-assert the identity you loaded for (`activeId`, `sameProject`)
  *after* the await and bail if it moved, and give any effect that can re-fire a
  `cancelled` flag or a sequence token so the slower response loses.

## Error handling

Current convention is **context-dependent** — keep it consistent within each context:

| Context | Pattern |
|---|---|
| Non-critical parse (JSON, optional config) | `catch { /* ignore */ }` |
| Async data load for UI | `catch (err) { console.error(...); setDefaultState() }` — log + degrade, never throw into render |
| Store persistence | `.catch((e) => console.warn(...))` — fire-and-forget |
| Store initial load | `catch` → still set `loaded = true` so the app boots |

- Never let an unhandled rejection reach the user as a blank screen. Prefer a degraded but rendered state.
- When you add a genuinely user-facing failure, surface it (and add an i18n key) rather than swallowing it silently.

Three failure modes recur often enough to be rules of their own:

- **Never `.catch(() => {})` a write that something downstream believes
  happened.** A swallowed sync anchor or file write makes the caller report
  success and buries the real state. If a `try/catch` already surrounds the call,
  let it propagate.
- **A failed re-run must drop the previous result**, not leave it rendered.
  Delete the stale entry in the `catch` — an error shown only `if (!result)` is
  invisible after a first success, which is exactly how a "fixed" silent failure
  came back.
- **Every early `return` inside a `try` must still clear its spinner.** Throw a
  sentinel and let the existing `catch`/`finally` do it, rather than returning
  past the reset and leaving the button turning for ever.

## SQL safety (DuckDB-WASM)

This is security-critical because user data and user-authored SQL meet here.

- String literals: wrap with `escSql()` from `@/lib/format-helpers` (escapes `'`, `\`, NUL).
- Column/table names from dynamic input: validate with `isSafeIdentifier()` before interpolation.
- Numeric ID lists for `IN (...)`: validate with `validateIntegerIds()` first.
- OMOP queries: always match both `_concept_id` **and** `_source_concept_id` (OR), per `docs/architecture.md`.
- Fuzzy search: use `buildFuzzySearchSql()` from `@/lib/fuzzy-search` — see `docs/fuzzy-search.md`.

### Validate at the trust boundary, not at the sink

Every exportable entity is also **importable** — from a ZIP, a git clone, a pull,
the catalog, or the seed loader. Anything read back from storage is therefore
attacker-supplyable, however developer-authored it looked when it was written.
This assumption has broken four separate times; the list above was in this file
for all four, because it says which helper to call and never says *where*.

- **Validate once, where untrusted data enters — not at each sink.** One builder
  had ~100 interpolation sites; guarding them individually leaves the next one
  to be written unguarded. `sanitizeSchemaMapping()` (`lib/schema-helpers.ts`) is
  the model to copy.
- **Gate on load as well as on save.** Import, pull, catalog install and the seed
  loader all write storage directly, bypassing the store's own save method — a
  save-only gate catches none of them.
- **Cover every shape the field can take.** `string`, `string[]` and
  `Record<string, string>` have each been the hole in turn; matching the field
  *name* is not enough if you only handle two of its three shapes.
- **A rejected value is dropped, never widened.** Returning an unfiltered clause
  when an operator fails validation turns a rejected filter into no filter.
- A documented rule with zero call sites is worse than no rule: it reads as a
  guarantee. If you add a validator, wire it in the same change.

## Sanitization

- Any `dangerouslySetInnerHTML` MUST go through `sanitizeHtml()` from `@/lib/sanitize`. No raw user/plugin HTML into the DOM. (Existing usages already wrap; keep that invariant.)

## Export twins (front ⟷ back)

Several exporters exist twice: a TS builder (`lib/entity-io.ts`, `lib/export.ts`)
and a byte-faithful Python twin (`services/project_export.py`,
`workspace_export.py`, …). They must write the **same bytes**, or a mixed-mode
team churns a phantom git diff on every push. This is the most frequently
recurring defect class in this repo's review history.

- **Touch one twin, touch the other in the same change**, and add the case to the
  golden fixture in `__fixtures__/export-golden/`. A fix that isn't in a fixture
  is invisible to the next person.
- The divergences that keep recurring: whole floats (`100.0` vs `100`), absent
  keys (`JSON.stringify` drops `undefined`, `json.dumps` emits `null` — omit on
  both), sort order (JS compares UTF-16 code units, Python code points), and
  tolerance (a malformed entry one side `continue`s past must not throw on the
  other).
- A fixture that doesn't carry the awkward shape proves nothing. Put the empty
  collection, the second attachment, the duplicate name in the fixture.

**A third reader now exists**: `packages/linkr-format/` describes the same shapes as
schemas, and validates trees written by hand or by an agent. It is not a byte twin — it
*reads* the format rather than writing the app's version of it — but the same rule
applies: **change what an export writes, teach the format package about it in the same
change.** The failure is quiet: the validator keeps passing while the new field goes
unchecked, or a legitimate tree starts reporting an issue that is really a stale schema.
Point the CLI at the golden fixtures to check
(`npx tsx packages/linkr-format/src/node/cli.ts apps/web/src/lib/__fixtures__/export-golden/<kind>/expected`).

## Sort before you serialize or paginate

DB iteration order, an IDB index and a `Set` are all arbitrary. Anything that
becomes bytes, an id, or a page window needs an explicit total order:

- **Every exported list carries an `ORDER BY` / `.sort()` on both engines**, and
  a collision suffix (`name#2`) is assigned **after** the sort — assigning it
  during the pre-sort pass makes two same-named rows swap ids between exports.
- **Every paginated SQL query ends with a unique tiebreak column**
  (`… ORDER BY record_count DESC, concept_id ASC`). DuckDB parallelises, so
  without one the same row can appear on two pages and another on neither.
- Sort on the raw code point (`a < b ? -1 : 1`), not `localeCompare` and not a
  `sensitivity: 'base'` collator: both return 0 for values that differ, silently
  reopening the tie the sort exists to close.

## Wire a change into every sibling

Most features here exist once per scope — 9 exportable entity types, 6 provenance
scopes, 4 file trees, 2 pull scopes, and a client builder beside a server one. A
guard, field or helper added to one and not the rest is worse than absent: the
badge, docstring or commit message then asserts a behaviour that holds in one
place only.

Before finishing, grep the new symbol and count its call sites against the
sibling set. If the count is short, either wire the rest or write down, next to
the one you skipped, why that scope is genuinely different.

## Backend (FastAPI)

- Routers: `APIRouter(prefix="/things", tags=["things"])`, kebab-case URLs.
- Async throughout: `async def`, `Depends(get_db)` → `AsyncSession`.
- Models: SQLAlchemy 2.0 style — `Mapped[T] = mapped_column(...)`. i18n names stored as JSON columns.
- Config: Pydantic `BaseSettings`, env prefix `LINKR_`.

## Quality gates (all blocking)

CI (`.gitlab-ci.yml`) and the pre-push hook (`scripts/git-hooks/pre-push`) both
enforce three gates. All are at zero and must stay there:

- `npm run test` — Vitest suite (must pass)
- `npm run lint` — ESLint **errors** = 0 (warnings allowed; mostly React Compiler
  rules kept as warnings since the compiler isn't enabled — see eslint.config.js)
- `npm run typecheck` — `tsc -b` clean (from `apps/web`; there is no root script,
  and the hook runs it there)

Don't reintroduce errors. If a change legitimately needs a type escape, prefer
`as unknown as T` with a one-line WHY over `as any`; never add `@ts-ignore`.

## Plugins — versioning

Every plugin carries a `version` in its `plugin.json` (under
`packages/default-plugins/<scope>/<name>/`). When a change modifies a plugin's
behaviour (template logic, config schema, manifest), **bump that plugin's
`version` in the same change** — otherwise a new build ships under an unchanged
version and the two are indistinguishable. Use semver: patch for fixes, minor
for new config/behaviour, major for breaking template/config changes.

## Commits

Write commit messages **in English**, even though the team discusses the code in
French. Format: `Scope: short imperative description`, with an optional `(#issue)`
suffix when it closes/relates to an issue — e.g. `Dashboard: uniform gutters (#42)`.
Keep the subject concise; put extra detail in the body if needed.

## Tests

See `.claude/skills/write-tests/SKILL.md`. Short version:

- Test **pure, critical logic** (SQL escaping/validation, OMOP query builders, fuzzy-search, import/export, format helpers). These contracts are stable.
- Do **not** unit-test volatile React components — they churn every iteration and the tests rot. Cover them via manual/E2E checks instead.
- When you change a tested function, update its test **in the same change**. A test is part of the contract, not a separate chore.

Two rules the review log keeps re-learning:

- **Test the input that breaks it, not the one that works.** A builder tested
  only on valid data proves nothing about its escaping, and a golden fixture
  whose values are all safe passes whether or not the guard exists. Add the
  adversarial string, the duplicate name, the empty list.
- **Watch a new test fail before you trust it.** Revert the fix, run the test,
  confirm it goes red, restore. A test written after the fix and never seen red
  routinely asserts something the fix didn't change — including tests that look
  like they cover the bug and don't.
