#' Open one of this project's databases
#'
#' Returns a real DBI connection, so everything built on DBI works:
#' `dbGetQuery`, `dbListTables`, `dplyr::tbl()` and the rest.
#'
#' The connection is always DuckDB. A managed or uploaded file is opened
#' directly; a Parquet source is registered as one view per table; PostgreSQL
#' and MySQL are ATTACHed read-only, which is how the app itself reaches them —
#' so the SQL is DuckDB's in every case, a query moves between the IDE and the
#' app's SQL editor unchanged, and a live table can be joined against a local
#' Parquet file in one statement.
#'
#' Nothing is cached between calls. DuckDB refuses to open the same file twice
#' in one process, so a hidden shared connection would surface later as a
#' "Unique file handle conflict" that no restart fixes.
#'
#' @param name Database name or id, as listed by [linkr_databases()].
#' @param read_only Passed through for file-backed sources. External databases
#'   are always attached read-only: a script must not write to a source.
#' @return A `DBIConnection`. Close it with [DBI::dbDisconnect()].
#' @export
linkr_connect <- function(name, read_only = TRUE) {
  if (!is.character(name) || length(name) != 1 || !nzchar(name)) {
    stop("`name` must be a single database name or id.", call. = FALSE)
  }
  db <- .linkr_find_database(.linkr_api_call("/databases"), name)
  if (!isTRUE(db$connectable)) {
    stop(
      "Database '", db$name, "' cannot be opened: no data has been uploaded ",
      "or built for it yet.", call. = FALSE
    )
  }
  dialect <- if (is.null(db$dialect)) "duckdb" else db$dialect
  if (!identical(dialect, "duckdb")) {
    stop(
      "Database '", db$name, "' speaks the '", dialect, "' dialect, which ",
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

.linkr_use_server_extensions <- function(con) {
  # Read DuckDB extensions from the server's directory rather than downloading
  # them per session — which would also fail outright on an air-gapped instance.
  ext_dir <- Sys.getenv("LINKR_DUCKDB_EXTENSIONS", unset = "")
  if (nzchar(ext_dir)) {
    DBI::dbExecute(con, sprintf(
      "SET extension_directory = %s",
      DBI::dbQuoteString(con, ext_dir)
    ))
  }
}

.linkr_open_file <- function(path, read_only) {
  DBI::dbConnect(duckdb::duckdb(), dbdir = path, read_only = read_only)
}

.linkr_open_parquet <- function(tables) {
  con <- DBI::dbConnect(duckdb::duckdb())
  ok <- FALSE
  on.exit(if (!ok) DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  for (entry in tables) {
    paths <- vapply(entry$paths, as.character, character(1))
    quoted <- vapply(
      paths, function(p) as.character(DBI::dbQuoteString(con, p)), character(1)
    )
    DBI::dbExecute(con, sprintf(
      "CREATE OR REPLACE VIEW %s AS SELECT * FROM read_parquet([%s])",
      DBI::dbQuoteIdentifier(con, entry$table),
      paste(quoted, collapse = ", ")
    ))
  }
  ok <- TRUE
  con
}

.linkr_open_external <- function(db) {
  con <- DBI::dbConnect(duckdb::duckdb())
  ok <- FALSE
  on.exit(if (!ok) DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  .linkr_use_server_extensions(con)
  DBI::dbExecute(con, sprintf("INSTALL %s", db$attachType))
  DBI::dbExecute(con, sprintf("LOAD %s", db$attachType))
  DBI::dbExecute(con, sprintf(
    "ATTACH %s AS ext (TYPE %s, READ_ONLY)",
    DBI::dbQuoteString(con, db$attachDsn), db$attachType
  ))
  # The source's schema goes on the search path so bare table names resolve the
  # way they do in the app's SQL editor.
  DBI::dbExecute(con, sprintf(
    "SET search_path = 'memory,ext.%s'", db$attachScope
  ))
  ok <- TRUE
  con
}
