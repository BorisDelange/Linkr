---
name: create-plugin
description: Create a new Linkr plugin with R and Python templates. Use this when the user wants to add a new plugin for the Lab (datasets/dashboards) or Warehouse (patient data) scope.
argument-hint: [plugin-name] [scope]
---

# Create a Linkr Plugin

You are creating a new plugin for Linkr. Follow these steps precisely.

## Step 1: Gather requirements

Ask the user for:
1. **Plugin name** (en + fr)
2. **Scope**: `lab` (operates on datasets) or `warehouse` (operates on patient data)
3. **Description** (en + fr)
4. **What the plugin does** — what it computes, what visualization it produces
5. **Config parameters** — what the user should be able to configure
6. **Icon** — suggest a Lucide icon name

If the user provided arguments: `$ARGUMENTS`

## Step 2: Create files

### Directory structure

```
packages/default-plugins/<scope-folder>/<plugin-name>/
├── plugin.json
├── <plugin-name>.py.template
└── <plugin-name>.R.template
```

- Lab plugins go in `packages/default-plugins/analyses/`
- Warehouse plugins go in `packages/default-plugins/warehouse/`

### plugin.json — Manifest

Read the reference file at `.claude/skills/create-plugin/reference.md` for complete examples.

Key rules:
- `id` format: `linkr-analysis-<name>` for lab, `linkr-warehouse-<name>` for warehouse
- `scope`: omit for lab (default), set to `"warehouse"` for warehouse
- `runtime`: always `["script"]`
- `languages`: always `["python", "r"]`
- `needsConceptPicker`: set to `true` if the plugin needs concept selection (warehouse only)
- `configSchema` field types: `boolean`, `number`, `select`, `string`, `column-select`
- `templates`: map language to filename
- All labels must have both `en` and `fr`

### Templates — Python and R

**Template placeholder syntax**: `{{fieldName}}` — replaced at runtime by `resolveTemplate()`.

**Serialization rules** (automatic, do NOT add quotes around placeholders):
- `boolean` → Python: `True`/`False`, R: `TRUE`/`FALSE`
- `number` → `3` (as-is)
- `select`/`string` → Python: `"value"`, R: `"value"` (quotes added by resolver)
- `column-select` (multi) → Python: `["col1", "col2"]`, R: `c("col1", "col2")`

**Lab plugins** have access to:
- `dataset` — a pandas DataFrame (Python) or data.frame (R), injected automatically
- Config values via `{{placeholders}}`

**Warehouse plugins** have access to:
- `person_id`, `visit_occurrence_id`, `visit_detail_id` — patient context variables
- `sql_query(sql_string)` — function to query the active DuckDB database
  - Python: `await sql_query("SELECT ...")` returns a pandas DataFrame
  - R: `sql_query("SELECT ...")` returns a data.frame
- If `needsConceptPicker: true`, two extra variables are injected:
  - `timeline_sql` — pre-built SQL for numeric measurements (or `None`/`NULL` if no concepts)
  - `visit_summary_sql` — pre-built SQL for visit/stay summary

**Python template conventions**:
- Always start with `import matplotlib; matplotlib.use('Agg')` for plotting
- Use `plt.show()` to display figures
- Use `await sql_query(...)` for warehouse plugins

**R template conventions**:
- Start with `library(graphics)` for base R plotting
- Use `sql_query(...)` (no await) for warehouse plugins

## Step 3: Register the plugin

Edit `apps/web/src/lib/plugins/default-plugins.ts`:

1. Add import for the manifest JSON:
```typescript
import <name>Manifest from '@default-plugins/<scope-folder>/<name>/plugin.json'
```

2. Add imports for the templates:
```typescript
import <name>Py from '@default-plugins/<scope-folder>/<name>/<name>.py.template?raw'
import <name>R from '@default-plugins/<scope-folder>/<name>/<name>.R.template?raw'
```

3. Register in `registerDefaultPlugins()`:
```typescript
registerPlugin(
  buildPlugin(<name>Manifest as unknown as Record<string, unknown>, { python: <name>Py, r: <name>R }),
)
```

Place lab plugins with the other lab plugins, warehouse plugins with the warehouse section.

## Step 4: Verify

Run `npx tsc --noEmit` from the `apps/web` directory and fix any TypeScript errors.

## Checklist

- [ ] `plugin.json` has all required fields (id, name, description, version, tags, runtime, languages, icon, configSchema, templates)
- [ ] Labels in configSchema have both `en` and `fr`
- [ ] Templates use `{{placeholder}}` without extra quotes for select/string fields
- [ ] Python template uses `matplotlib.use('Agg')` before `import matplotlib.pyplot as plt`
- [ ] Warehouse plugin uses `await sql_query()` in Python, `sql_query()` in R
- [ ] Plugin is registered in `default-plugins.ts`
- [ ] TypeScript compiles without errors
