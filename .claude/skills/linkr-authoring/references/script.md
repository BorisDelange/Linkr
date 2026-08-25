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

- **load data from the datasets**, do not re-invent it inline;
- prefer the standard library and the packages the project declares — an import that is
  not installed fails at run time, and nothing in the tree declares dependencies for you;
- reference dataset columns by their **id** (`col_age`): the physical column key is the
  id, on the client and the server alike;
- keep a script runnable end to end. A demo script that errors halfway is worse than a
  shorter one that finishes.

Number them (`01_extract.sql`, `02_build.py`) when order matters — it is the only cue a
reader gets.

## SQL

SQL is meaningful against a connected database, not a CSV dataset. A SQL script in a
project with no database connection is documentation, so say so in a comment rather than
leaving a query that cannot run.
