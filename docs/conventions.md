# Code Conventions

Single source of truth for how code is written in this repo. These describe the **existing** style — when in doubt, match the surrounding code. Referenced from `CLAUDE.md`.

> Goal: the codebase stays readable and modifiable by an AI agent (and a future developer) who has not seen it before. Consistency matters more than any individual rule.

## Universal rules

- **i18n** — every user-facing string goes through `t('key')`. Add the key to **both** `apps/web/src/locales/en.json` and `fr.json`. Keys are dotted and hierarchical (`settings.general`, `patient_data.male`).
- **Path alias** — always `@/` for imports from `apps/web/src/` (`@/lib/utils`, `@/stores/app-store`). Never `../../../`. `@default-plugins/*` maps to `packages/default-plugins/`.
- **No narrating comments** — a comment explains a non-obvious WHY (hidden constraint, workaround, surprising invariant), never WHAT the code does. If the code reads clearly, no comment.
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

## SQL safety (DuckDB-WASM)

This is security-critical because user data and user-authored SQL meet here.

- String literals: wrap with `escSql()` from `@/lib/format-helpers` (escapes `'`, `\`, NUL).
- Column/table names from dynamic input: validate with `isSafeIdentifier()` before interpolation.
- Numeric ID lists for `IN (...)`: validate with `validateIntegerIds()` first.
- OMOP queries: always match both `_concept_id` **and** `_source_concept_id` (OR), per `docs/architecture.md`.
- Fuzzy search: use `buildFuzzySearchSql()` from `@/lib/fuzzy-search` — see `docs/fuzzy-search.md`.

## Sanitization

- Any `dangerouslySetInnerHTML` MUST go through `sanitizeHtml()` from `@/lib/sanitize`. No raw user/plugin HTML into the DOM. (Existing usages already wrap; keep that invariant.)

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
- `npm run typecheck` — `tsc -b` clean

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
