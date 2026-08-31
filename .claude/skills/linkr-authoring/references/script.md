# IDE script

A `.py` / `.r` / `.sql` / `.md` file under `scripts/`, shown in Lab › IDE.

Fields: `describe_entity_schema("script")`.

## The tree is what the import reads

A file present on disk but absent from `scripts/_tree.json` never appears in the IDE.
`add_script` writes both; if you create files another way, the validator flags the
orphan.

## Writing scripts that run

Scripts execute in the project's managed environment (uv for Python, renv for R), not in
your shell. So:

- **load data from the datasets**, do not re-invent it inline — through the `linkr`
  library, never a path you built yourself (below);
- prefer the standard library and the packages the project declares — an import that is
  not installed fails at run time, and nothing in the tree declares dependencies for you;
- reference dataset columns by their **id** (`col_age`): the physical column key is the
  id, on the client and the server alike;
- keep a script runnable end to end. A demo script that errors halfway is worse than a
  shorter one that finishes.

Number them (`01_extract.sql`, `02_build.py`) when order matters — it is the only cue a
reader gets.

## Reaching the project: the `linkr` library

A script gets its directories and its databases from `linkr`, which is importable in
every project without being declared — including one whose environment was never built.

```r
library(linkr)
library(DBI)                 # declared in the project environment, unlike linkr

stays <- read.csv(file.path(linkr_datasets_dir(), "stays.csv"))
con <- linkr_connect("MIMIC-IV")
on.exit(dbDisconnect(con, shutdown = TRUE))
```

```python
import linkr
import pandas as pd          # declared in the project environment, unlike linkr

stays = pd.read_csv(linkr.datasets_dir() / "stays.csv")   # datasets_dir() is a Path
with linkr.connect("MIMIC-IV") as con:
    df = con.execute("SELECT * FROM person LIMIT 10").df()
```

| Purpose | R | Python |
|---|---|---|
| Project root | `linkr_project_dir()` | `linkr.project_dir()` |
| The `scripts/` sub-tree | `linkr_scripts_dir()` | `linkr.scripts_dir()` |
| Where datasets live | `linkr_datasets_dir()` | `linkr.datasets_dir()` |
| The IDE working dir | `linkr_ide_dir()` | `linkr.ide_dir()` |
| What this project may query | `linkr_databases()` | `linkr.databases()` |
| Open one, by name or id | `linkr_connect(name)` | `linkr.connect(name)` |

**Never derive one directory from another, and never hardcode an absolute path.** The
IDE working dir, the `scripts/` sub-tree and the datasets dir are bound *independently*
and can each be re-pointed to any server folder, so
`file.path(getwd(), "../datasets")` is correct only while the defaults happen to line
up — after which it silently reads the wrong folder. Nor is a database path yours to
write: `linkr_connect()` resolves it server-side against the acting user's own
permissions, so a hardcoded `.duckdb` path is both wrong on every other instance and a
way to reach something the user may not be entitled to.

Two things to get right in generated code:

- **Close what you open.** `linkr_connect()` caches nothing, deliberately — DuckDB
  refuses to open the same file twice in one process, and a shared handle surfaces later
  as a *Unique file handle conflict* that no restart fixes. Use `on.exit()` in R, a
  `with` block in Python.
- **`connect()` needs a session; the path helpers do not.** Outside a Linkr IDE run the
  paths fall back to the working directory with a warning, but anything reaching the
  server fails. A script meant to also run standalone should say so in a comment rather
  than appear broken.

The library's own dependencies (DBI, duckdb) are **not** on the load path. A script that
uses them must declare them in the project environment, exactly as it would any other
package — which is what keeps the exported project reproducible elsewhere.

## SQL

SQL is meaningful against a connected database, not a CSV dataset. A SQL script in a
project with no database connection is documentation, so say so in a comment rather than
leaving a query that cannot run.
