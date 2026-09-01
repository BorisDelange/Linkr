.linkr_api_call <- function(path) {
  base <- Sys.getenv("LINKR_API_URL", unset = "")
  token <- Sys.getenv("LINKR_TOKEN", unset = "")
  project <- Sys.getenv("LINKR_PROJECT_UID", unset = "")
  if (!nzchar(base) || !nzchar(token) || !nzchar(project)) {
    stop(
      "Cannot reach the Linkr server: LINKR_API_URL, LINKR_TOKEN and ",
      "LINKR_PROJECT_UID are only set inside a Linkr IDE session (console, ",
      "terminal or job). The path helpers work anywhere, but databases do not.",
      call. = FALSE
    )
  }
  url <- sprintf(
    "%s/api/v1/projects/%s/client%s", sub("/$", "", base), project, path
  )
  # curl rather than an R HTTP package: this must work in an empty project
  # environment, where nothing beyond this package's own dependencies is
  # installed. The token goes in via a config file rather than argv, which every
  # other user on the machine can read out of `ps`.
  out <- tempfile(fileext = ".json")
  conf <- tempfile(fileext = ".conf")
  on.exit(unlink(c(out, conf)), add = TRUE)
  cat(sprintf('header = "Authorization: Bearer %s"\n', token), file = conf)
  Sys.chmod(conf, "0600")
  status <- suppressWarnings(system2(
    "curl",
    c("-sS", "--config", shQuote(conf), "-o", shQuote(out),
      "-w", "%{http_code}", shQuote(url)),
    stdout = TRUE, stderr = TRUE
  ))
  code <- suppressWarnings(as.integer(utils::tail(status, 1)))
  if (is.na(code)) {
    stop(
      "Could not reach the Linkr server: ", paste(status, collapse = " "),
      call. = FALSE
    )
  }
  if (code == 401 || code == 403) {
    stop(
      "The Linkr server refused this request (HTTP ", code, "). Your session ",
      "token may have expired — restart the console or terminal.",
      call. = FALSE
    )
  }
  if (code >= 400) {
    stop("The Linkr server returned HTTP ", code, ".", call. = FALSE)
  }
  get("fromJSON", envir = .linkr_dep("jsonlite"))(out, simplifyVector = FALSE)
}

#' The databases this project can query
#'
#' Lists what the acting user may read — the same set the Databases page
#' shows, resolved server-side, so a script never hardcodes a path.
#'
#' The `dialect` column, not `engine`, says which SQL to write: PostgreSQL and
#' MySQL are reached by attaching them into DuckDB exactly as the app's own SQL
#' editor does, so a query moves between the IDE and the app unchanged.
#'
#' `alias` is the column to copy into [linkr_connect()]: it is the stable slug
#' (the one the SQL editor uses as `ds_<alias>`), so a script keeps working when
#' the database is renamed. `name` is there to read, not to address.
#'
#' @return A data frame with columns `alias`, `name`, `engine`, `dialect`,
#'   `kind` and `connectable`. `connectable` is FALSE for a source whose file
#'   was never uploaded: it is listed, but `linkr_connect()` on it will fail.
#' @export
linkr_databases <- function() {
  rows <- .linkr_api_call("/databases")
  if (length(rows) == 0) {
    return(data.frame(
      alias = character(0), name = character(0), engine = character(0),
      dialect = character(0), kind = character(0), connectable = logical(0),
      stringsAsFactors = FALSE
    ))
  }
  field <- function(name, default = NA_character_) {
    vapply(
      rows,
      function(r) {
        if (is.null(r[[name]])) default else as.character(r[[name]])
      },
      character(1)
    )
  }
  data.frame(
    # `alias` first: linkr_connect() takes it, so it is the column to copy.
    alias = field("alias"),
    name = field("name"),
    engine = field("engine"),
    dialect = field("dialect"),
    kind = field("kind"),
    connectable = vapply(rows, function(r) isTRUE(r$connectable), logical(1)),
    stringsAsFactors = FALSE
  )
}

# Matches on the alias ALONE, never the display name or the uuid. A script keyed
# on a display name breaks the day someone renames the database (and a name can
# be localized, so there is no single "the" name), while a uuid is unreadable in
# the code that has to be reviewed. The alias is the slug the SQL editor uses.
#
# Nothing enforces alias uniqueness today, so a duplicate is reported rather
# than resolved to whichever row came first — picking one at random is how a
# script quietly reads the wrong database.
.linkr_find_database <- function(rows, alias) {
  # NA rather than a length-0 vapply failure for a row without an alias: an
  # older server that predates the field must produce "no database with that
  # alias", not "values must be length 1".
  aliases <- vapply(
    rows,
    function(r) if (is.null(r$alias)) NA_character_ else as.character(r$alias),
    character(1)
  )
  hit <- which(aliases == alias)
  if (length(hit) == 1) return(rows[[hit]])
  if (length(hit) > 1) {
    ids <- vapply(rows[hit], function(r) as.character(r$id), character(1))
    stop(
      "Several databases share the alias '", alias, "' (",
      paste(ids, collapse = ", "), "). Rename one in the Databases page so a ",
      "script can address them unambiguously.", call. = FALSE
    )
  }
  stop(
    "No database with alias '", alias, "' in this project. Available: ",
    if (length(aliases)) paste(aliases, collapse = ", ") else "(none)",
    call. = FALSE
  )
}
