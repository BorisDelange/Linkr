#' Where this project's files live
#'
#' A Linkr project has three server directories that are bound independently and
#' can each be re-pointed: the IDE working dir, the code sub-tree that gets
#' exported, and the datasets dir. Out of the box the first two are the same
#' folder, which is exactly why deriving one from another (`"../datasets"`,
#' `getwd()`) works until someone re-points a binding and then silently reads the
#' wrong place. The kernel exports all four as environment variables; these
#' functions read them, and nothing else.
#'
#' Outside a Linkr session — a plain `Rscript` on a laptop — none of the
#' variables are set. Rather than guess, every accessor falls back to the working
#' directory and warns once, so a script runs in both places but never quietly
#' writes somewhere unintended.
#'
#' @return An absolute path, as a character scalar.
#' @name linkr_paths
NULL

.linkr_warned <- new.env(parent = emptyenv())

.linkr_env_path <- function(var) {
  value <- Sys.getenv(var, unset = "")
  if (nzchar(value)) return(value)
  if (is.null(.linkr_warned[[var]])) {
    .linkr_warned[[var]] <- TRUE
    warning(
      sprintf(
        "%s is not set: not running inside a Linkr IDE session. Falling back to the working directory (%s).",
        var, getwd()
      ),
      call. = FALSE
    )
  }
  getwd()
}

#' @rdname linkr_paths
#' @export
linkr_project_dir <- function() .linkr_env_path("LINKR_PROJECT")

#' @rdname linkr_paths
#' @export
linkr_scripts_dir <- function() .linkr_env_path("LINKR_SCRIPTS")

#' @rdname linkr_paths
#' @export
linkr_datasets_dir <- function() .linkr_env_path("LINKR_DATASETS")

#' @rdname linkr_paths
#' @export
linkr_ide_dir <- function() .linkr_env_path("LINKR_IDE")
