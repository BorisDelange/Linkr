/**
 * Reference for the `linkr` client libraries, shown in the IDE's documentation
 * dialog.
 *
 * Authored here rather than introspected from the installed package: the panel
 * has to work in a browser-only build, where there is no kernel to ask, and
 * before a project's environment has ever been built. The prose is kept in step
 * with the roxygen in `packages/linkr-r/R/` and the docstrings in
 * `packages/linkr-py/src/linkr/` — those remain the source of truth for the
 * behaviour; this is the same explanation, rendered where a script author is
 * already looking.
 */

export type DocLanguage = 'r' | 'python'

export interface DocSymbol {
  /** Stable across languages, so switching language keeps the reader in place. */
  id: string
  /** As it is written in this language, e.g. `linkr_connect` vs `connect`. */
  name: string
  signature: string
  summary: string
  /** Markdown; rendered with the app's shared MarkdownRenderer. */
  body: string
}

export interface DocPackage {
  id: string
  name: string
  summary: string
  /** Markdown shown when the package itself is selected, before any symbol. */
  overview: string
  symbols: DocSymbol[]
}

const R_PATH_BODY = `
A Linkr project has directories that are bound **independently** and can each be
re-pointed: the IDE working directory, the code sub-tree that gets exported, and
the datasets directory. Out of the box the first two are the same folder — which
is exactly why deriving one from another works until someone re-points a binding,
and then silently reads the wrong place.

> [!IMPORTANT]
> Do not derive one directory from another. \`file.path(getwd(), "../datasets")\`
> is correct only while the default bindings happen to line up.

The kernel exports each directory as an environment variable; these functions
read them, and nothing else.

## Outside Linkr

In a plain \`Rscript\` run on a laptop none of the variables are set. Rather than
guess, every accessor falls back to the working directory and warns once — so a
script runs in both places, but never quietly writes somewhere unintended.

## Value

An absolute path, as a character scalar.
`.trim()

const PY_PATH_BODY = `
A Linkr project has directories that are bound **independently** and can each be
re-pointed: the IDE working directory, the code sub-tree that gets exported, and
the datasets directory. Out of the box the first two are the same folder — which
is exactly why deriving one from another works until someone re-points a binding,
and then silently reads the wrong place.

> [!IMPORTANT]
> Do not derive one directory from another. \`os.getcwd() / "../datasets"\` is
> correct only while the default bindings happen to line up.

The kernel exports each directory as an environment variable; these functions
read them, and nothing else.

## Outside Linkr

In a plain \`python\` run on a laptop none of the variables are set. Rather than
guess, every accessor falls back to the working directory and warns once — so a
script runs in both places, but never quietly writes somewhere unintended.

## Returns

A \`pathlib.Path\`.
`.trim()

function pathSymbols(lang: DocLanguage): DocSymbol[] {
  const p = lang === 'r' ? 'linkr_' : ''
  const body = lang === 'r' ? R_PATH_BODY : PY_PATH_BODY
  const call = (n: string) => (lang === 'r' ? `${p}${n}()` : `linkr.${n}()`)
  return [
    {
      id: 'project_dir',
      name: `${p}project_dir`,
      signature: call('project_dir'),
      summary: 'The project root.',
      body: `The project's root directory, from \`LINKR_PROJECT\`.\n\n${body}`,
    },
    {
      id: 'scripts_dir',
      name: `${p}scripts_dir`,
      signature: call('scripts_dir'),
      summary: 'The code sub-tree that gets exported.',
      body: `The code sub-tree that gets exported with the project, from \`LINKR_SCRIPTS\`.\n\n${body}`,
    },
    {
      id: 'datasets_dir',
      name: `${p}datasets_dir`,
      signature: call('datasets_dir'),
      summary: 'Where datasets live.',
      body: `Where this project's datasets live, from \`LINKR_DATASETS\`. Write a produced CSV here for it to appear in the Datasets page.\n\n${body}`,
    },
    {
      id: 'ide_dir',
      name: `${p}ide_dir`,
      signature: call('ide_dir'),
      summary: 'The IDE working directory.',
      body: `The IDE working directory — a kernel starts with this as its \`cwd\` — from \`LINKR_IDE\`.\n\n${body}`,
    },
  ]
}

const R_PACKAGE: DocPackage = {
  id: 'linkr',
  name: 'linkr',
  summary: 'Reach the current Linkr project from a script running in its IDE.',
  overview: `
Reach the current Linkr project from a script running in its IDE: the folders it
may read and write, and the databases it is allowed to query.

\`\`\`r
library(linkr)
library(DBI)

linkr_project_dir(); linkr_scripts_dir(); linkr_datasets_dir()
linkr_databases()

con <- linkr_connect("mimic_iv")
dbGetQuery(con, "SELECT * FROM person LIMIT 10")
dbDisconnect(con, shutdown = TRUE)
\`\`\`

> [!NOTE]
> \`library(linkr)\` works even in a project whose environment has never been
> built. Its dependencies (DBI, duckdb) are **not** put on the library path, so a
> script still has to declare those itself — which is what keeps an exported
> project reproducible somewhere else.

The Python equivalent is \`linkr.connect()\`, \`linkr.databases()\`, and so on:
the same model, each language's own naming convention.
`.trim(),
  symbols: [
    ...pathSymbols('r'),
    {
      id: 'databases',
      name: 'linkr_databases',
      signature: 'linkr_databases()',
      summary: 'The databases this project can query.',
      body: `
Lists what the acting user may read — the same set the Databases page shows,
resolved server-side, so a script never hardcodes a path.

The \`dialect\` column, **not** \`engine\`, says which SQL to write: PostgreSQL and
MySQL are reached by attaching them into DuckDB exactly as the app's own SQL
editor does, so a query moves between the IDE and the app unchanged.

## Value

A data frame with columns \`alias\`, \`name\`, \`engine\`, \`dialect\`, \`kind\` and
\`connectable\`. \`connectable\` is \`FALSE\` for a source whose file was never
uploaded: it is listed, but \`linkr_connect()\` on it will fail.

\`alias\` is the column to copy into \`linkr_connect()\`: it is the stable slug (the
one the SQL editor uses as \`ds_<alias>\`), so a script keeps working when the
database is renamed. \`name\` is there to read, not to address.

## Requires a session

The path helpers work anywhere, but this one needs the server. Outside a Linkr
IDE session it fails with a message saying so.
`.trim(),
    },
    {
      id: 'connect',
      name: 'linkr_connect',
      signature: 'linkr_connect(alias, read_only = TRUE)',
      summary: 'Open one of this project’s databases.',
      body: `
Returns a real DBI connection, so everything built on DBI works: \`dbGetQuery\`,
\`dbListTables\`, \`dplyr::tbl()\` and the rest.

## Arguments

- **\`alias\`** — the database’s alias, as listed by \`linkr_databases()\`.
  The stable slug, not the display name: a rename must not break a script.
- **\`read_only\`** — passed through for file-backed sources. External databases
  are always attached read-only: a script must not write to a source.

## The connection is always DuckDB

A managed or uploaded file is opened directly; a Parquet source is registered as
one view per table; PostgreSQL and MySQL are ATTACHed read-only, which is how the
app itself reaches them. So the SQL is DuckDB's in every case, a query moves
between the IDE and the app's SQL editor unchanged, and a live table can be joined
against a local Parquet file in one statement.

> [!WARNING]
> Nothing is cached between calls, and you should not cache it either. DuckDB
> refuses to open the same file twice in one process, so a hidden shared
> connection surfaces later as a *Unique file handle conflict* that no restart
> fixes.

## Value

A \`DBIConnection\`. Close it with \`DBI::dbDisconnect()\`.

\`\`\`r
con <- linkr_connect("mimic_iv")
on.exit(DBI::dbDisconnect(con, shutdown = TRUE))
\`\`\`
`.trim(),
    },
  ],
}

const PY_PACKAGE: DocPackage = {
  id: 'linkr',
  name: 'linkr',
  summary: 'Reach the current Linkr project from a script running in its IDE.',
  overview: `
Reach the current Linkr project from a script running in its IDE: the folders it
may read and write, and the databases it is allowed to query.

\`\`\`python
import linkr

linkr.project_dir(); linkr.scripts_dir(); linkr.datasets_dir()
linkr.databases()

with linkr.connect("mimic_iv") as con:
    df = con.execute("SELECT * FROM person LIMIT 10").df()
\`\`\`

The R equivalent is \`linkr_connect()\`, \`linkr_databases()\`, and so on: the same
model, each language's own naming convention.
`.trim(),
  symbols: [
    ...pathSymbols('python'),
    {
      id: 'databases',
      name: 'databases',
      signature: 'linkr.databases()',
      summary: 'The databases this project can query.',
      body: `
Lists what the acting user may read — the same set the Databases page shows,
resolved server-side, so a script never hardcodes a path.

The \`dialect\` field, **not** \`engine\`, says which SQL to write: PostgreSQL and
MySQL are reached by attaching them into DuckDB exactly as the app's own SQL
editor does, so a query moves between the IDE and the app unchanged.

## Returns

A list of dicts with keys \`alias\`, \`name\`, \`id\`, \`engine\`, \`dialect\`, \`kind\`
and \`connectable\`. A source whose file was never uploaded is listed with
\`connectable\` \`False\`: visible, but \`connect()\` on it will fail.

\`alias\` is the key to copy into \`connect()\`: it is the stable slug (the one the
SQL editor uses as \`ds_<alias>\`), so a script keeps working when the database is
renamed. \`name\` is there to read, not to address.

## Requires a session

The path helpers work anywhere, but this one needs the server. Outside a Linkr
IDE session it raises \`LinkrError\` with a message saying so.
`.trim(),
    },
    {
      id: 'connect',
      name: 'connect',
      signature: 'linkr.connect(alias, read_only=True)',
      summary: 'Open one of this project’s databases.',
      body: `
Returns a real DuckDB connection — a DBAPI handle — so \`.execute()\`, \`.df()\`,
pandas' \`read_sql\` and anything else built on it work.

## Parameters

- **\`alias\`** — the database’s alias, as listed by \`linkr.databases()\`.
  The stable slug, not the display name: a rename must not break a script.
- **\`read_only\`** — passed through for file-backed sources. External databases
  are always attached read-only: a script must not write to a source.

## The connection is always DuckDB

A managed or uploaded file is opened directly; a Parquet source is registered as
one view per table; PostgreSQL and MySQL are ATTACHed read-only, which is how the
app itself reaches them. So the SQL is DuckDB's in every case, a query moves
between the IDE and the app's SQL editor unchanged, and a live table can be joined
against a local Parquet file in one statement.

> [!WARNING]
> Nothing is cached between calls, and you should not cache it either. DuckDB
> refuses to open the same file twice in one process, so a hidden shared
> connection surfaces later as a *Unique file handle conflict* that no restart
> fixes.

## Closing it

Close what you open, or use the connection as a context manager:

\`\`\`python
with linkr.connect("mimic_iv") as con:
    df = con.execute("SELECT * FROM person LIMIT 10").df()
\`\`\`
`.trim(),
    },
    {
      id: 'LinkrError',
      name: 'LinkrError',
      signature: 'linkr.LinkrError',
      summary: 'Raised when the project or its databases cannot be reached.',
      body: `
The exception every \`linkr\` call raises on failure: an unknown database name, a
source with nothing uploaded, an expired session token, or a server that refused
the request.

\`\`\`python
try:
    con = linkr.connect("MIMIC-IV")
except linkr.LinkrError as exc:
    print(f"could not open the database: {exc}")
\`\`\`

It carries the server's explanation as its message, so printing it is usually
enough to see what went wrong.
`.trim(),
    },
  ],
}

/** The packages documented for a language. Today only `linkr`; the installed
 *  packages of a project's environment are a separate, server-only source. */
export function docPackages(lang: DocLanguage): DocPackage[] {
  return [lang === 'r' ? R_PACKAGE : PY_PACKAGE]
}
