.linkr_ns <- new.env(parent = emptyenv())

#' Resolve one of this package's own dependencies
#'
#' DBI, duckdb and jsonlite live in a library that is deliberately NOT on the
#' kernel's `.libPaths()`. Were they on it, a script could `library(duckdb)`
#' without declaring it in the project environment, and would then break
#' wherever that environment is all there is — which is the point of the
#' isolation.
#'
#' `loadNamespace(lib.loc=)` reaches them for this package's use only, leaving
#' `.libPaths()` — and what user code can load — untouched. When not deployed
#' that way (a developer checkout, a project that declares duckdb itself), the
#' normal search path already answers.
#'
#' @noRd
.linkr_dep <- function(package) {
  cached <- .linkr_ns[[package]]
  if (!is.null(cached)) return(cached)
  lib <- Sys.getenv("LINKR_CLIENT_R_LIB", unset = "")
  ns <- if (nzchar(lib) && dir.exists(lib)) {
    loadNamespace(package, lib.loc = c(lib, .libPaths()))
  } else {
    loadNamespace(package)
  }
  .linkr_ns[[package]] <- ns
  ns
}

.linkr_dbi <- function(name) get(name, envir = .linkr_dep("DBI"))
