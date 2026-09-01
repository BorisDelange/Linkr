#' Open one of this project's databases
#'
#' Returns a real DBI connection, so everything built on DBI works:
#' `dbGetQuery`, `dbListTables`, `dplyr::tbl()` and the rest.
#'
#' The connection is always DuckDB. A managed or uploaded file is opened
#' directly; a Parquet source is registered as one view per table; PostgreSQL
#' and MySQL are ATTACHed read-only, which is how the app itself reaches
#' them — so the SQL is DuckDB's in every case, a query moves between the IDE
#' and the app's SQL editor unchanged, and a live table can be joined against a
#' local Parquet file in one statement.
#'
#' Nothing is cached between calls. DuckDB refuses to open the same file twice
#' in one process, so a hidden shared connection would surface later as a
#' "Unique file handle conflict" that no restart fixes.
#'
#' @param alias The database's alias, as listed by [linkr_databases()] — the
#'   stable slug, not the display name: renaming a database must not break a
#'   script, and a display name can differ per language.
#' @param read_only Passed through for file-backed sources. External databases
#'   are always attached read-only: a script must not write to a source.
#' @return A `DBIConnection`. Close it with `DBI::dbDisconnect()`.
#' @export
linkr_connect <- function(alias, read_only = TRUE) {
  if (!is.character(alias) || length(alias) != 1 || !nzchar(alias)) {
    stop("`alias` must be a single database alias.", call. = FALSE)
  }
  db <- .linkr_find_database(.linkr_api_call("/databases"), alias)
  if (!isTRUE(db$connectable)) {
    stop(
      "Database '", db$alias, "' cannot be opened: no data has been uploaded ",
      "or built for it yet.", call. = FALSE
    )
  }
  dialect <- if (is.null(db$dialect)) "duckdb" else db$dialect
  if (!identical(dialect, "duckdb")) {
    stop(
      "Database '", db$alias, "' speaks the '", dialect, "' dialect, which ",
      "this version of the linkr package cannot open.", call. = FALSE
    )
  }

  switch(
    db$kind,
    managed = .linkr_open_file(db$path, read_only),
    file = .linkr_open_file(db$path, read_only),
    `parquet-folder` = .linkr_open_parquet(db$tables),
    external = .linkr_open_external(db),
    stop("Unsupported database kind: ", db$kind, call. = FALSE)
  )
}

.linkr_duckdb_driver <- function() {
  get("duckdb", envir = .linkr_dep("duckdb"))()
}

.linkr_exec <- function(con, sql) .linkr_dbi("dbExecute")(con, sql)

.linkr_quote <- function(con, value) {
  as.character(.linkr_dbi("dbQuoteString")(con, as.character(value)))
}

.linkr_open_file <- function(path, read_only) {
  .linkr_dbi("dbConnect")(
    .linkr_duckdb_driver(), dbdir = path, read_only = read_only
  )
}

.linkr_use_server_extensions <- function(con) {
  # Read DuckDB extensions from the server's directory rather than downloading
  # them per session — which would also fail outright on an air-gapped server.
  ext_dir <- Sys.getenv("LINKR_DUCKDB_EXTENSIONS", unset = "")
  if (nzchar(ext_dir)) {
    .linkr_exec(con, sprintf(
      "SET extension_directory = %s", .linkr_quote(con, ext_dir)
    ))
  }
}

.linkr_open_parquet <- function(tables) {
  con <- .linkr_dbi("dbConnect")(.linkr_duckdb_driver())
  ok <- FALSE
  on.exit(
    if (!ok) .linkr_dbi("dbDisconnect")(con, shutdown = TRUE), add = TRUE
  )
  for (entry in tables) {
    quoted <- vapply(
      entry$paths, function(p) .linkr_quote(con, p), character(1)
    )
    .linkr_exec(con, sprintf(
      "CREATE OR REPLACE VIEW %s AS SELECT * FROM read_parquet([%s])",
      .linkr_dbi("dbQuoteIdentifier")(con, entry$table),
      paste(quoted, collapse = ", ")
    ))
  }
  ok <- TRUE
  con
}

.linkr_open_external <- function(db) {
  con <- .linkr_dbi("dbConnect")(.linkr_duckdb_driver())
  ok <- FALSE
  on.exit(
    if (!ok) .linkr_dbi("dbDisconnect")(con, shutdown = TRUE), add = TRUE
  )
  .linkr_use_server_extensions(con)
  .linkr_exec(con, sprintf("INSTALL %s", db$attachType))
  .linkr_exec(con, sprintf("LOAD %s", db$attachType))
  .linkr_exec(con, sprintf(
    "ATTACH %s AS ext (TYPE %s, READ_ONLY)",
    .linkr_quote(con, db$attachDsn), db$attachType
  ))
  # The source's schema goes on the search path so bare table names resolve the
  # way they do in the app's SQL editor.
  .linkr_exec(con, sprintf(
    "SET search_path = 'memory,ext.%s'", db$attachScope
  ))
  ok <- TRUE
  con
}
