---
name: create-project
description: Generate a ready-to-import Linkr project ZIP — a project with synthetic dataset(s), a wired dashboard (KPIs + charts + filters), IDE analysis scripts (.py/.r/.sql/.md), and README/tasks, assembled into the importable project ZIP format. Use when the user wants a demo project, sample data, a dashboard, or analysis scripts built from scratch to drag into the app.
argument-hint: [theme] [n-rows]
---

# Create an importable Linkr project

You build a **project ZIP** the user imports via "Import a project" in the app.
You never touch app source code — the output is a data artifact.

All mechanical ZIP assembly (col-N ids, tree/parent ids, 48-col grid layout,
`appVersion`, IDE `scripts/` layout, `.gitignore`) is owned by
`assets/build_zip.py`. Your job is to author **CSV(s)**, optional **IDE script
files**, and **one `spec.json`**, then run the script.

## What a project ZIP can contain

| Brick | In ZIP? | This skill | Reference |
|-------|---------|-----------|-----------|
| Project metadata (name, description, badges) | ✅ | ✅ | `references/project-meta.md` |
| README + tasks (todos/notes) | ✅ | ✅ | `references/project-meta.md` |
| Datasets (CSV → table) | ✅ | ✅ | `references/datasets.md` |
| Dashboards (8 built-in widgets: KPI, plot, table1, correlation, stat-tests, regression, Kaplan-Meier, map, sankey + inline code + filters) | ✅ | ✅ | `references/dashboards.md` |
| IDE files (`.py` / `.r` / `.sql` / `.md` in Lab › IDE) | ✅ | ✅ | `references/ide-files.md` |
| Cohorts, DB connections, pipelines | ✅ | ❌ (out of scope) | — |
| **Patient Data page** | ❌ | ❌ **impossible** | see below |

**Patient Data is NOT seedable.** It is computed live by SQL against a connected
OMOP database (`features/…/patient-data/use-patient-data.ts`); there is no
patient-data payload in the ZIP. The only way to populate it is a real OMOP
database + connection + schema mapping — outside the scope of a synthetic-data
project. If the user asks for it, say so and offer an OMOP-shaped dataset instead.

## Workflow

1. **Gather requirements** — theme/clinical domain; what indicators/charts;
   whether they want IDE analysis scripts; row count (default ~200); languages
   (name/description are `{en, fr}` — fill both).
2. **Author the CSV(s)** — one per dataset, clinically coherent. → `references/datasets.md`
3. **Author IDE files** (if requested) — real `.py`/`.r`/`.sql`/`.md`. → `references/ide-files.md`
4. **Author `spec.json`** — read the reference for each brick you use. Start from
   `examples/spec.json` (a complete, working example).
5. **Build**: `python3 .claude/skills/create-project/assets/build_zip.py spec.json <slug>.zip`
6. **Verify & hand off** — see below.

## spec.json at a glance

```json
{
  "appVersion": "2.0.20",
  "project":   { … },        // references/project-meta.md
  "ide":       [ … ],        // references/ide-files.md  (optional)
  "datasets":  [ … ],        // references/datasets.md
  "dashboards":[ … ]         // references/dashboards.md
}
```

The full field reference is also in the docstring at the top of `assets/build_zip.py`.
`examples/spec.json` + `examples/*.csv` + `examples/scripts/` are a runnable set —
copy and adapt rather than starting blank.

## Step 6 — Verify and hand off

- `unzip -l <out>.zip` should show `project.json`, `datasets/<name>/_data.json`,
  `dashboards/<name>.json`, and (if you added IDE files) `scripts/_tree.json` +
  each `scripts/<path>`.
- Validate JSON:
  `python3 -c "import json,zipfile;z=zipfile.ZipFile('out.zip');[json.loads(z.read(n)) for n in z.namelist() if n.endswith('.json')];print('ok')"`
- Tell the user the ZIP path and that they import it via the project import flow.
  Every id is regenerated on import, so re-importing makes a fresh copy.

## Format invariants (do not break)

These mirror `apps/web/src/lib/entity-io.ts` (`buildProjectZip` / `parseProjectZip`)
and `seed-loader.ts`. If that file's layout changes, update `build_zip.py` to match.
The per-brick reference files document each invariant next to the brick it governs.
