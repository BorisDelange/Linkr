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
  linkr_installs <- nzchar(lib) && dir.exists(lib)
  ns <- tryCatch(
    if (linkr_installs) loadNamespace(package, lib.loc = c(lib, .libPaths())) else loadNamespace(package),
    packageNotFoundError = function(e) stop(.linkr_missing_dep(package, linkr_installs), call. = FALSE)
  )
  .linkr_ns[[package]] <- ns
  ns
}

.linkr_dbi <- function(name) get(name, envir = .linkr_dep("DBI"))

#' Why a dependency of this package is missing, and what to do about it
#'
#' On a Linkr server, the server installs these dependencies itself, in the
#' background, the first time an R session starts: on an R that builds packages
#' from source, duckdb compiles for a long while, and a script calling
#' `linkr_connect()` meanwhile is told to wait rather than to install anything.
#'
#' @noRd
.linkr_missing_dep <- function(package, linkr_installs) {
  if (linkr_installs) {
    sprintf(paste(
      "library(linkr) needs the R package %s, which Linkr is still installing on this server",
      "(the job \"Install the R packages of library(linkr)\" in the jobs panel).",
      "Try again once it is done."
    ), package)
  } else {
    sprintf("library(linkr) needs the R package %s: install.packages(\"%s\")", package, package)
  }
}
