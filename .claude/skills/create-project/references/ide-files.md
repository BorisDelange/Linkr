# Reference — IDE files (Lab › IDE, `scripts/`)

Analysis scripts and notes that appear in the project's **IDE** (Lab › IDE). Each
entry in the spec's `"ide"` array becomes one file; folders in the path are
created automatically as tree nodes.

```json
"ide": [
  {"path": "analysis.py",        "file": "scripts/analysis.py"},
  {"path": "sql/cohort.sql",     "file": "scripts/cohort.sql"},
  {"path": "utils/helpers.r",    "content": "add <- function(x) x + 1\n"},
  {"path": "README.md",          "content": "# Analysis\nHow to run…"}
]
```

## Fields

- **`path`** *(required)* — the file's location in the IDE tree, e.g.
  `analysis.py` or `sql/cohort.sql`. Intermediate folders (`sql/`, `utils/`) are
  created automatically. Do **not** prefix with `scripts/` — the script adds the
  ZIP prefix itself.
- **`content`** *(string)* OR **`file`** *(path relative to spec.json)* — the file
  body. Prefer `file` for real scripts (author them as actual `.py`/`.r`/`.sql`
  files you can lint/read); use `content` for short inline snippets.

## Supported languages / extensions

Language (syntax highlighting) is inferred from the extension. First-class:

| ext | language | ext | language |
|-----|----------|-----|----------|
| `.py` | python | `.md` | markdown |
| `.r` | r | `.json` | json |
| `.sql` | sql | `.yaml`/`.yml` | yaml |
| `.sh` | shell | `.js` / `.ts` | javascript / typescript |
| `.html`/`.css` | html/css | `.txt`/`.csv` | plaintext |

Anything else → plaintext. `.py`, `.r`, `.sql`, `.md` are the ones that matter
for a data project.

## Authoring good scripts

Make scripts **runnable against the project's own datasets**, not toy code:
- A Python script that loads the dataset CSV and reproduces a dashboard KPI, or
  computes something the dashboard doesn't (a regression, a table).
- An R script for a statistical summary or a plot.
- A `.sql` file with example OMOP queries if the project is warehouse-oriented.
- A `README.md` in the IDE explaining how to run them and what each produces.

Reference the dataset by the file name it will have in the workspace. Keep
imports realistic (`pandas`, `numpy`, `matplotlib`; `dplyr`, `ggplot2`).
See `examples/scripts/` for full examples.

## Invariants (mirror entity-io.ts + seed-loader.ts)

- IDE metadata → `scripts/_tree.json` = `IdeFile[]` (`{id, projectUid, name,
  type: 'file'|'folder', parentId, language?, createdAt}`), with `content`
  stripped. Each file's body → `scripts/<path>` at its tree position.
- On import, `buildIdePath` rebuilds each file's path by walking the `parentId`
  chain and prepending `scripts/`. The script's folder/parent wiring matches this.
- There is no synthetic root `scripts` folder node in the tree — top-level files
  have `parentId: null` (the app adds the UI root on load).
